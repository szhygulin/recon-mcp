import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRON_TOKENS } from "../src/config/tron.js";
import { base58ToHex, encodeTrc20TransferParam } from "../src/modules/tron/address.js";
import {
  buildTronNativeSend,
  buildTronTokenSend,
  buildTronClaimRewards,
  buildTronFreeze,
  buildTronUnfreeze,
  buildTronWithdrawExpireUnfreeze,
  buildTronVote,
} from "../src/modules/tron/actions.js";
import { listTronWitnesses } from "../src/modules/tron/witnesses.js";
import { hasTronHandle, consumeTronHandle } from "../src/signing/tron-tx-store.js";
import {
  encodeTransferRawData,
  encodeTriggerSmartContractRawData,
  encodeOwnerOnlyRawData,
  encodeFreezeV2RawData,
  encodeUnfreezeV2RawData,
  encodeVoteWitnessRawData,
} from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";

/**
 * Consolidated TRON builder tests (formerly phase2-prepare + phase2b-stake-writes
 * + phase2c-voting). Network IO against TronGrid is stubbed via
 * `vi.stubGlobal("fetch", ...)`; each describe manages its own fetch setup.
 * Coverage:
 *   - base58check decode + TRC-20 ABI param encoding (pure crypto, no network)
 *   - native send / TRC-20 token send / claim-rewards builders
 *   - Stake 2.0 freeze / unfreeze / withdraw-expire-unfreeze
 *   - SR listing + multi-SR vote builder
 *   - For each: POST body shape, handle issuance, error surfacing, validation
 */

const ADDR_USDT = TRON_TOKENS.USDT; // "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
const ADDR_FROM = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"; // well-known large TRX holder
const ADDR_TO = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9"; // another well-known address

// Stake 2.0 + voting share these.
const ADDR = ADDR_FROM;
const OWNER = ADDR_FROM;
const SR1 = ADDR_TO;
const SR2 = ADDR_USDT;
const SR3 = "TWGEPPwSxGNwQBefExdbVybgrsNuF47yYJ";

/**
 * Helper: build a synthetic TronGrid /wallet/* "broadcast-ready" response
 * with the given raw_data_hex. Used by the freeze/unfreeze/withdraw paths.
 */
function directTxResponse(rawDataHex: string, txID = "ab".repeat(32)): Response {
  return new Response(
    JSON.stringify({
      txID,
      raw_data: { expiration: 0 },
      raw_data_hex: rawDataHex,
      visible: true,
    }),
    { status: 200 }
  );
}

/**
 * Helper: build a synthetic /wallet/listwitnesses response with 30 SRs of
 * decreasing vote weight. Used by the SR listing tests.
 */
function fakeWitnessList(): {
  witnesses: Array<{
    address: string;
    voteCount: number;
    url?: string;
    totalProduced?: number;
    totalMissed?: number;
  }>;
} {
  const top = [
    { address: SR1, voteCount: 5_000_000_000, url: "https://sr1.example", totalProduced: 1000, totalMissed: 1 },
    { address: SR2, voteCount: 3_000_000_000, url: "https://sr2.example", totalProduced: 800 },
    { address: SR3, voteCount: 1_000_000_000 },
  ];
  const tail = Array.from({ length: 27 }, (_, i) => ({
    address: SR1,
    voteCount: 1_000_000 - i,
  }));
  return { witnesses: [...top, ...tail] };
}

