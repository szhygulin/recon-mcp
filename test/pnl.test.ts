/**
 * Unit tests for `get_pnl_summary`. Same mocking pattern as
 * `test/diff.test.ts`: the chain-reader stack and DefiLlama historical
 * price lookups are mocked at the module boundary so no RPC / no
 * external HTTP fires. Asserts:
 *   - Input validation: at least one address required.
 *   - Empty wallet across all chains → pnlUsd === 0, perChain empty.
 *   - Single external inflow with priced flow → inflowsUsd reflects
 *     it AND pnlUsd === 0 (the inflow doesn't count as profit).
 *   - Buy-and-hold with 2× price move → pnlUsd ≈ qty * (endingPrice -
 *     startingPrice), netUserContributionUsd === 0.
 *   - Multi-chain fold: EVM wallet + TRON address + Solana address each
 *     contribute their own slice to perChain; top-level numbers sum.
 *   - Truncated history flag propagates to summary.truncated.
 *   - Partial price coverage when DefiLlama misses → summary.priceCoverage
 *     is "partial".
 *   - inception period resolves to a 365d-ish startMs (not "since wallet
 *     creation").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchNativeBalanceMock = vi.fn();
const fetchTopErc20BalancesMock = vi.fn();
const getTronBalancesMock = vi.fn();
const getSolanaBalancesMock = vi.fn();
const getBitcoinBalanceMock = vi.fn();
const fetchBitcoinPriceMock = vi.fn();
const getTransactionHistoryMock = vi.fn();
const lookupHistoricalPricesMock = vi.fn();

vi.mock("../src/modules/portfolio/index.ts", () => ({
  fetchNativeBalance: (...a: unknown[]) => fetchNativeBalanceMock(...a),
  fetchTopErc20Balances: (...a: unknown[]) => fetchTopErc20BalancesMock(...a),
}));
vi.mock("../src/modules/tron/balances.ts", () => ({
  getTronBalances: (...a: unknown[]) => getTronBalancesMock(...a),
}));
vi.mock("../src/modules/solana/balances.ts", () => ({
  getSolanaBalances: (...a: unknown[]) => getSolanaBalancesMock(...a),
}));
vi.mock("../src/modules/btc/balances.ts", () => ({
  getBitcoinBalance: (...a: unknown[]) => getBitcoinBalanceMock(...a),
}));
vi.mock("../src/modules/btc/price.ts", () => ({
  fetchBitcoinPrice: (...a: unknown[]) => fetchBitcoinPriceMock(...a),
}));
vi.mock("../src/modules/history/index.ts", () => ({
  getTransactionHistory: (...a: unknown[]) => getTransactionHistoryMock(...a),
}));
vi.mock("../src/modules/history/prices.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/history/prices.ts")>();
  return {
    ...actual,
    lookupHistoricalPrices: (...a: unknown[]) =>
      lookupHistoricalPricesMock(...a),
  };
});

const WALLET = "0x000000000000000000000000000000000000dEaD";
const TRON_ADDR = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const SOLANA_ADDR = "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt94Wdcuh1S";

async function emptyNative(_w: string, chain: string): Promise<{
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
}> {
  return {
    token: "0x0000000000000000000000000000000000000000",
    symbol: chain === "polygon" ? "MATIC" : "ETH",
    decimals: 18,
    amount: "0",
    formatted: "0",
  };
}

beforeEach(() => {
  fetchNativeBalanceMock.mockReset();
  fetchTopErc20BalancesMock.mockReset();
  getTronBalancesMock.mockReset();
  getSolanaBalancesMock.mockReset();
  getBitcoinBalanceMock.mockReset();
  fetchBitcoinPriceMock.mockReset();
  getTransactionHistoryMock.mockReset();
  lookupHistoricalPricesMock.mockReset();

  fetchNativeBalanceMock.mockImplementation(emptyNative);
  fetchTopErc20BalancesMock.mockResolvedValue([]);
  getTronBalancesMock.mockResolvedValue({
    address: TRON_ADDR,
    native: [],
    trc20: [],
    walletBalancesUsd: 0,
  });
  getSolanaBalancesMock.mockResolvedValue({
    address: SOLANA_ADDR,
    native: [],
    spl: [],
    walletBalancesUsd: 0,
  });
  getBitcoinBalanceMock.mockResolvedValue({
    address: "bc1q-empty",
    addressType: "p2wpkh",
    confirmedSats: 0n,
    mempoolSats: 0n,
    totalSats: 0n,
    confirmedBtc: "0",
    totalBtc: "0",
    symbol: "BTC",
    decimals: 8,
    txCount: 0,
  });
  fetchBitcoinPriceMock.mockResolvedValue(60_000);
  getTransactionHistoryMock.mockResolvedValue({
    chain: "ethereum",
    wallet: WALLET,
    items: [],
    truncated: false,
    priceCoverage: "full",
  });
  lookupHistoricalPricesMock.mockResolvedValue({
    prices: new Map(),
    missed: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPnlSummary — input validation", () => {
  it("throws when no address is supplied", async () => {
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    await expect(getPnlSummary({ period: "30d" })).rejects.toThrow(
      /At least one of `wallet`/,
    );
  });
});

describe("getPnlSummary — empty wallet", () => {
  it("returns pnlUsd=0 and an empty perChain when no balances or history", async () => {
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });
    expect(r.pnlUsd).toBe(0);
    expect(r.startingValueUsd).toBe(0);
    expect(r.endingValueUsd).toBe(0);
    expect(r.inflowsUsd).toBe(0);
    expect(r.outflowsUsd).toBe(0);
    expect(r.netUserContributionUsd).toBe(0);
    expect(r.perChain).toHaveLength(0);
    expect(r.priceCoverage).toBe("full");
    expect(r.truncated).toBe(false);
  });
});

describe("getPnlSummary — single external inflow during period", () => {
  it("counts the inflow but leaves pnlUsd at 0", async () => {
    // 0.5 ETH currently held, came in via one external transfer in the
    // window. The starting quantity reconstructs to 0 (clamped from -0.5).
    fetchNativeBalanceMock.mockImplementation(async (_w: string, chain: string) => {
      if (chain === "ethereum") {
        return {
          token: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          amount: "500000000000000000",
          formatted: "0.5",
          priceUsd: 4000,
          valueUsd: 2000,
        };
      }
      return emptyNative(_w, chain);
    });
    getTransactionHistoryMock.mockImplementation(async (a: { chain: string }) => ({
      chain: a.chain,
      wallet: WALLET,
      items:
        a.chain === "ethereum"
          ? [
              {
                type: "external",
                hash: "0xabc",
                timestamp: Math.floor(Date.now() / 1000) - 86_400,
                from: "0x1111111111111111111111111111111111111111",
                to: WALLET,
                status: "success",
                valueNative: "500000000000000000",
                valueNativeFormatted: "0.5",
                valueUsd: 2000,
              },
            ]
          : [],
      truncated: false,
      priceCoverage: "full",
    }));

    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });

    expect(r.endingValueUsd).toBe(2000);
    expect(r.inflowsUsd).toBe(2000);
    expect(r.outflowsUsd).toBe(0);
    expect(r.netUserContributionUsd).toBe(2000);
    // walletValueChange (2000) - netUserContribution (2000) = 0.
    // Tolerate tiny float drift from the netFlowUsd averaging in the diff.
    expect(Math.abs(r.pnlUsd)).toBeLessThan(1);
  });
});

describe("getPnlSummary — buy-and-hold price appreciation", () => {
  it("attributes pure price moves to pnlUsd, leaves netUserContribution at 0", async () => {
    // 1 ETH held; ETH was $4000 at period start, $4400 now → +$400 PnL.
    fetchNativeBalanceMock.mockImplementation(async (_w: string, chain: string) => {
      if (chain === "ethereum") {
        return {
          token: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          amount: "1000000000000000000",
          formatted: "1.0",
          priceUsd: 4400,
          valueUsd: 4400,
        };
      }
      return emptyNative(_w, chain);
    });
    // Permissive map keyed by exactly what the composer asks for. The
    // composer calls lookupHistoricalPrices with the chain's nativeCoinKey
    // ("coingecko:ethereum") + the resolved startSec; we synthesize a
    // matcher that returns 4000 for any timestamp at that key.
    lookupHistoricalPricesMock.mockImplementation(
      async (requests: Array<{ coinKey: string; timestamp: number }>) => {
        const prices = new Map<string, number>();
        for (const req of requests) {
          if (req.coinKey === "coingecko:ethereum") {
            prices.set(`${req.coinKey}@${req.timestamp}`, 4000);
          }
        }
        return { prices, missed: false };
      },
    );

    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });

    expect(r.endingValueUsd).toBe(4400);
    expect(r.startingValueUsd).toBe(4000);
    expect(r.netUserContributionUsd).toBe(0);
    expect(r.pnlUsd).toBeCloseTo(400, 1);
    expect(r.walletValueChangeUsd).toBe(400);
  });
});

describe("getPnlSummary — multi-chain fold", () => {
  it("aggregates EVM + TRON + Solana into top-level numbers", async () => {
    // EVM: 0.1 ETH @ $4000 = $400
    fetchNativeBalanceMock.mockImplementation(async (_w: string, chain: string) => {
      if (chain === "ethereum") {
        return {
          token: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          amount: "100000000000000000",
          formatted: "0.1",
          priceUsd: 4000,
          valueUsd: 400,
        };
      }
      return emptyNative(_w, chain);
    });
    // TRON: 100 TRX @ $0.10 = $10
    getTronBalancesMock.mockResolvedValue({
      address: TRON_ADDR,
      native: [
        {
          chain: "tron",
          token: "native",
          symbol: "TRX",
          decimals: 6,
          amount: "100000000",
          formatted: "100",
          priceUsd: 0.1,
          valueUsd: 10,
        },
      ],
      trc20: [],
      walletBalancesUsd: 10,
    });
    // Solana: 1 SOL @ $200 = $200
    getSolanaBalancesMock.mockResolvedValue({
      address: SOLANA_ADDR,
      native: [
        {
          chain: "solana",
          token: "native",
          symbol: "SOL",
          decimals: 9,
          amount: "1000000000",
          formatted: "1",
          priceUsd: 200,
          valueUsd: 200,
        },
      ],
      spl: [],
      walletBalancesUsd: 200,
    });

    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({
      wallet: WALLET,
      tronAddress: TRON_ADDR,
      solanaAddress: SOLANA_ADDR,
      period: "30d",
    });

    expect(r.endingValueUsd).toBe(610); // 400 + 10 + 200
    const chains = r.perChain.map((s) => s.chain).sort();
    expect(chains).toContain("ethereum");
    expect(chains).toContain("tron");
    expect(chains).toContain("solana");
    // Per-chain endingValues sum to top-level.
    const sumEnding = r.perChain.reduce((s, c) => s + c.endingValueUsd, 0);
    expect(sumEnding).toBeCloseTo(r.endingValueUsd, 2);
  });
});

describe("getPnlSummary — truncation propagation", () => {
  it("sets summary.truncated when any chain hit the history cap", async () => {
    getTransactionHistoryMock.mockImplementation(async (a: { chain: string }) => ({
      chain: a.chain,
      wallet: WALLET,
      items: [],
      truncated: a.chain === "ethereum",
      priceCoverage: "full",
    }));
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });
    expect(r.truncated).toBe(true);
  });
});

describe("getPnlSummary — partial price coverage", () => {
  it("downgrades priceCoverage to 'partial' when DefiLlama misses", async () => {
    fetchNativeBalanceMock.mockImplementation(async (_w: string, chain: string) => {
      if (chain === "ethereum") {
        return {
          token: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          amount: "1000000000000000000",
          formatted: "1.0",
          priceUsd: 4400,
          valueUsd: 4400,
        };
      }
      return emptyNative(_w, chain);
    });
    lookupHistoricalPricesMock.mockResolvedValue({
      prices: new Map(),
      missed: true,
    });
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });
    expect(r.priceCoverage).toBe("partial");
  });
});

describe("getPnlSummary — inception period", () => {
  it("resolves inception to a ~365-day rolling window (not 'since creation')", async () => {
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "inception" });
    const startMs = new Date(r.periodStartIso).getTime();
    const endMs = new Date(r.periodEndIso).getTime();
    const spanDays = (endMs - startMs) / 86_400_000;
    // Allow ~2-second drift between the test's clock and the function's.
    expect(spanDays).toBeGreaterThan(364.99);
    expect(spanDays).toBeLessThan(365.01);
  });
});

describe("getPnlSummary — notes carry v1 caveats", () => {
  it("surfaces DeFi-exclusion and gas-exclusion caveats", async () => {
    const { getPnlSummary } = await import("../src/modules/pnl/index.ts");
    const r = await getPnlSummary({ wallet: WALLET, period: "30d" });
    const joined = r.notes.join("\n").toLowerCase();
    expect(joined).toContain("defi");
    expect(joined).toContain("gas");
  });
});
