/**
 * Issue #88 continuation: multi-wallet portfolio fan-outs were still
 * 429ing even at cap=2 concurrency because N wallets × M chains = N×M
 * parallel Compound probe multicalls saturated free-tier Infura. The
 * batch prefetch collapses probes to ONE multicall per chain,
 * regardless of wallet count, and populates the per-wallet probe
 * cache so the downstream per-wallet fan-out hits the cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET_A = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";
const WALLET_B = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075";
const WALLET_C = "0x4f51950425824dBaC8F8Ec950aCCaCb54ec1F7CA";
const WALLET_D = "0xb4FA2eaF9a47BbD649E6F31C19E022914aaE573e";

describe("prefetchCompoundProbes — cross-wallet batch (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("issues exactly ONE multicall per chain regardless of wallet count", async () => {
    const multicall = vi.fn().mockImplementation(async ({ contracts }) => {
      // Respond with a success-zero for every contract entry so all
      // wallets land in the "no exposure" bucket, confirmed in the
      // cache. We don't care about the values here — only the call
      // count.
      return contracts.map(() => ({ status: "success", result: 0n }));
    });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchCompoundProbes } = await import(
      "../src/modules/compound/index.js"
    );
    await prefetchCompoundProbes(
      [WALLET_A, WALLET_B, WALLET_C, WALLET_D],
      ["arbitrum", "base"],
    );
    // Exactly 2 multicalls — one per chain, not 8 (4 wallets × 2 chains).
    expect(multicall).toHaveBeenCalledTimes(2);
    // Each multicall's contract list must span ALL wallets × all
    // markets × 2 calls. arbitrum has 4 markets → 4 × 4 × 2 = 32 calls.
    const arbCall = multicall.mock.calls.find(
      ([args]) =>
        (args as { contracts: unknown[] }).contracts.length === 4 * 4 * 2,
    );
    expect(arbCall).toBeDefined();
  });

  it("populates the per-wallet probe cache so subsequent probeCompoundMarkets calls skip the wire", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();
    const multicall = vi.fn().mockImplementation(async ({ contracts }) =>
      contracts.map(() => ({ status: "success", result: 0n })),
    );
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchCompoundProbes, getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );

    await prefetchCompoundProbes([WALLET_A, WALLET_B], ["arbitrum"]);
    // 1 batched prefetch multicall.
    expect(multicall).toHaveBeenCalledTimes(1);

    // Both wallets' per-wallet getCompoundPositions must reuse the
    // prefetched cache and NOT re-probe.
    await getCompoundPositions({ wallet: WALLET_A, chains: ["arbitrum"] });
    await getCompoundPositions({ wallet: WALLET_B, chains: ["arbitrum"] });
    // Still exactly 1 multicall — no new per-wallet probes fired.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("marks every (wallet, market) on a chain as errored when the batch multicall rejects", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();
    // Simulate: arbitrum probe fails wholesale (e.g. transport error,
    // ECONNRESET). The prefetch must still populate cache entries for
    // both wallets so their downstream getCompoundPositions reads see
    // the error rather than racing to issue fresh (still-failing)
    // probes of their own.
    const multicall = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchCompoundProbes, getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    await prefetchCompoundProbes([WALLET_A, WALLET_B], ["arbitrum"]);

    // Both wallets independently call getCompoundPositions. Each must
    // surface errored markets (populated by the failed prefetch),
    // WITHOUT firing its own probe multicall — the cache entry exists
    // even though its contents are all-errored.
    const rA = await getCompoundPositions({ wallet: WALLET_A, chains: ["arbitrum"] });
    const rB = await getCompoundPositions({ wallet: WALLET_B, chains: ["arbitrum"] });
    expect(rA.errored).toBe(true);
    expect(rB.errored).toBe(true);
    expect(rA.erroredMarkets!.every((e) => /probe multicall rejected/.test(e.error))).toBe(true);
    expect(rB.erroredMarkets!.every((e) => /probe multicall rejected/.test(e.error))).toBe(true);
    // CRITICAL: still only 1 multicall call — the rejected prefetch.
    // The per-wallet calls did NOT each re-issue their own probes and
    // re-hit the saturated RPC.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on empty wallet or empty chain lists (defensive)", async () => {
    const multicall = vi.fn();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchCompoundProbes } = await import(
      "../src/modules/compound/index.js"
    );
    await prefetchCompoundProbes([], ["arbitrum"]);
    await prefetchCompoundProbes([WALLET_A], []);
    expect(multicall).not.toHaveBeenCalled();
  });
});