describe("base58ToHex", () => {
  it("decodes the USDT-TRC20 contract to its canonical 21-byte TRON hex form (prefix 0x41)", () => {
    // Known constant: USDT-TRC20 → 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
    const hex = base58ToHex(ADDR_USDT);
    expect(hex).toBe("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(hex.length).toBe(42);
    expect(hex.slice(0, 2)).toBe("41"); // TRON mainnet version byte
  });

  it("rejects a non-TRON string", () => {
    expect(() => base58ToHex("0xdeadbeef")).toThrow(/TRON mainnet address/);
  });

  it("rejects a base58 string with a flipped checksum (tampering detection)", () => {
    // Flip the last character — breaks the base58check suffix.
    const tampered = ADDR_USDT.slice(0, -1) + (ADDR_USDT.endsWith("t") ? "u" : "t");
    expect(() => base58ToHex(tampered)).toThrow(/Checksum mismatch|TRON mainnet address/);
  });
});

describe("encodeTrc20TransferParam", () => {
  it("produces 128 hex chars (two 32-byte ABI words) with the 20-byte address form", () => {
    const param = encodeTrc20TransferParam(ADDR_TO, 1_000_000n); // 1 USDT in base units
    expect(param.length).toBe(128);
    // First word: 12 bytes zero-pad + 20-byte address (stripped of the 0x41 prefix).
    const addrWord = param.slice(0, 64);
    expect(addrWord.slice(0, 24)).toBe("0".repeat(24));
    const hex21 = base58ToHex(ADDR_TO); // prefix+20 bytes
    expect(addrWord.slice(24)).toBe(hex21.slice(2)); // drop the 0x41 prefix
    // Second word: amount as big-endian uint256.
    expect(param.slice(64)).toBe((1_000_000n).toString(16).padStart(64, "0"));
  });

  it("encodes a zero-amount transfer (no revert at encoding layer)", () => {
    const param = encodeTrc20TransferParam(ADDR_TO, 0n);
    expect(param.slice(64)).toBe("0".repeat(64));
  });

  it("rejects a negative amount", () => {
    expect(() => encodeTrc20TransferParam(ADDR_TO, -1n)).toThrow(/non-negative/);
  });
});

describe("buildTronNativeSend (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/createtransaction");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR_FROM);
      expect(body.to_address).toBe(ADDR_TO);
      expect(body.amount).toBe(1_500_000); // 1.5 TRX = 1_500_000 SUN
      expect(body.visible).toBe(true);
      return new Response(
        JSON.stringify({
          txID: "deadbeef".repeat(8),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeTransferRawData({
            from: ADDR_FROM,
            to: ADDR_TO,
            amountSun: 1_500_000n,
          }),
          visible: true,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns an UnsignedTronTx with a live handle and correct decoded preview", async () => {
    const tx = await buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1.5" });
    expect(tx.chain).toBe("tron");
    expect(tx.action).toBe("native_send");
    expect(tx.from).toBe(ADDR_FROM);
    // txID is recomputed after the issue-#280 expiration extension
    // (sha256 of the rewritten raw_data_hex) — assert canonical shape
    // rather than the original sentinel from the mocked TronGrid response.
    expect(tx.txID).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.description).toBe(`Send 1.5 TRX to ${ADDR_TO}`);
    expect(tx.decoded.functionName).toBe("TransferContract");
    expect(tx.decoded.args).toEqual({ to: ADDR_TO, amount: "1.5", symbol: "TRX" });
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
    // Consumed tx must not carry the handle (tx-store strips it on store).
    const consumed = consumeTronHandle(tx.handle!);
    expect(consumed.handle).toBeUndefined();
    expect(consumed.txID).toBe(tx.txID);
  });

  it("rejects non-TRON from/to", async () => {
    await expect(
      buildTronNativeSend({ from: "0xbad", to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/"from" is not a valid TRON/);
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: "notbase58", amount: "1" })
    ).rejects.toThrow(/"to" is not a valid TRON/);
  });

  it("rejects zero or invalid amounts", async () => {
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "0" })
    ).rejects.toThrow(/greater than 0/);
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "-1" })
    ).rejects.toThrow(/Invalid amount/);
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1.1234567" }) // > 6 dp
    ).rejects.toThrow(/more decimals than token precision/);
  });

  it("surfaces TronGrid's top-level `Error` field verbatim", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ Error: "validate transfer contract error, no OwnerAccount" }), {
          status: 200,
        })
    );
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1.5" })
    ).rejects.toThrow(/no OwnerAccount/);
  });
});

