import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TRON_TOKENS,
  SUNSWAP_V2_ROUTER_TRON,
  WTRX_TRON,
} from "../src/config/tron.js";
import { buildTronSunswapSwap } from "../src/modules/tron/sunswap-swap.js";
import { hasTronHandle } from "../src/signing/tron-tx-store.js";
import { encodeTriggerSmartContractRawData } from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";
import { base58ToHex } from "../src/modules/tron/address.js";

/**
 * SunSwap V2 same-chain swap builder tests. Three load-bearing pieces:
 *
 *   1. ABI calldata encoding for swapExactETHForTokens / swapExactTokensForETH /
 *      swapExactTokensForTokens (path layout, head/tail offsets, native-vs-token).
 *   2. Quote → minOut derivation (quotedOut * (10000 - slippageBps) / 10000).
 *   3. Allowance preflight refusal for TRC-20 source flows.
 *
 * The TronGrid mock routes by URL + (for triggerconstantcontract) the
 * embedded function_selector — getAmountsOut, allowance, and the per-call
 * preflight all hit the same endpoint with different selectors.
 */

const ADDR_WALLET = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const ADDR_USDT = TRON_TOKENS.USDT;
const ADDR_USDC = TRON_TOKENS.USDC;

// Selectors hardcoded in src/modules/tron/sunswap-swap.ts.
const SELECTOR_SWAP_EXACT_ETH_FOR_TOKENS = "fb3bdb41";
const SELECTOR_SWAP_EXACT_TOKENS_FOR_ETH = "18cbafe5";
const SELECTOR_SWAP_EXACT_TOKENS_FOR_TOKENS = "38ed1739";

interface MockOpts {
  /**
   * Output amounts the mocked router returns from getAmountsOut. Encoded
   * as a uint256[] return; the builder picks amounts[length-1] as the
   * final output. Must be at least 2 entries (path is always ≥ 2 hops).
   */
  amountsOut: bigint[];
  /**
   * Allowance the mocked router reports for any TRC-20 allowance() read.
   * For TRX-source swaps this is irrelevant (builder skips the read);
   * default 0 here exposes any unexpected TRC-20 source path.
   */
  allowance?: bigint;
  /**
   * Capture for the final triggersmartcontract POST body — useful for
   * pinning calldata fixtures.
   */
  capture?: { body?: Record<string, unknown> };
}

