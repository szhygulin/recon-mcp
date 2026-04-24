/**
 * Issue #88 continuation: getCompoundPositions now runs a cheap exposure
 * probe (balanceOf + borrowBalanceOf across every market on a chain, in a
 * single multicall) before firing full per-market reads. Markets where
 * both base balances come back zero are skipped — the dominant RPC-cost
 * reduction for the common "wallet has no Compound exposure on this
 * chain" case that was previously hitting L2 Infura endpoints hard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";

describe("getCompoundPositions — exposure probe (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_COMPOUND_FULL_READ;
  });

  it("skips full reads entirely when the probe shows zero exposure on every market", async () => {
    // Arbitrum has 4 Compound markets in CONTRACTS. Probe = 4 markets × 2
    // calls = 8-entry multicall. All zeros → nothing to full-read.
    const multicall = vi
      .fn()
      .mockResolvedValueOnce(
        Array(8).fill({ status: "success", result: 0n }),
      );
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    expect(r.positions).toEqual([]);
    expect(r.errored).toBe(false);
    // Exactly ONE multicall on the chain — the probe. No follow-up
    // readMarketPosition multicalls because no market had exposure.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("full-reads only markets where the probe shows nonzero exposure", async () => {
    // Simulate: on arbitrum, market 0 has a supply balance, markets 1-3
    // are empty. Assert: the probe fires first, and a second multicall
    // fires ONLY for market 0 (readMarketPosition's 4-call shape). We
    // deliberately don't set up enough mocks for the full happy path
    // (metaCalls, pause reads, etc.) — the point of this test is the
    // dispatch, not the full read pipeline.
    const probeResult = [
      { status: "success", result: 1_000_000n }, // market 0 balanceOf
      { status: "success", result: 0n },          // market 0 borrowBalanceOf
      { status: "success", result: 0n }, // market 1
      { status: "success", result: 0n },
      { status: "success", result: 0n }, // market 2
      { status: "success", result: 0n },
      { status: "success", result: 0n }, // market 3
      { status: "success", result: 0n },
    ];
    const multicall = vi
      .fn()
      .mockResolvedValueOnce(probeResult)
      // Subsequent calls (readMarketPosition + downstream) may fire; we
      // let them fail silently via a generic failure shape. The test
      // asserts the dispatch, not full-pipeline success.
      .mockResolvedValue(
        Array(8).fill({ status: "failure", error: new Error("stub"), result: undefined }),
      );
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    await getCompoundPositions({ wallet: WALLET, chains: ["arbitrum"] });
    // Probe fires exactly once. Its contract list has 8 entries (4
    // markets × 2 calls) — distinguishes it from readMarketPosition's
    // 4-call shape.
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(8);
    // At least one follow-up call (readMarketPosition) fires for market 0.
    // If the probe had short-circuited the whole chain, there'd be exactly
    // one call total.
    expect(multicall.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The second call's contract list MUST be the 4-call readMarketPosition
    // shape — i.e. we went into the full-read path for market 0.
    expect(multicall.mock.calls[1][0].contracts).toHaveLength(4);
  });

  it("marks a market as errored when the probe entry for its balanceOf failed", async () => {
    // Real-world scenario from #88: Infura rate-limits the arbitrum probe
    // for one specific market's balanceOf. That specific market should be
    // surfaced as errored — not silently dropped as "no exposure".
    const rpcError = new Error("HTTP request failed. Status: 429");
    (rpcError as { shortMessage?: string }).shortMessage =
      "HTTP request failed. Status: 429";
    const multicall = vi.fn().mockResolvedValueOnce([
      { status: "failure", error: rpcError, result: undefined }, // market 0 balanceOf
      { status: "success", result: 0n },                          // market 0 borrowBalanceOf
      { status: "success", result: 0n }, // market 1 — no exposure
      { status: "success", result: 0n },
      { status: "success", result: 0n }, // market 2
      { status: "success", result: 0n },
      { status: "success", result: 0n }, // market 3
      { status: "success", result: 0n },
    ]);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    expect(r.errored).toBe(true);
    expect(r.erroredMarkets).toHaveLength(1);
    expect(r.erroredMarkets![0].chain).toBe("arbitrum");
    // Error message names the probe + underlying 429.
    expect(r.erroredMarkets![0].error).toMatch(/probe balanceOf/);
    expect(r.erroredMarkets![0].error).toMatch(/429/);
    // Only one multicall fired — the probe. No full reads on a chain
    // where every market either had zero exposure or a probe error.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("surfaces a whole-probe multicall rejection as errored-on-every-market-for-that-chain", async () => {
    // Different failure mode from a per-entry failure: the entire probe
    // multicall rejects (network error, endpoint down). We have no
    // exposure signal for any market on the chain, so coverage must
    // flag every one.
    const multicall = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    expect(r.errored).toBe(true);
    // Every market on arbitrum is errored — no exposure signal available.
    expect(r.erroredMarkets!.length).toBeGreaterThanOrEqual(4);
    expect(r.erroredMarkets!.every((e) => e.chain === "arbitrum")).toBe(true);
    expect(
      r.erroredMarkets!.every((e) => /probe multicall rejected/.test(e.error)),
    ).toBe(true);
  });

  it("caches probe results per (chain, wallet) so repeat portfolio calls skip the wire (#88 follow-up)", async () => {
    // Clear any prior cache entries leaking in from other tests (shared
    // module-scoped singleton). A fresh resetModules in beforeEach gets
    // a fresh cache — this is belt-and-suspenders.
    const { cache } = await import("../src/data/cache.js");
    cache.clear();
    const zeros = Array(8).fill({ status: "success", result: 0n });
    const multicall = vi.fn().mockResolvedValue(zeros);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    await getCompoundPositions({ wallet: WALLET, chains: ["arbitrum"] });
    await getCompoundPositions({ wallet: WALLET, chains: ["arbitrum"] });
    await getCompoundPositions({ wallet: WALLET, chains: ["arbitrum"] });
    // Critical assertion: the probe multicall fired exactly ONCE across
    // three back-to-back calls for the same (chain, wallet). Without the
    // cache, each call would re-probe — 3× the RPC pressure.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("honors VAULTPILOT_COMPOUND_FULL_READ=1 (escape hatch for pure-collateral wallets)", async () => {
    // A wallet with collateral-only exposure (no base balance) would be
    // invisible to the probe. The env var bypasses the probe and falls
    // back to the pre-#88 full-read-every-market behavior.
    process.env.VAULTPILOT_COMPOUND_FULL_READ = "1";
    const multicall = vi.fn().mockResolvedValue([
      { status: "failure", error: new Error("stub"), result: undefined },
      { status: "success", result: 0n },
      { status: "success", result: 0n },
      { status: "success", result: 0n },
    ]);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    // With the env var, readMarketPosition runs for every market. 4
    // markets → 4 full-read multicalls (baseToken/numAssets/balanceOf/
    // borrowBalanceOf). No probe.
    expect(multicall.mock.calls.length).toBeGreaterThanOrEqual(4);
    // The first call's contract list is the 4-call readMarketPosition
    // shape, NOT the 8-call probe shape — confirms we took the bypass.
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(4);
    expect(r.errored).toBe(true);
  });
});