describe("buildTronTokenSend (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      // Energy pre-flight dry-run hits triggerconstantcontract first.
      if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
        return new Response(
          JSON.stringify({
            result: { result: true },
            energy_used: 14650, // USDT transfer ≈ 14.65k energy (≈6.15 TRX at 420 sun/energy)
            constant_result: [""],
          }),
          { status: 200 }
        );
      }
      expect(url).toBe("https://api.trongrid.io/wallet/triggersmartcontract");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR_FROM);
      expect(body.contract_address).toBe(ADDR_USDT);
      expect(body.function_selector).toBe("transfer(address,uint256)");
      expect(body.visible).toBe(true);
      expect(body.call_value).toBe(0);
      expect(body.fee_limit).toBe(100_000_000); // default 100 TRX
      // parameter = addrWord + amountWord, 2 USDT = 2_000_000 base units
      expect(body.parameter.slice(64)).toBe((2_000_000n).toString(16).padStart(64, "0"));
      return new Response(
        JSON.stringify({
          result: { result: true },
          transaction: {
            txID: "cafebabe".repeat(8),
            raw_data: { expiration: 0 },
            raw_data_hex: encodeTriggerSmartContractRawData({
              from: ADDR_FROM,
              contract: ADDR_USDT,
              dataHex: "a9059cbb" + body.parameter,
              feeLimitSun: BigInt(body.fee_limit),
            }),
            visible: true,
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a USDT transfer with the canonical 6-decimal amount and default fee limit", async () => {
    const tx = await buildTronTokenSend({
      from: ADDR_FROM,
      to: ADDR_TO,
      token: ADDR_USDT,
      amount: "2",
    });
    expect(tx.action).toBe("trc20_send");
    expect(tx.txID).toMatch(/^[0-9a-f]{64}$/); // recomputed post #280 extension
    expect(tx.description).toBe(`Send 2 USDT to ${ADDR_TO}`);
    expect(tx.decoded.args.symbol).toBe("USDT");
    expect(tx.decoded.args.contract).toBe(ADDR_USDT);
    expect(tx.feeLimitSun).toBe("100000000");
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("honours an explicit feeLimitTrx override", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
        return new Response(
          JSON.stringify({ result: { result: true }, energy_used: 14650, constant_result: [""] }),
          { status: 200 }
        );
      }
      const body = JSON.parse(init!.body as string);
      expect(body.fee_limit).toBe(50_000_000); // 50 TRX override
      return new Response(
        JSON.stringify({
          result: { result: true },
          transaction: {
            txID: "f".repeat(64),
            raw_data: {},
            raw_data_hex: encodeTriggerSmartContractRawData({
              from: ADDR_FROM,
              contract: ADDR_USDT,
              dataHex: "a9059cbb" + body.parameter,
              feeLimitSun: BigInt(body.fee_limit),
            }),
            visible: true,
          },
        }),
        { status: 200 }
      );
    });
    const tx = await buildTronTokenSend({
      from: ADDR_FROM,
      to: ADDR_TO,
      token: ADDR_USDT,
      amount: "1",
      feeLimitTrx: "50",
    });
    expect(tx.feeLimitSun).toBe("50000000");
  });

  it("rejects non-canonical TRC-20 tokens", async () => {
    // Pick any valid base58 T-address that isn't in TRON_TOKENS.
    const unknown = ADDR_FROM; // not a contract in the canonical set
    await expect(
      buildTronTokenSend({ from: ADDR_FROM, to: ADDR_TO, token: unknown, amount: "1" })
    ).rejects.toThrow(/not in the canonical TRC-20 set/);
  });

  it("surfaces TronGrid triggersmartcontract failure from result.message", async () => {
    // Override the shared mock: pre-flight passes, but the subsequent
    // triggersmartcontract build rejects.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
        return new Response(
          JSON.stringify({ result: { result: true }, energy_used: 14650, constant_result: [""] }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          result: { result: false, code: "CONTRACT_VALIDATE_ERROR", message: "insufficient balance" },
        }),
        { status: 200 }
      );
    });
    await expect(
      buildTronTokenSend({ from: ADDR_FROM, to: ADDR_TO, token: ADDR_USDT, amount: "2" })
    ).rejects.toThrow(/insufficient balance/);
  });

  it("refuses the handle when pre-flight triggerconstantcontract reverts", async () => {
    // Encode a revert of Error("transfer amount exceeds balance").
    const reason = "transfer amount exceeds balance";
    const reasonHex = Buffer.from(reason, "utf8").toString("hex");
    const lenHex = reason.length.toString(16).padStart(64, "0");
    const offsetHex = (32).toString(16).padStart(64, "0");
    const paddedReason = reasonHex.padEnd(Math.ceil(reasonHex.length / 64) * 64, "0");
    const revertPayload = "08c379a0" + offsetHex + lenHex + paddedReason;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
        return new Response(
          JSON.stringify({
            result: { result: true },
            energy_used: 500,
            constant_result: [revertPayload],
          }),
          { status: 200 }
        );
      }
      throw new Error("pre-flight revert should short-circuit before triggersmartcontract");
    });
    await expect(
      buildTronTokenSend({ from: ADDR_FROM, to: ADDR_TO, token: ADDR_USDT, amount: "2" })
    ).rejects.toThrow(/transfer amount exceeds balance/);
  });

  it("populates estimatedEnergyUsed and estimatedEnergyCostSun from pre-flight", async () => {
    const tx = await buildTronTokenSend({
      from: ADDR_FROM,
      to: ADDR_TO,
      token: ADDR_USDT,
      amount: "2",
    });
    expect(tx.estimatedEnergyUsed).toBe("14650");
    // 14650 × 420 sun/energy = 6_153_000 sun = 6.153 TRX
    expect(tx.estimatedEnergyCostSun).toBe("6153000");
  });
});