function encodeUintReturn(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeUintArrayReturn(values: bigint[]): string {
  const offset = (32n).toString(16).padStart(64, "0");
  const length = BigInt(values.length).toString(16).padStart(64, "0");
  const elements = values.map(encodeUintReturn).join("");
  return offset + length + elements;
}

function trongridFetchMock(opts: MockOpts) {
  const allowanceHex = encodeUintReturn(opts.allowance ?? 0n);
  const amountsOutHex = encodeUintArrayReturn(opts.amountsOut);

  return async (url: string, init?: RequestInit) => {
    const preflight = maybeTronBandwidthResponse(url);
    if (preflight) return preflight;
    if (url === "https://api.trongrid.io/wallet/triggerconstantcontract") {
      const body = JSON.parse(init!.body as string);
      const selector = body.function_selector as string;
      if (selector.startsWith("getAmountsOut")) {
        return new Response(
          JSON.stringify({
            result: { result: true },
            energy_used: 50_000,
            constant_result: [amountsOutHex],
          }),
          { status: 200 },
        );
      }
      if (selector.startsWith("allowance")) {
        return new Response(
          JSON.stringify({
            result: { result: true },
            energy_used: 5_000,
            constant_result: [allowanceHex],
          }),
          { status: 200 },
        );
      }
      // Otherwise it's the per-call preflight (stub call before
      // triggersmartcontract). Return a benign empty constant_result.
      return new Response(
        JSON.stringify({
          result: { result: true },
          energy_used: 90_000,
          constant_result: [""],
        }),
        { status: 200 },
      );
    }
    expect(url).toBe("https://api.trongrid.io/wallet/triggersmartcontract");
    const body = JSON.parse(init!.body as string);
    if (opts.capture) opts.capture.body = body;
    const callValue = body.call_value === 0 ? 0n : BigInt(body.call_value);
    return new Response(
      JSON.stringify({
        result: { result: true },
        transaction: {
          txID: "deadbeef".repeat(8),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeTriggerSmartContractRawData({
            from: ADDR_WALLET,
            contract: SUNSWAP_V2_ROUTER_TRON,
            dataHex: (body.function_selector as string).startsWith(
              "swapExactETHForTokens",
            )
              ? SELECTOR_SWAP_EXACT_ETH_FOR_TOKENS + body.parameter
              : (body.function_selector as string).startsWith(
                    "swapExactTokensForETH",
                  )
                ? SELECTOR_SWAP_EXACT_TOKENS_FOR_ETH + body.parameter
                : SELECTOR_SWAP_EXACT_TOKENS_FOR_TOKENS + body.parameter,
            callValue,
            feeLimitSun: BigInt(body.fee_limit),
          }),
          visible: true,
        },
      }),
      { status: 200 },
    );
  };
}

describe("buildTronSunswapSwap — happy paths", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("TRX → USDT: swapExactETHForTokens, call_value=amountIn, path=[WTRX, USDT]", async () => {
    const capture: MockOpts["capture"] = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [100_000_000n, 99_500_000n], // 100 TRX → 99.5 USDT
          capture,
        }),
      ),
    );
    const tx = await buildTronSunswapSwap({
      wallet: ADDR_WALLET,
      fromToken: "TRX",
      toToken: ADDR_USDT,
      amount: "100",
    });

    expect(tx.action).toBe("sunswap_swap");
    expect(tx.from).toBe(ADDR_WALLET);
    expect(tx.txID).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
    expect(tx.decoded.functionName).toBe(
      "swapExactETHForTokens(uint256,address[],address,uint256)",
    );
    expect(tx.decoded.args.fromSymbol).toBe("TRX");
    expect(tx.decoded.args.toSymbol).toBe("USDT");
    expect(tx.decoded.args.amountIn).toBe("100");
    // 100 TRX × 6 decimals = 100_000_000 sun
    expect(tx.decoded.args.amountInBase).toBe("100000000");
    // Quoted out 99_500_000 base → 99.5 USDT
    expect(tx.decoded.args.amountOutQuoted).toBe("99.5");
    // minOut at 0.5% slippage = 99.5 × (1 - 0.005) = 99.0025
    expect(tx.decoded.args.amountOutMinBase).toBe(
      ((99_500_000n * 9_950n) / 10_000n).toString(),
    );
    expect(tx.decoded.args.path).toBe(`${WTRX_TRON} -> ${ADDR_USDT}`);
    expect(tx.decoded.args.router).toBe(SUNSWAP_V2_ROUTER_TRON);
    expect(tx.decoded.args.callValueSun).toBe("100000000");

    // call_value on the TronGrid request equals amountIn in sun
    expect(capture.body!.call_value).toBe(100_000_000);
    expect(capture.body!.contract_address).toBe(SUNSWAP_V2_ROUTER_TRON);
    expect(capture.body!.function_selector).toBe(
      "swapExactETHForTokens(uint256,address[],address,uint256)",
    );
  });

  it("USDT → TRX: swapExactTokensForETH, call_value=0, path=[USDT, WTRX]", async () => {
    const capture: MockOpts["capture"] = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [10_000_000n, 9_950_000n], // 10 USDT → 9.95 TRX
          allowance: 100_000_000n, // plenty
          capture,
        }),
      ),
    );
    const tx = await buildTronSunswapSwap({
      wallet: ADDR_WALLET,
      fromToken: ADDR_USDT,
      toToken: "TRX",
      amount: "10",
    });

    expect(tx.action).toBe("sunswap_swap");
    expect(tx.decoded.functionName).toBe(
      "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
    );
    expect(tx.decoded.args.fromSymbol).toBe("USDT");
    expect(tx.decoded.args.toSymbol).toBe("TRX");
    expect(tx.decoded.args.amountInBase).toBe("10000000");
    expect(tx.decoded.args.path).toBe(`${ADDR_USDT} -> ${WTRX_TRON}`);
    expect(tx.decoded.args.callValueSun).toBe("0");
    // Tron API uses call_value 0 (not absent) for TRC-20 calls
    expect(capture.body!.call_value).toBe(0);
  });

  it("USDT → USDC: swapExactTokensForTokens with WTRX hop, path=[USDT, WTRX, USDC]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [
            10_000_000n, // amountIn
            32_500_000_000n, // intermediate WTRX (USDT × ~3250 TRX/USDT, fictional)
            9_980_000n, // final USDC
          ],
          allowance: 100_000_000n,
        }),
      ),
    );
    const tx = await buildTronSunswapSwap({
      wallet: ADDR_WALLET,
      fromToken: ADDR_USDT,
      toToken: ADDR_USDC,
      amount: "10",
    });

    expect(tx.decoded.functionName).toBe(
      "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    );
    expect(tx.decoded.args.path).toBe(
      `${ADDR_USDT} -> ${WTRX_TRON} -> ${ADDR_USDC}`,
    );
    expect(tx.decoded.args.amountOutQuoted).toBe("9.98");
    // minOut at default 0.5% = 9_980_000 × 0.995 = 9_930_100
    expect(tx.decoded.args.amountOutMinBase).toBe("9930100");
  });

  it("custom slippage applies to minOut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [100_000_000n, 100_000_000n], // 1:1 quote (10000 base → 10000 base)
        }),
      ),
    );
    const tx = await buildTronSunswapSwap({
      wallet: ADDR_WALLET,
      fromToken: "TRX",
      toToken: ADDR_USDT,
      amount: "100",
      slippageBps: 100, // 1%
    });
    // 100_000_000 × (10000 - 100) / 10000 = 99_000_000
    expect(tx.decoded.args.amountOutMinBase).toBe("99000000");
    expect(tx.decoded.args.slippageBps).toBe("100");
  });

  it("encodes swapExactETHForTokens parameter with correct head/tail offsets", async () => {
    const capture: MockOpts["capture"] = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [100_000_000n, 99_500_000n],
          capture,
        }),
      ),
    );
    await buildTronSunswapSwap({
      wallet: ADDR_WALLET,
      fromToken: "TRX",
      toToken: ADDR_USDT,
      amount: "100",
      slippageBps: 0, // minOut == quotedOut for a clean fixture
    });

    const param = capture.body!.parameter as string;
    // 4 head words (each 64 hex) + 1 length word + 2 path words = 7 * 64 = 448
    expect(param.length).toBe(448);

    const word = (i: number) => param.slice(i * 64, (i + 1) * 64);
    // Word 0 = amountOutMin = 99_500_000
    expect(BigInt("0x" + word(0))).toBe(99_500_000n);
    // Word 1 = offset to path = 0x80 = 128
    expect(BigInt("0x" + word(1))).toBe(128n);
    // Word 2 = `to` (wallet, dropped 0x41 prefix, left-padded)
    expect(word(2).slice(24)).toBe(base58ToHex(ADDR_WALLET).slice(2));
    // Word 4 = path length = 2
    expect(BigInt("0x" + word(4))).toBe(2n);
    // Word 5 = WTRX address (path[0])
    expect(word(5).slice(24)).toBe(base58ToHex(WTRX_TRON).slice(2));
    // Word 6 = USDT address (path[1])
    expect(word(6).slice(24)).toBe(base58ToHex(ADDR_USDT).slice(2));
  });
});

