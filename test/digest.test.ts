/**
 * Unit tests for `get_daily_briefing`. Mocks the four composer entry
 * points (getPortfolioSummary / getPortfolioDiff / getHealthAlerts /
 * getTransactionHistory) so no RPC / no DefiLlama / no indexer is hit.
 *
 * Coverage:
 *   - Composer assembles structured envelope correctly with each section
 *   - Top-movers sort by |abs change|, capped at 3, dust filtered
 *   - HF<1.5 surfaces with capitalized prefix in narrative
 *   - Empty wallet → coherent "you have nothing yet" response
 *   - Sub-call failure → notes appended, briefing still rendered
 *   - Activity classifier: methodName-based action types win over directional
 *   - format="structured" omits narrative; format="narrative" thins envelope
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const portfolioSummaryMock = vi.fn();
const portfolioDiffMock = vi.fn();
const healthAlertsMock = vi.fn();
const transactionHistoryMock = vi.fn();

vi.mock("../src/modules/portfolio/index.js", () => ({
  getPortfolioSummary: (...a: unknown[]) => portfolioSummaryMock(...a),
}));
vi.mock("../src/modules/diff/index.js", () => ({
  getPortfolioDiff: (...a: unknown[]) => portfolioDiffMock(...a),
}));
vi.mock("../src/modules/positions/index.js", () => ({
  getHealthAlerts: (...a: unknown[]) => healthAlertsMock(...a),
}));
vi.mock("../src/modules/history/index.js", () => ({
  getTransactionHistory: (...a: unknown[]) => transactionHistoryMock(...a),
}));

import { getDailyBriefing } from "../src/modules/digest/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  portfolioSummaryMock.mockReset();
  portfolioDiffMock.mockReset();
  healthAlertsMock.mockReset();
  transactionHistoryMock.mockReset();
  // Defaults: empty results from each sub-tool. Individual tests
  // override what they care about.
  portfolioSummaryMock.mockResolvedValue({
    wallet: WALLET,
    chains: ["ethereum"],
    totalUsd: 0,
    walletBalancesUsd: 0,
    lendingNetUsd: 0,
    lpUsd: 0,
    stakingUsd: 0,
    perChain: {},
    breakdown: { native: [], erc20: [], lending: [], lp: [], staking: [] },
    coverage: {
      aave: { covered: true },
      compound: { covered: true },
      morpho: { covered: false },
      uniswapV3: { covered: true },
      staking: { covered: true },
      unpricedAssets: 0,
    },
  });
  portfolioDiffMock.mockResolvedValue({
    window: "24h",
    windowStartIso: "2026-04-25T00:00:00.000Z",
    windowEndIso: "2026-04-26T00:00:00.000Z",
    startingValueUsd: 0,
    endingValueUsd: 0,
    topLevelChangeUsd: 0,
    inflowsUsd: 0,
    outflowsUsd: 0,
    netFlowsUsd: 0,
    priceEffectUsd: 0,
    otherEffectUsd: 0,
    perChain: [],
    truncated: false,
    notes: [],
  });
  healthAlertsMock.mockResolvedValue({
    wallet: WALLET,
    threshold: 1.5,
    atRisk: [],
  });
  transactionHistoryMock.mockResolvedValue({
    chain: "ethereum",
    wallet: WALLET,
    items: [],
    truncated: false,
    priceCoverage: "none",
  });
});

describe("getDailyBriefing — composition", () => {
  it("assembles the structured envelope with each section", async () => {
    portfolioSummaryMock.mockResolvedValue({
      wallet: WALLET,
      chains: ["ethereum"],
      totalUsd: 12_500,
      walletBalancesUsd: 12_500,
      lendingNetUsd: 0,
      lpUsd: 0,
      stakingUsd: 0,
      perChain: {},
      breakdown: { native: [], erc20: [], lending: [], lp: [], staking: [] },
      coverage: {
        aave: { covered: true },
        compound: { covered: true },
        morpho: { covered: false },
        uniswapV3: { covered: true },
        staking: { covered: true },
        unpricedAssets: 0,
      },
    });
    portfolioDiffMock.mockResolvedValue({
      window: "24h",
      windowStartIso: "2026-04-25T00:00:00.000Z",
      windowEndIso: "2026-04-26T00:00:00.000Z",
      startingValueUsd: 12_000,
      endingValueUsd: 12_500,
      topLevelChangeUsd: 500,
      inflowsUsd: 0,
      outflowsUsd: 0,
      netFlowsUsd: 0,
      priceEffectUsd: 500,
      otherEffectUsd: 0,
      perChain: [
        {
          chain: "ethereum",
          startingValueUsd: 12_000,
          endingValueUsd: 12_500,
          topLevelChangeUsd: 500,
          inflowsUsd: 0,
          outflowsUsd: 0,
          netFlowsUsd: 0,
          priceEffectUsd: 500,
          otherEffectUsd: 0,
          perAsset: [
            {
              symbol: "ETH",
              token: "native",
              chain: "ethereum",
              startingQty: "5",
              endingQty: "5",
              startingValueUsd: 12_000,
              endingValueUsd: 12_500,
              priceEffectUsd: 500,
              quantityEffectUsd: 0,
              netFlowQty: "0",
              netFlowUsd: 0,
            },
          ],
          truncated: false,
        },
      ],
      truncated: false,
      notes: [],
    });
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "both",
    });
    expect(out.totals.currentUsd).toBe(12_500);
    expect(out.totals.changeUsd).toBe(500);
    expect(out.totals.changePct).toBeCloseTo(4.17, 1);
    expect(out.topMovers).toHaveLength(1);
    expect(out.topMovers[0].symbol).toBe("ETH");
    expect(out.topMovers[0].changeUsd).toBe(500);
    expect(out.bestStablecoinYield.available).toBe(false);
    expect(out.liquidationCalendar.available).toBe(false);
    expect(out.narrative).toBeDefined();
  });

  it("sorts top movers by absolute USD change and caps at 3, filtering dust", async () => {
    portfolioDiffMock.mockResolvedValue({
      window: "24h",
      windowStartIso: "2026-04-25T00:00:00.000Z",
      windowEndIso: "2026-04-26T00:00:00.000Z",
      startingValueUsd: 100_000,
      endingValueUsd: 100_000,
      topLevelChangeUsd: 0,
      inflowsUsd: 0,
      outflowsUsd: 0,
      netFlowsUsd: 0,
      priceEffectUsd: 0,
      otherEffectUsd: 0,
      perChain: [
        {
          chain: "ethereum",
          startingValueUsd: 100_000,
          endingValueUsd: 100_000,
          topLevelChangeUsd: 0,
          inflowsUsd: 0,
          outflowsUsd: 0,
          netFlowsUsd: 0,
          priceEffectUsd: 0,
          otherEffectUsd: 0,
          perAsset: [
            // 5 assets with mixed deltas; dust (0.2) must be filtered.
            row("WBTC", 50_000, 53_000),
            row("ETH", 30_000, 27_500),
            row("USDC", 10_000, 10_400),
            row("USDT", 9_999.5, 9_999.7),
            row("DUST", 0.5, 0.7),
          ],
          truncated: false,
        },
      ],
      truncated: false,
      notes: [],
    });
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "structured",
    });
    expect(out.topMovers).toHaveLength(3);
    expect(out.topMovers.map((m) => m.symbol)).toEqual(["WBTC", "ETH", "USDC"]);
    expect(out.topMovers[0].changeUsd).toBe(3_000);
    expect(out.topMovers[1].changeUsd).toBe(-2_500);
  });

  it("flags HF<1.5 in the narrative with a capitalized prefix", async () => {
    healthAlertsMock.mockResolvedValue({
      wallet: WALLET,
      threshold: 1.5,
      atRisk: [
        {
          chain: "ethereum",
          healthFactor: 1.18,
          collateralUsd: 50_000,
          debtUsd: 35_000,
          marginToLiquidation: 15.3,
        },
      ],
    });
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "both",
    });
    expect(out.healthAlerts.atRisk).toHaveLength(1);
    expect(out.narrative).toMatch(/LIQUIDATION RISK/);
    expect(out.narrative).toMatch(/HF 1\.18/);
    expect(out.narrative).toMatch(/15\.3% margin/);
  });

  it("returns a 'you have nothing yet' narrative for an empty wallet", async () => {
    // Defaults already empty; just confirm the renderer takes the
    // empty-wallet branch.
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "both",
    });
    expect(out.totals.currentUsd).toBe(0);
    expect(out.topMovers).toHaveLength(0);
    expect(out.narrative).toMatch(/You have nothing yet/);
    expect(out.narrative).not.toMatch(/Top movers/);
  });
});

describe("getDailyBriefing — failure tolerance", () => {
  it("appends a note and continues when getPortfolioSummary fails", async () => {
    portfolioSummaryMock.mockRejectedValue(
      new Error("RPC outage on Ethereum"),
    );
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "structured",
    });
    expect(out.notes.some((n) => n.startsWith("Portfolio total read failed"))).toBe(
      true,
    );
    // Briefing still rendered with whatever the diff returned.
    expect(out.totals.currentUsd).toBe(0);
  });

  it("appends a note when getPortfolioDiff fails AND falls back on totals from summary", async () => {
    portfolioSummaryMock.mockResolvedValue({
      wallet: WALLET,
      chains: ["ethereum"],
      totalUsd: 7_777,
      walletBalancesUsd: 7_777,
      lendingNetUsd: 0,
      lpUsd: 0,
      stakingUsd: 0,
      perChain: {},
      breakdown: { native: [], erc20: [], lending: [], lp: [], staking: [] },
      coverage: {
        aave: { covered: true },
        compound: { covered: true },
        morpho: { covered: false },
        uniswapV3: { covered: true },
        staking: { covered: true },
        unpricedAssets: 0,
      },
    });
    portfolioDiffMock.mockRejectedValue(new Error("DefiLlama timeout"));
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "structured",
    });
    expect(
      out.notes.some((n) => n.startsWith("Window-delta read failed")),
    ).toBe(true);
    expect(out.totals.currentUsd).toBe(7_777);
    expect(out.totals.changeUsd).toBe(0);
    expect(out.topMovers).toHaveLength(0);
  });
});

describe("getDailyBriefing — activity classification", () => {
  it("counts methodName-resolved swap/supply/borrow over received/sent", async () => {
    transactionHistoryMock.mockImplementation(async (input: { chain: string }) => {
      if (input.chain !== "ethereum") {
        return {
          chain: input.chain,
          wallet: WALLET,
          items: [],
          truncated: false,
          priceCoverage: "none",
        };
      }
      // Exactly five items on Ethereum: a swap, a supply, a repay,
      // a plain receive, a plain send. Total expected = 5.
      return {
        chain: "ethereum",
        wallet: WALLET,
        items: [
          {
            type: "external",
            hash: "0xa",
            timestamp: 0,
            from: WALLET,
            to: "0xrouter",
            status: "success",
            valueNative: "0",
            valueNativeFormatted: "0",
            methodName: "swapExactTokensForTokens",
          },
          {
            type: "external",
            hash: "0xb",
            timestamp: 0,
            from: WALLET,
            to: "0xaave",
            status: "success",
            valueNative: "0",
            valueNativeFormatted: "0",
            methodName: "supply",
          },
          {
            type: "external",
            hash: "0xc",
            timestamp: 0,
            from: WALLET,
            to: "0xaave",
            status: "success",
            valueNative: "0",
            valueNativeFormatted: "0",
            methodName: "repay",
          },
          {
            type: "token_transfer",
            hash: "0xd",
            timestamp: 0,
            from: "0xfriend",
            to: WALLET,
            status: "success",
            tokenAddress: "0xusdc",
            tokenSymbol: "USDC",
            tokenDecimals: 6,
            amount: "1000000",
            amountFormatted: "1",
          },
          {
            type: "token_transfer",
            hash: "0xe",
            timestamp: 0,
            from: WALLET,
            to: "0xfriend",
            status: "success",
            tokenAddress: "0xusdc",
            tokenSymbol: "USDC",
            tokenDecimals: 6,
            amount: "1000000",
            amountFormatted: "1",
          },
        ],
        truncated: false,
        priceCoverage: "none",
      };
    });

    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "structured",
    });
    expect(out.activity.total).toBe(5);
    expect(out.activity.swapped).toBe(1);
    expect(out.activity.supplied).toBe(1);
    expect(out.activity.repaid).toBe(1);
    expect(out.activity.received).toBe(1);
    expect(out.activity.sent).toBe(1);
    expect(out.activity.borrowed).toBe(0);
  });
});

describe("getDailyBriefing — format flag", () => {
  it("omits narrative when format === 'structured'", async () => {
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "structured",
    });
    expect(out.narrative).toBeUndefined();
  });

  it("returns narrative when format === 'narrative' and thins the envelope", async () => {
    const out = await getDailyBriefing({
      wallet: WALLET,
      period: "24h",
      format: "narrative",
    });
    expect(out.narrative).toBeDefined();
    expect(out.narrative!.length).toBeGreaterThan(0);
    // structured fields zeroed out
    expect(out.topMovers).toEqual([]);
    expect(out.activity.total).toBe(0);
    expect(out.healthAlerts.atRisk).toEqual([]);
  });
});

describe("getDailyBriefing — input validation", () => {
  it("throws when no address is provided", async () => {
    await expect(
      getDailyBriefing({ period: "24h", format: "both" }),
    ).rejects.toThrow(/At least one of/);
  });
});

// -------- helpers --------

function row(symbol: string, startUsd: number, endUsd: number) {
  return {
    symbol,
    token: symbol === "DUST" ? "0xdust" : "native",
    chain: "ethereum",
    startingQty: "1",
    endingQty: "1",
    startingValueUsd: startUsd,
    endingValueUsd: endUsd,
    priceEffectUsd: endUsd - startUsd,
    quantityEffectUsd: 0,
    netFlowQty: "0",
    netFlowUsd: 0,
  };
}