describe("buildTronClaimRewards (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/withdrawbalance");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR_FROM);
      expect(body.visible).toBe(true);
      return new Response(
        JSON.stringify({
          txID: "aa".repeat(32),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeOwnerOnlyRawData({
            kind: "claim_rewards",
            from: ADDR_FROM,
          }),
          visible: true,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a WithdrawBalance tx with the right action tag + handle", async () => {
    const tx = await buildTronClaimRewards({ from: ADDR_FROM });
    expect(tx.action).toBe("claim_rewards");
    expect(tx.decoded.functionName).toBe("WithdrawBalanceContract");
    expect(tx.description).toContain("Claim accumulated TRON voting rewards");
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("surfaces the 24h cooldown message from TronGrid", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            Error: "WithdrawBalance not allowed, need 24 hours since last Withdraw",
          }),
          { status: 200 }
        )
    );
    await expect(buildTronClaimRewards({ from: ADDR_FROM })).rejects.toThrow(
      /need 24 hours since last Withdraw/
    );
  });

  it("rejects a non-TRON owner", async () => {
    await expect(buildTronClaimRewards({ from: "0xbad" })).rejects.toThrow(/TRON mainnet/);
  });
});

// ============================================================
// Stake 2.0 writes — formerly tron-phase2b-stake-writes.test.ts
// ============================================================

describe("buildTronFreeze (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/freezebalancev2");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR);
      expect(body.frozen_balance).toBe(100_000_000); // 100 TRX in SUN
      expect(body.resource).toBe("BANDWIDTH"); // uppercased at edge
      expect(body.visible).toBe(true);
      return directTxResponse(
        encodeFreezeV2RawData({
          from: ADDR,
          frozenBalanceSun: BigInt(body.frozen_balance),
          resource: "bandwidth",
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a BANDWIDTH freeze with correct body + preview + handle", async () => {
    const tx = await buildTronFreeze({ from: ADDR, amount: "100", resource: "bandwidth" });
    expect(tx.action).toBe("freeze");
    expect(tx.description).toBe("Freeze 100 TRX for bandwidth (Stake 2.0)");
    expect(tx.decoded.functionName).toBe("FreezeBalanceV2Contract");
    expect(tx.decoded.args).toEqual({ owner: ADDR, amount: "100", resource: "bandwidth" });
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("uppercases ENERGY at the TronGrid edge", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      const body = JSON.parse(init!.body as string);
      expect(body.resource).toBe("ENERGY");
      return directTxResponse(
        encodeFreezeV2RawData({
          from: ADDR,
          frozenBalanceSun: BigInt(body.frozen_balance),
          resource: "energy",
        })
      );
    });
    const tx = await buildTronFreeze({ from: ADDR, amount: "50", resource: "energy" });
    expect(tx.decoded.args.resource).toBe("energy"); // preserved lowercase on preview
  });

  it("rejects non-TRON `from`", async () => {
    await expect(
      buildTronFreeze({ from: "0xdead", amount: "1", resource: "bandwidth" })
    ).rejects.toThrow(/TRON mainnet/);
  });

  it("rejects zero or sub-sun amounts", async () => {
    await expect(
      buildTronFreeze({ from: ADDR, amount: "0", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 0/);
    await expect(
      buildTronFreeze({ from: ADDR, amount: "1.1234567", resource: "bandwidth" })
    ).rejects.toThrow(/more decimals than token precision/);
  });

  it("surfaces TronGrid's top-level Error verbatim", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(JSON.stringify({ Error: "contract validate error : frozen_balance must be greater than 1 TRX" }), {
        status: 200,
      });
    });
    await expect(
      buildTronFreeze({ from: ADDR, amount: "0.5", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 1 TRX/);
  });
});

