/**
 * Unit tests for the BTC/LTC base-layer chain-health signals (issue #236
 * v1) + the multi-mode dispatcher contract (#236/#238/#242).
 *
 * Strategy:
 *   - per-signal arithmetic is tested against constructed block arrays /
 *     tip ages — pure-function eval; no network mock needed.
 *   - dispatcher routing is tested by intercepting each chain-mode handler
 *     with `vi.doMock` to return a synthetic payload, then asserting the
 *     dispatcher returns it untouched.
 *   - schema additions are tested by parsing inputs with the live Zod
 *     schema, locking the new protocol enum + `wallet` field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { __test as utxoSignals } from "../src/modules/incidents/chain-utxo.js";
import { getMarketIncidentStatusInput } from "../src/modules/incidents/schemas.js";

describe("schemas — multi-mode protocol enum", () => {
  it("accepts every v1 protocol value", () => {
    for (const p of [
      "compound-v3",
      "aave-v3",
      "bitcoin",
      "litecoin",
      "solana",
      "tron",
      "solana-protocols",
    ]) {
      const parsed = getMarketIncidentStatusInput.parse({ protocol: p });
      expect(parsed.protocol).toBe(p);
    }
  });

  it("rejects out-of-set protocols", () => {
    expect(() =>
      getMarketIncidentStatusInput.parse({ protocol: "morpho-blue" }),
    ).toThrow();
  });

  it("accepts an optional wallet (used by solana-protocols)", () => {
    const parsed = getMarketIncidentStatusInput.parse({
      protocol: "solana-protocols",
      wallet: "DEMo1111111111111111111111111111111111111111",
    });
    expect(parsed.wallet).toMatch(/^DEMo/);
  });
});

describe("evalTipStaleness", () => {
  it("flags when ageSeconds > 3× target", () => {
    // BTC: 600s target → flag at > 1800s
    expect(utxoSignals.evalTipStaleness(1801, 600)).toMatchObject({
      available: true,
      flagged: true,
    });
    // LTC: 150s target → flag at > 450s
    expect(utxoSignals.evalTipStaleness(451, 150)).toMatchObject({
      available: true,
      flagged: true,
    });
  });

  it("does NOT flag at or below the threshold", () => {
    expect(utxoSignals.evalTipStaleness(1800, 600)).toMatchObject({ flagged: false });
    expect(utxoSignals.evalTipStaleness(0, 600)).toMatchObject({ flagged: false });
  });
});

describe("evalHashCliff", () => {
  it("flags when observed mean interval > 1.5× target", () => {
    // 4 BTC blocks at +1000s intervals (≈ 1000s mean, > 1.5×600=900) → flagged.
    const blocks = [
      { timestamp: 4000 },
      { timestamp: 3000 },
      { timestamp: 2000 },
      { timestamp: 1000 },
    ];
    expect(utxoSignals.evalHashCliff(blocks, 600)).toMatchObject({
      available: true,
      flagged: true,
    });
  });

  it("does NOT flag when intervals are at or near target", () => {
    // 4 LTC blocks at exactly target intervals (150s).
    const blocks = [
      { timestamp: 600 },
      { timestamp: 450 },
      { timestamp: 300 },
      { timestamp: 150 },
    ];
    expect(utxoSignals.evalHashCliff(blocks, 150)).toMatchObject({ flagged: false });
  });

  it("returns available:false on degenerate input (< 2 blocks)", () => {
    expect(utxoSignals.evalHashCliff([], 600)).toMatchObject({
      available: false,
    });
    expect(utxoSignals.evalHashCliff([{ timestamp: 1 }], 600)).toMatchObject({
      available: false,
    });
  });
});

describe("evalEmptyBlockStreak", () => {
  it("flags when ≥ 3 consecutive coinbase-only blocks", () => {
    const blocks = [
      { txCount: 1, height: 5, hash: "h5" },
      { txCount: 1, height: 4, hash: "h4" },
      { txCount: 1, height: 3, hash: "h3" },
      { txCount: 100, height: 2, hash: "h2" },
      { txCount: 200, height: 1, hash: "h1" },
    ];
    const result = utxoSignals.evalEmptyBlockStreak(blocks);
    expect(result).toMatchObject({
      available: true,
      flagged: true,
      detail: { maxConsecutive: 3, startHeight: 5 },
    });
  });

  it("does NOT flag a 2-block streak", () => {
    const blocks = [
      { txCount: 1, height: 5, hash: "h5" },
      { txCount: 1, height: 4, hash: "h4" },
      { txCount: 100, height: 3, hash: "h3" },
    ];
    expect(utxoSignals.evalEmptyBlockStreak(blocks)).toMatchObject({
      flagged: false,
      detail: { maxConsecutive: 2 },
    });
  });

  it("treats txCount=0 as empty (some indexers report 0 instead of 1)", () => {
    const blocks = [
      { txCount: 0, height: 3, hash: "h3" },
      { txCount: 0, height: 2, hash: "h2" },
      { txCount: 0, height: 1, hash: "h1" },
    ];
    expect(utxoSignals.evalEmptyBlockStreak(blocks)).toMatchObject({
      flagged: true,
      detail: { maxConsecutive: 3 },
    });
  });
});

describe("evalMinerConcentration", () => {
  it("flags when one pool owns > 51% of the recent window (well-tagged)", () => {
    // 144 blocks, 100 from "Foundry" (69%), 44 split: 22+22 across two pools
    const blocks: { poolName?: string }[] = [];
    for (let i = 0; i < 100; i++) blocks.push({ poolName: "Foundry" });
    for (let i = 0; i < 22; i++) blocks.push({ poolName: "AntPool" });
    for (let i = 0; i < 22; i++) blocks.push({ poolName: "F2Pool" });
    expect(utxoSignals.evalMinerConcentration(blocks)).toMatchObject({
      available: true,
      flagged: true,
      detail: { topPool: "Foundry" },
    });
  });

  it("does NOT flag at or below 51% threshold (strict >)", () => {
    // 144 total, top pool 73/144 = 50.7% — under threshold.
    const blocks: { poolName?: string }[] = [];
    for (let i = 0; i < 71; i++) blocks.push({ poolName: "AntPool" });
    for (let i = 0; i < 73; i++) blocks.push({ poolName: "Foundry" });
    expect(utxoSignals.evalMinerConcentration(blocks)).toMatchObject({
      flagged: false,
    });
  });

  it("returns available:false when fewer than half the blocks are tagged", () => {
    // 144 blocks; only 50 have a poolName — too few to compute reliably
    const blocks: { poolName?: string }[] = [];
    for (let i = 0; i < 50; i++) blocks.push({ poolName: "Foundry" });
    for (let i = 0; i < 94; i++) blocks.push({});
    expect(utxoSignals.evalMinerConcentration(blocks)).toMatchObject({
      available: false,
    });
  });
});

describe("rpcGatedSignals — unconfigured RPC fallback (issue #248)", () => {
  it("includes all three RPC-gated signals as available:false when env var unset", async () => {
    const sigs = await utxoSignals.rpcGatedSignalsUnconfigured("BITCOIN_RPC_URL");
    const names = sigs.map((s) => s.name);
    expect(names).toEqual(["deep_reorg", "indexer_divergence", "mempool_anomaly"]);
    for (const s of sigs) {
      expect(s).toMatchObject({ available: false });
      // Reason must point to the right env var + cite the new issue ref so
      // the agent can give the user actionable setup guidance.
      expect((s as { reason: string }).reason).toMatch(/BITCOIN_RPC_URL/);
      expect((s as { reason: string }).reason).toMatch(/#248/);
    }
  });

  it("uses the chain-specific env var name in the unavailable reason for LTC", async () => {
    const sigs = await utxoSignals.rpcGatedSignalsUnconfigured("LITECOIN_RPC_URL");
    for (const s of sigs) {
      expect((s as { reason: string }).reason).toMatch(/LITECOIN_RPC_URL/);
    }
  });
});

describe("dispatcher — routes each protocol to its handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("routes 'bitcoin' to getBitcoinChainHealthSignals", async () => {
    vi.doMock("../src/modules/incidents/chain-utxo.js", async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        getBitcoinChainHealthSignals: async () => ({
          protocol: "bitcoin",
          chain: "bitcoin",
          tipHeight: 1,
          tipHash: "h",
          tipTimestamp: 1,
          tipAgeSeconds: 0,
          incident: false,
          signals: [],
        }),
      };
    });
    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    const result = await getMarketIncidentStatus({
      protocol: "bitcoin",
      chain: "ethereum",
    });
    expect(result.protocol).toBe("bitcoin");
  });

  it("routes 'solana' to getSolanaChainHealthSignals", async () => {
    vi.doMock("../src/modules/incidents/chain-solana.js", async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        getSolanaChainHealthSignals: async () => ({
          protocol: "solana",
          chain: "solana",
          tipSlot: 1,
          tipBlockTime: null,
          tipAgeSeconds: null,
          incident: false,
          rpcEndpoint: "demo",
          signals: [],
        }),
      };
    });
    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    const result = await getMarketIncidentStatus({
      protocol: "solana",
      chain: "ethereum",
    });
    expect(result.protocol).toBe("solana");
  });

  it("routes 'tron' to getTronChainHealthSignals", async () => {
    vi.doMock("../src/modules/incidents/chain-tron.js", async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        getTronChainHealthSignals: async () => ({
          protocol: "tron",
          chain: "tron",
          tipBlock: 1,
          tipBlockTimestamp: 1,
          tipAgeSeconds: 0,
          incident: false,
          signals: [],
        }),
      };
    });
    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    const result = await getMarketIncidentStatus({
      protocol: "tron",
      chain: "ethereum",
    });
    expect(result.protocol).toBe("tron");
  });

  it("routes 'solana-protocols' with the wallet arg threaded through", async () => {
    let receivedWallet: string | undefined = "INITIAL";
    vi.doMock("../src/modules/incidents/chain-solana.js", async (importOriginal) => {
      const orig = (await importOriginal()) as Record<string, unknown>;
      return {
        ...orig,
        getSolanaProgramLayerSignals: async (w?: string) => {
          receivedWallet = w;
          return {
            protocol: "solana-protocols",
            chain: "solana",
            scannedPrograms: [],
            scannedFeeds: [],
            walletScopeApplied: false,
            incident: false,
            signals: [],
          };
        },
      };
    });
    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    await getMarketIncidentStatus({
      protocol: "solana-protocols",
      chain: "ethereum",
      wallet: "WalletABC",
    });
    expect(receivedWallet).toBe("WalletABC");
  });
});
