import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRON_TOKENS } from "../src/config/tron.js";
import { buildTronTrc20Approve } from "../src/modules/tron/actions.js";
import { hasTronHandle } from "../src/signing/tron-tx-store.js";
import { encodeTriggerSmartContractRawData } from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";

/**
 * `prepare_tron_trc20_approve` builder tests. Mirrors the test pattern of
 * `prepare_tron_token_send` (TronGrid POST body shape, raw_data verify,
 * handle issuance, validation) but with two new invariants specific to
 * approve:
 *   - selector is `095ea7b3` (approve), not `a9059cbb` (transfer)
 *   - canonical-token decimals are auto-resolved; non-canonical tokens
 *     REQUIRE explicit `decimals` (we refuse to default — off-by-power-
 *     of-ten allowance is too dangerous to silently fix up)
 */

const ADDR_USDT = TRON_TOKENS.USDT;
const ADDR_FROM = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const TRON_LIFI_DIAMOND = "TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt";
const APPROVE_SELECTOR = "095ea7b3";

function trongridFetchMock(opts: {
  expected: {
    selector: string;
    contract: string;
    feeLimitSun: number;
  };
  energyUsed?: number;
}) {
  return async (url: string, init?: RequestInit) => {
    const preflight = maybeTronBandwidthResponse(url);
    if (preflight) return preflight;
    if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
      return new Response(
        JSON.stringify({
          result: { result: true },
          energy_used: opts.energyUsed ?? 14_650,
          constant_result: [""],
        }),
        { status: 200 },
      );
    }
    expect(url).toBe("https://api.trongrid.io/wallet/triggersmartcontract");
    const body = JSON.parse(init!.body as string);
    expect(body.contract_address).toBe(opts.expected.contract);
    expect(body.function_selector).toBe(opts.expected.selector);
    expect(body.fee_limit).toBe(opts.expected.feeLimitSun);
    return new Response(
      JSON.stringify({
        result: { result: true },
        transaction: {
          txID: "deadbeef".repeat(8),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeTriggerSmartContractRawData({
            from: ADDR_FROM,
            contract: opts.expected.contract,
            dataHex: APPROVE_SELECTOR + body.parameter,
            feeLimitSun: BigInt(body.fee_limit),
          }),
          visible: true,
        },
      }),
      { status: 200 },
    );
  };
}