describe("buildTronUnfreeze (network stubbed)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const preflight = maybeTronBandwidthResponse(url);
        if (preflight) return preflight;
        expect(url).toBe("https://api.trongrid.io/wallet/unfreezebalancev2");
        const body = JSON.parse(init!.body as string);
        expect(body.owner_address).toBe(ADDR);
        expect(body.unfreeze_balance).toBe(75_000_000); // 75 TRX
        expect(body.resource).toBe("ENERGY");
        return directTxResponse(
          encodeUnfreezeV2RawData({
            from: ADDR,
            unfreezeBalanceSun: BigInt(body.unfreeze_balance),
            resource: "energy",
          })
        );
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds an ENERGY unfreeze with 14-day-cooldown language in the preview", async () => {
    const tx = await buildTronUnfreeze({ from: ADDR, amount: "75", resource: "energy" });
    expect(tx.action).toBe("unfreeze");
    expect(tx.description).toBe(
      "Unfreeze 75 TRX from energy — 14-day unstaking cooldown begins"
    );
    expect(tx.decoded.functionName).toBe("UnfreezeBalanceV2Contract");
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("surfaces 'less than frozen balance' verbatim (overshoot guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const preflight = maybeTronBandwidthResponse(url);
        if (preflight) return preflight;
        return new Response(JSON.stringify({ Error: "contract validate error : unfreezeBalance less than frozen balance" }), {
          status: 200,
        });
      })
    );
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "9999", resource: "bandwidth" })
    ).rejects.toThrow(/less than frozen balance/);
  });

  it("rejects zero/negative amounts", async () => {
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "0", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 0/);
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "-1", resource: "bandwidth" })
    ).rejects.toThrow(/Invalid amount/);
  });
});

describe("buildTronWithdrawExpireUnfreeze (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/withdrawexpireunfreeze");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR);
      expect(body.visible).toBe(true);
      return directTxResponse(
        encodeOwnerOnlyRawData({ kind: "withdraw_expire_unfreeze", from: ADDR })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a sweep tx with handle + preview", async () => {
    const tx = await buildTronWithdrawExpireUnfreeze({ from: ADDR });
    expect(tx.action).toBe("withdraw_expire_unfreeze");
    expect(tx.decoded.functionName).toBe("WithdrawExpireUnfreezeContract");
    expect(tx.description).toContain("Withdraw all expired unfreezes");
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("surfaces 'no expire unfreeze' when nothing has matured yet", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(
        JSON.stringify({ Error: "contract validate error : no expire unfreeze" }),
        { status: 200 }
      );
    });
    await expect(buildTronWithdrawExpireUnfreeze({ from: ADDR })).rejects.toThrow(
      /no expire unfreeze/
    );
  });

  it("rejects a non-TRON owner", async () => {
    await expect(buildTronWithdrawExpireUnfreeze({ from: "0xbad" })).rejects.toThrow(
      /TRON mainnet/
    );
  });
});

// ============================================================
// SR listing + voting — formerly tron-phase2c-voting.test.ts
// ============================================================