describe("buildTronSunswapSwap — refusals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an invalid wallet", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: "0xnotvalidtron",
        fromToken: "TRX",
        toToken: ADDR_USDT,
        amount: "100",
      }),
    ).rejects.toThrow(/not a valid TRON mainnet address/);
  });

  it("rejects fromToken == toToken", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: ADDR_USDT,
        toToken: ADDR_USDT,
        amount: "10",
      }),
    ).rejects.toThrow(/identical/);
  });

  it("rejects TRX → TRX", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TRX",
        toToken: "TRX",
        amount: "1",
      }),
    ).rejects.toThrow(/cannot both be TRX/);
  });

  it("rejects non-canonical fromToken without explicit decimals", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", // canonical TUSD
        toToken: ADDR_USDT,
        amount: "10",
        // no fromTokenDecimals — but TUSD is canonical, so this should pass!
      }),
    ).rejects.toThrow(); // will fail later (no liquidity mock), but not on decimals
    // Now exercise the actual non-canonical-without-decimals path:
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TZ4UXDV5ZhNW7fb2AMSbgfAEZ7hWsnYS2g", // arbitrary non-canonical
        toToken: ADDR_USDT,
        amount: "10",
      }),
    ).rejects.toThrow(/refuse to guess decimals/);
  });

  it("rejects when getAmountsOut returns 0 (insufficient liquidity)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [100_000_000n, 0n], // pool returns 0 — no liquidity
        }),
      ),
    );
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TRX",
        toToken: ADDR_USDT,
        amount: "100",
      }),
    ).rejects.toThrow(/Insufficient liquidity/);
  });

  it("refuses TRC-20 source with insufficient allowance + provides recovery hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        trongridFetchMock({
          amountsOut: [10_000_000n, 9_950_000n],
          allowance: 5_000_000n, // less than amountIn = 10_000_000
        }),
      ),
    );
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: ADDR_USDT,
        toToken: "TRX",
        amount: "10",
      }),
    ).rejects.toThrow(/insufficient allowance/);
    // And the message should name prepare_tron_trc20_approve as the fix
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: ADDR_USDT,
        toToken: "TRX",
        amount: "10",
      }),
    ).rejects.toThrow(/prepare_tron_trc20_approve/);
  });

  it("rejects amount = 0", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TRX",
        toToken: ADDR_USDT,
        amount: "0",
      }),
    ).rejects.toThrow(/greater than 0/);
  });

  it("rejects slippageBps out of range", async () => {
    await expect(
      buildTronSunswapSwap({
        wallet: ADDR_WALLET,
        fromToken: "TRX",
        toToken: ADDR_USDT,
        amount: "100",
        slippageBps: 10_001,
      }),
    ).rejects.toThrow(/slippageBps/);
  });
});
