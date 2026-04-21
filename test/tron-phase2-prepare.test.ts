import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRON_TOKENS } from "../src/config/tron.js";
import { base58ToHex, encodeTrc20TransferParam } from "../src/modules/tron/address.js";
import {
  buildTronNativeSend,
  buildTronTokenSend,
  buildTronClaimRewards,
} from "../src/modules/tron/actions.js";
import { hasTronHandle, consumeTronHandle } from "../src/signing/tron-tx-store.js";
import {
  encodeTransferRawData,
  encodeTriggerSmartContractRawData,
  encodeOwnerOnlyRawData,
} from "./helpers/tron-raw-data-encode.js";

/**
 * Phase-2 (TRON tx preparation) tests. Network IO against TronGrid is stubbed
 * via vi.stubGlobal("fetch", ...). We lock down:
 *   - base58check decode + TRC-20 ABI param encoding (pure crypto, no network)
 *   - each builder's POST body shape (visible:true, right endpoint, right fields)
 *   - handle issuance (tx comes back with a handle that consumeTronHandle recognises)
 *   - error surfacing (TronGrid's two distinct error shapes)
 *   - validation (non-TRON addresses, non-canonical TRC-20s, zero/negative amounts)
 */

const ADDR_USDT = TRON_TOKENS.USDT; // "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
const ADDR_FROM = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"; // well-known large TRX holder
const ADDR_TO = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9"; // another well-known address

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
    expect(tx.txID).toBe("deadbeef".repeat(8));
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
      // Pre-flight dry-run hits triggerconstantcontract first.
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
    expect(tx.txID).toBe("cafebabe".repeat(8));
    expect(tx.description).toBe(`Send 2 USDT to ${ADDR_TO}`);
    expect(tx.decoded.args.symbol).toBe("USDT");
    expect(tx.decoded.args.contract).toBe(ADDR_USDT);
    expect(tx.feeLimitSun).toBe("100000000");
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("honours an explicit feeLimitTrx override", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
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