describe("listTronWitnesses (network stubbed)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.trongrid.io/wallet/listwitnesses?visible=true") {
          return new Response(JSON.stringify(fakeWitnessList()), { status: 200 });
        }
        if (url.startsWith("https://api.trongrid.io/v1/accounts/")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  address: OWNER,
                  votes: [
                    { vote_address: SR1, vote_count: 100 },
                    { vote_address: SR2, vote_count: 50 },
                  ],
                  frozenV2: [
                    { amount: 200_000_000, type: "BANDWIDTH" }, // 200 TRX
                    { amount: 50_000_000, type: "ENERGY" }, // 50 TRX
                  ],
                },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only the top 27 active SRs by default, ranked by voteCount DESC", async () => {
    const list = await listTronWitnesses();
    expect(list.witnesses).toHaveLength(27);
    expect(list.witnesses.every((w) => w.isActive)).toBe(true);
    expect(list.witnesses[0].address).toBe(SR1);
    expect(list.witnesses[0].rank).toBe(1);
    expect(list.userVotes).toBeUndefined();
    expect(list.totalTronPower).toBeUndefined();
  });

  it("includes candidates when includeCandidates=true, and top-127 candidates share the same APR as active SRs", async () => {
    const list = await listTronWitnesses(undefined, true);
    expect(list.witnesses.length).toBeGreaterThan(27);
    const candidate = list.witnesses.find((w) => !w.isActive);
    expect(candidate).toBeDefined();
    expect(candidate!.rank).toBeGreaterThan(27);
    expect(candidate!.estVoterApr).toBeGreaterThan(0);
    expect(candidate!.estVoterApr).toBe(list.witnesses[0].estVoterApr);
  });

  it("computes voter APR as 160 TRX/block pool ÷ total top-127 vote weight", async () => {
    const list = await listTronWitnesses();
    const top = list.witnesses[0];
    // Fake set total top-127 votes = top3 (9e9) + 27 tail entries summing
    // to Σ_{i=0..26}(1_000_000 - i) = 27 * 1_000_000 - (0+1+...+26)
    // = 27_000_000 - 351 = 26_999_649.
    const totalTop127 = 5_000_000_000 + 3_000_000_000 + 1_000_000_000 + 26_999_649;
    const expected = (160 * 28800 * 365) / totalTop127;
    expect(top.estVoterApr).toBeCloseTo(expected, 10);
    for (const w of list.witnesses) {
      expect(w.estVoterApr).toBeCloseTo(expected, 10);
    }
  });

  it("augments the response with userVotes / totalTronPower / availableVotes when address is passed", async () => {
    const list = await listTronWitnesses(OWNER);
    expect(list.userVotes).toEqual([
      { address: SR1, count: 100 },
      { address: SR2, count: 50 },
    ]);
    // 200 + 50 = 250 TRX frozen → 250 vote units.
    expect(list.totalTronPower).toBe(250);
    expect(list.totalVotesCast).toBe(150);
    expect(list.availableVotes).toBe(100);
  });

  it("clamps availableVotes to 0 when cast > power (edge case; shouldn't happen on-chain but be defensive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.trongrid.io/wallet/listwitnesses")) {
          return new Response(JSON.stringify(fakeWitnessList()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                votes: [{ vote_address: SR1, vote_count: 999 }],
                frozenV2: [{ amount: 100_000_000, type: "BANDWIDTH" }], // 100 TRX
              },
            ],
          }),
          { status: 200 }
        );
      })
    );
    const list = await listTronWitnesses(OWNER);
    expect(list.availableVotes).toBe(0);
  });

  it("rejects a malformed address", async () => {
    await expect(listTronWitnesses("0xdeadbeef")).rejects.toThrow(/TRON mainnet/);
  });
});

describe("buildTronVote (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/votewitnessaccount");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(OWNER);
      expect(body.visible).toBe(true);
      expect(Array.isArray(body.votes)).toBe(true);
      return new Response(
        JSON.stringify({
          txID: "cc".repeat(32),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeVoteWitnessRawData({
            from: OWNER,
            votes: (body.votes as Array<{ vote_address: string; vote_count: number }>).map(
              (v) => ({ address: v.vote_address, count: v.vote_count })
            ),
          }),
          visible: true,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a multi-SR vote tx with the right body shape + handle", async () => {
    const tx = await buildTronVote({
      from: OWNER,
      votes: [
        { address: SR1, count: 100 },
        { address: SR2, count: 50 },
      ],
    });
    expect(tx.action).toBe("vote");
    expect(tx.decoded.functionName).toBe("VoteWitnessContract");
    expect(tx.description).toBe(
      "Cast 150 TRON Power across 2 SRs (replaces any prior votes)"
    );
    expect(tx.decoded.args.totalVotes).toBe("150");
    expect(hasTronHandle(tx.handle!)).toBe(true);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.votes).toEqual([
      { vote_address: SR1, vote_count: 100 },
      { vote_address: SR2, vote_count: 50 },
    ]);
  });

  it("emits a clear-votes description when votes=[]", async () => {
    const tx = await buildTronVote({ from: OWNER, votes: [] });
    expect(tx.description).toBe(`Clear all SR votes for ${OWNER}`);
    expect(tx.decoded.args.totalVotes).toBe("0");
  });

  it("rejects duplicate SR addresses in the allocation", async () => {
    await expect(
      buildTronVote({
        from: OWNER,
        votes: [
          { address: SR1, count: 100 },
          { address: SR1, count: 50 },
        ],
      })
    ).rejects.toThrow(/Duplicate vote target/);
  });

  it("rejects non-integer or non-positive counts", async () => {
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 0 }] })
    ).rejects.toThrow(/positive integer/);
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 1.5 }] })
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects non-TRON vote targets", async () => {
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: "0xbad", count: 1 }] })
    ).rejects.toThrow(/not a valid TRON/);
  });

  it("surfaces TronGrid 'Not enough tron power' verbatim", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(
        JSON.stringify({ Error: "contract validate error : Not enough tron power" }),
        { status: 200 }
      );
    });
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 999_999 }] })
    ).rejects.toThrow(/Not enough tron power/);
  });
});