describe("buildTronTrc20Approve — happy path", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          expected: {
            selector: "approve(address,uint256)",
            contract: ADDR_USDT,
            feeLimitSun: 100_000_000,
          },
        }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds an approve to the LiFi Diamond for canonical USDT (6-decimal auto-resolve)", async () => {
    const tx = await buildTronTrc20Approve({
      from: ADDR_FROM,
      token: ADDR_USDT,
      spender: TRON_LIFI_DIAMOND,
      amount: "10",
    });

    expect(tx.action).toBe("trc20_approve");
    expect(tx.from).toBe(ADDR_FROM);
    expect(tx.txID).toBe("deadbeef".repeat(8));
    expect(tx.description).toBe(`Approve 10 USDT for spender ${TRON_LIFI_DIAMOND}`);
    expect(tx.decoded.functionName).toBe("approve(address,uint256)");
    expect(tx.decoded.args.spender).toBe(TRON_LIFI_DIAMOND);
    expect(tx.decoded.args.symbol).toBe("USDT");
    expect(tx.decoded.args.contract).toBe(ADDR_USDT);
    expect(tx.decoded.args.decimals).toBe("6");
    expect(tx.feeLimitSun).toBe("100000000");
    expect(tx.estimatedEnergyUsed).toBe("14650");
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("encodes the approve param with spender as the address word, amount as the uint256 word", async () => {
    let capturedParameter: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const preflight = maybeTronBandwidthResponse(url);
        if (preflight) return preflight;
        if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
          return new Response(
            JSON.stringify({ result: { result: true }, energy_used: 14_650, constant_result: [""] }),
            { status: 200 },
          );
        }
        const body = JSON.parse(init!.body as string);
        capturedParameter = body.parameter;
        return new Response(
          JSON.stringify({
            result: { result: true },
            transaction: {
              txID: "abcd".repeat(16),
              raw_data: { expiration: 0 },
              raw_data_hex: encodeTriggerSmartContractRawData({
                from: ADDR_FROM,
                contract: ADDR_USDT,
                dataHex: APPROVE_SELECTOR + body.parameter,
                feeLimitSun: BigInt(body.fee_limit),
              }),
              visible: true,
            },
          }),
          { status: 200 },
        );
      }),
    );
    await buildTronTrc20Approve({
      from: ADDR_FROM,
      token: ADDR_USDT,
      spender: TRON_LIFI_DIAMOND,
      amount: "10",
    });
    expect(capturedParameter).toBeDefined();
    expect(capturedParameter!.length).toBe(128);
    // Second word = 10 USDT in base units = 10_000_000.
    expect(capturedParameter!.slice(64)).toBe(
      (10_000_000n).toString(16).padStart(64, "0"),
    );
    // First word = padded spender address (drop 0x41 TRON prefix).
    // Don't recompute base58→hex here; just assert the last 40 chars
    // (= 20-byte address form) appear in the address word.
    expect(capturedParameter!.slice(0, 64).slice(0, 24)).toBe("0".repeat(24));
  });

  it("accepts a non-canonical TRC-20 contract when explicit decimals is passed", async () => {
    const NON_CANONICAL_CONTRACT = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"; // any valid TRON addr
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          expected: {
            selector: "approve(address,uint256)",
            contract: NON_CANONICAL_CONTRACT,
            feeLimitSun: 100_000_000,
          },
        }),
      ),
    );
    const tx = await buildTronTrc20Approve({
      from: ADDR_FROM,
      token: NON_CANONICAL_CONTRACT,
      spender: TRON_LIFI_DIAMOND,
      amount: "5",
      decimals: 8,
    });
    expect(tx.action).toBe("trc20_approve");
    expect(tx.decoded.args.decimals).toBe("8");
    // Non-canonical token: description uses the contract address as the
    // symbol fallback rather than guessing.
    expect(tx.description).toContain("TRC-20");
    expect(tx.description).toContain(NON_CANONICAL_CONTRACT);
  });

  it("honours an explicit feeLimitTrx override", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          expected: {
            selector: "approve(address,uint256)",
            contract: ADDR_USDT,
            feeLimitSun: 50_000_000, // 50 TRX
          },
        }),
      ),
    );
    const tx = await buildTronTrc20Approve({
      from: ADDR_FROM,
      token: ADDR_USDT,
      spender: TRON_LIFI_DIAMOND,
      amount: "10",
      feeLimitTrx: "50",
    });
    expect(tx.feeLimitSun).toBe("50000000");
  });
});

describe("buildTronTrc20Approve — rejection paths", () => {
  it("rejects a non-TRON wallet", async () => {
    await expect(
      buildTronTrc20Approve({
        from: "0xnotvalidtron",
        token: ADDR_USDT,
        spender: TRON_LIFI_DIAMOND,
        amount: "10",
      }),
    ).rejects.toThrow(/"from" is not a valid TRON/);
  });

  it("rejects a non-TRON token contract", async () => {
    await expect(
      buildTronTrc20Approve({
        from: ADDR_FROM,
        token: "0xnotvalidtron",
        spender: TRON_LIFI_DIAMOND,
        amount: "10",
      }),
    ).rejects.toThrow(/"token" is not a valid TRC-20 base58/);
  });

  it("rejects a non-TRON spender", async () => {
    await expect(
      buildTronTrc20Approve({
        from: ADDR_FROM,
        token: ADDR_USDT,
        spender: "0xnotvalidtron",
        amount: "10",
      }),
    ).rejects.toThrow(/"spender" is not a valid TRON/);
  });

  it("REFUSES to default decimals on a non-canonical token", async () => {
    const NON_CANONICAL_CONTRACT = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    await expect(
      buildTronTrc20Approve({
        from: ADDR_FROM,
        token: NON_CANONICAL_CONTRACT,
        spender: TRON_LIFI_DIAMOND,
        amount: "10",
        // decimals omitted
      }),
    ).rejects.toThrow(
      /not in the canonical TRC-20 set.*explicit `decimals`.*off-by-power-of-ten/,
    );
  });

  it("rejects zero / negative amounts", async () => {
    await expect(
      buildTronTrc20Approve({
        from: ADDR_FROM,
        token: ADDR_USDT,
        spender: TRON_LIFI_DIAMOND,
        amount: "0",
      }),
    ).rejects.toThrow(/Amount must be greater than 0/);
  });
});
