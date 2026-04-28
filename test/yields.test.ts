/**
 * Tests for the `compare_yields` composer + supporting modules.
 * Plan: claude-work/HIGH-plan-yield-aggregator.md.
 *
 * Strategy:
 *   - asset-map / aprToApy are pure → directly tested.
 *   - composer is tested via vi.doMock'd adapters + risk-score so we can
 *     assert ranking, filtering, empty-result behavior, and the
 *     `unavailable` envelope without standing up real RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAsset,
  expandStables,
  DEFAULT_YIELDS_CHAINS,
} from "../src/modules/yields/asset-map.js";
import { aprToApy } from "../src/modules/yields/types.js";

describe("asset-map", () => {
  describe("resolveAsset", () => {
    it("USDC on ethereum resolves to the canonical Circle USDC contract", () => {
      const a = resolveAsset("USDC", "ethereum");
      expect(a?.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      expect(a?.decimals).toBe(6);
      expect(a?.symbol).toBe("USDC");
    });

    it("USDC on solana resolves to the canonical SPL mint", () => {
      const a = resolveAsset("USDC", "solana");
      expect(a?.address).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(a?.decimals).toBe(6);
    });

    it("ETH on EVM resolves to WETH and flags isWrappedNative", () => {
      const a = resolveAsset("ETH", "ethereum");
      expect(a?.address).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
      expect(a?.isWrappedNative).toBe(true);
    });

    it("SOL on solana is native (address: null) — lending uses native form", () => {
      const a = resolveAsset("SOL", "solana");
      expect(a?.address).toBeNull();
      expect(a?.symbol).toBe("SOL");
      expect(a?.decimals).toBe(9);
    });

    it("returns null for asset/chain combos that don't exist", () => {
      expect(resolveAsset("SOL", "ethereum")).toBeNull();
      expect(resolveAsset("ETH", "solana")).toBeNull();
      expect(resolveAsset("BTC", "solana")).toBeNull();
      expect(resolveAsset("USDC", "tron")).toBeNull();
    });

    it("returns null for the 'stables' meta-asset (caller must expand)", () => {
      expect(resolveAsset("stables", "ethereum")).toBeNull();
    });
  });

  describe("expandStables", () => {
    it("expands 'stables' to USDC + USDT", () => {
      expect(expandStables()).toEqual(["USDC", "USDT"]);
    });
  });

  describe("DEFAULT_YIELDS_CHAINS", () => {
    it("includes all EVM mainnets and solana, but not BTC/LTC", () => {
      expect(DEFAULT_YIELDS_CHAINS).toContain("ethereum");
      expect(DEFAULT_YIELDS_CHAINS).toContain("arbitrum");
      expect(DEFAULT_YIELDS_CHAINS).toContain("polygon");
      expect(DEFAULT_YIELDS_CHAINS).toContain("base");
      expect(DEFAULT_YIELDS_CHAINS).toContain("optimism");
      expect(DEFAULT_YIELDS_CHAINS).toContain("solana");
    });
  });
});

describe("aprToApy", () => {
  it("converts simple APR to continuously-compounded APY", () => {
    // 5% APR → ~5.127% APY (e^0.05 - 1 ≈ 0.05127)
    const apy = aprToApy(0.05);
    expect(apy).toBeGreaterThan(0.05);
    expect(apy).toBeLessThan(0.052);
  });

  it("zero APR → zero APY", () => {
    expect(aprToApy(0)).toBe(0);
  });
});

describe("compareYields composer", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  /**
   * Helper: stand up a fake `compareYields` with mocked adapters + risk-score.
   * `aaveRows` / `compoundRows` / `lidoRows` are returned verbatim from each
   * adapter mock; the composer adds risk score enrichment, filters, and ranks.
   */
  async function withMocks(opts: {
    aave?: { rows: any[]; unavailable?: any[] };
    compound?: { rows: any[]; unavailable?: any[] };
    lido?: { rows: any[]; unavailable?: any[] };
    defillama?: { rows: any[]; unavailable?: any[] };
    marginfi?: { rows: any[]; unavailable?: any[] };
    riskScores?: Record<string, number | undefined>;
  }) {
    vi.doMock("../src/modules/yields/adapters/aave.js", () => ({
      readAaveYields: vi
        .fn()
        .mockResolvedValue(opts.aave ?? { rows: [], unavailable: [] }),
    }));
    vi.doMock("../src/modules/yields/adapters/compound.js", () => ({
      readCompoundYields: vi
        .fn()
        .mockResolvedValue(opts.compound ?? { rows: [], unavailable: [] }),
    }));
    vi.doMock("../src/modules/yields/adapters/lido.js", () => ({
      readLidoYields: vi
        .fn()
        .mockResolvedValue(opts.lido ?? { rows: [], unavailable: [] }),
    }));
    vi.doMock("../src/modules/yields/adapters/defillama.js", () => ({
      readDefiLlamaYields: vi
        .fn()
        .mockResolvedValue(opts.defillama ?? { rows: [], unavailable: [] }),
    }));
    vi.doMock("../src/modules/yields/adapters/marginfi.js", () => ({
      readMarginfiYields: vi
        .fn()
        .mockResolvedValue(opts.marginfi ?? { rows: [], unavailable: [] }),
    }));
    vi.doMock("../src/modules/security/risk-score.js", () => ({
      getProtocolRiskScore: vi.fn(async (slug: string) => ({
        protocol: slug,
        score: opts.riskScores?.[slug],
        breakdown: {},
        raw: { hasBugBounty: false },
      })),
    }));
    // Disable the cache-remember wrap so tests are deterministic across runs
    // — every call hits the real `compareYieldsImpl`. Cache correctness is
    // tested separately via the existing cache module's own tests.
    vi.doMock("../src/data/cache.js", () => ({
      cache: {
        remember: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
        get: () => undefined,
        set: () => {},
      },
    }));
    return import("../src/modules/yields/index.js");
  }

  it("ranks rows by supplyApr descending across all adapters", async () => {
    const { compareYields } = await withMocks({
      aave: {
        rows: [
          { protocol: "aave-v3", chain: "ethereum", market: "USDC", supplyApr: 0.04, supplyApy: 0.041, tvl: null, riskScore: null },
        ],
      },
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.06, supplyApy: 0.062, tvl: null, riskScore: null },
        ],
      },
      lido: { rows: [] },
    });
    const out = await compareYields({ asset: "USDC" });
    expect(out.rows.map((r: any) => r.protocol)).toEqual([
      "compound-v3",
      "aave-v3",
    ]);
  });

  it("enriches each row with riskScore from getProtocolRiskScore", async () => {
    const { compareYields } = await withMocks({
      aave: {
        rows: [
          { protocol: "aave-v3", chain: "ethereum", market: "USDC", supplyApr: 0.05, supplyApy: 0.051, tvl: null, riskScore: null },
        ],
      },
      riskScores: { "aave-v3": 87 },
    });
    const out = await compareYields({ asset: "USDC" });
    expect(out.rows[0].riskScore).toBe(87);
  });

  it("filters out rows below `riskCeiling` (rows with null score are KEPT)", async () => {
    const { compareYields } = await withMocks({
      aave: {
        rows: [
          { protocol: "aave-v3", chain: "ethereum", market: "USDC", supplyApr: 0.05, supplyApy: 0.051, tvl: null, riskScore: null },
        ],
      },
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.06, supplyApy: 0.062, tvl: null, riskScore: null },
        ],
      },
      riskScores: { "aave-v3": 90, "compound-v3": 50 },
    });
    const out = await compareYields({ asset: "USDC", riskCeiling: 70 });
    expect(out.rows.map((r: any) => r.protocol)).toEqual(["aave-v3"]);
  });

  it("filters out rows below `minTvlUsd` (rows with null TVL are KEPT)", async () => {
    const { compareYields } = await withMocks({
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.06, supplyApy: 0.062, tvl: 1_000_000, riskScore: null },
          { protocol: "compound-v3", chain: "polygon", market: "cUSDCv3", supplyApr: 0.07, supplyApy: 0.072, tvl: 100_000, riskScore: null },
          { protocol: "compound-v3", chain: "arbitrum", market: "cUSDCv3", supplyApr: 0.08, supplyApy: 0.083, tvl: null, riskScore: null },
        ],
      },
    });
    const out = await compareYields({ asset: "USDC", minTvlUsd: 500_000 });
    // 100k row gets filtered out; null-tvl row is kept.
    const labels = out.rows.map((r: any) => `${r.chain}/${r.market}`);
    expect(labels).toContain("ethereum/cUSDCv3");
    expect(labels).toContain("arbitrum/cUSDCv3"); // null TVL kept
    expect(labels).not.toContain("polygon/cUSDCv3");
  });

  it("returns emptyResultReason when no rows match", async () => {
    const { compareYields } = await withMocks({});
    const out = await compareYields({ asset: "USDC" });
    expect(out.rows).toHaveLength(0);
    expect(out.emptyResultReason).toContain("No supply markets returned data");
  });

  it("returns emptyResultReason distinguishing 'all filtered out' vs 'no data'", async () => {
    const { compareYields } = await withMocks({
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.06, supplyApy: 0.062, tvl: 50_000, riskScore: null },
        ],
      },
      riskScores: { "compound-v3": 80 },
    });
    const out = await compareYields({ asset: "USDC", minTvlUsd: 1_000_000 });
    expect(out.rows).toHaveLength(0);
    expect(out.emptyResultReason).toContain("filtered out");
  });

  it("propagates adapter unavailable[] entries to the response", async () => {
    const { compareYields } = await withMocks({
      compound: {
        rows: [],
        unavailable: [
          { protocol: "compound-v3", chain: "ethereum", available: false, reason: "RPC down" },
        ],
      },
    });
    const out = await compareYields({ asset: "USDC", chains: ["ethereum"] });
    const compoundUnavail = out.unavailable.filter((u: any) => u.protocol === "compound-v3");
    expect(compoundUnavail).toHaveLength(1);
    expect(compoundUnavail[0].reason).toContain("RPC down");
  });

  it("surfaces remaining deferred protocols (EigenLayer / native-stake) in unavailable[]", async () => {
    const { compareYields } = await withMocks({});
    const out = await compareYields({ asset: "USDC" });
    const protocols = new Set(out.unavailable.map((u: any) => u.protocol));
    expect(protocols.has("eigenlayer")).toBe(true);
    expect(protocols.has("native-stake")).toBe(true);
    // MarginFi ships live via the on-chain adapter (#288). Morpho / Kamino /
    // Marinade / Jito ship live via the DefiLlama bundle (#287/#289/#290/#291).
    expect(protocols.has("marginfi")).toBe(false);
    expect(protocols.has("morpho-blue")).toBe(false);
    expect(protocols.has("kamino")).toBe(false);
    expect(protocols.has("marinade")).toBe(false);
    expect(protocols.has("jito")).toBe(false);
  });

  it("appends a notes[] warning to rows whose riskScore resolved to null (issue #542)", async () => {
    const { compareYields } = await withMocks({
      aave: {
        rows: [
          { protocol: "aave-v3", chain: "ethereum", market: "USDC", supplyApr: 0.05, supplyApy: 0.051, tvl: null, riskScore: null },
        ],
      },
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.06, supplyApy: 0.062, tvl: null, riskScore: null, notes: ["paused actions: supply"] },
        ],
      },
      // aave-v3 has no risk score (DefiLlama miss); compound-v3 does.
      riskScores: { "compound-v3": 80 },
    });
    const out = await compareYields({ asset: "USDC" });
    const aave = out.rows.find((r: any) => r.protocol === "aave-v3");
    const compound = out.rows.find((r: any) => r.protocol === "compound-v3");
    expect(aave?.riskScore).toBeNull();
    expect(aave?.notes ?? []).toEqual(
      expect.arrayContaining([
        expect.stringContaining("risk score unavailable"),
      ]),
    );
    // Populated riskScore → note NOT appended; adapter-emitted notes
    // (e.g. "paused actions: supply") are preserved verbatim.
    expect(compound?.riskScore).toBe(80);
    expect(compound?.notes).toEqual(["paused actions: supply"]);
  });

  it("expands 'stables' into USDC + USDT and queries adapters for both", async () => {
    const { compareYields } = await withMocks({
      compound: {
        rows: [
          { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.05, supplyApy: 0.051, tvl: 100, riskScore: null },
        ],
      },
    });
    const out = await compareYields({ asset: "stables" });
    expect(out.expandedAssets).toEqual(["USDC", "USDT"]);
  });
});
