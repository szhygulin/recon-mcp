/**
 * Issue #88 root cause (Morpho/Lido branch): repeated event-log scans from
 * `discoverMorphoMarketIds` on mainnet saturated Infura free-tier rate
 * limits, causing both Morpho coverage and downstream Lido balance reads
 * (same RPC) to HTTP 429. The discovery result is now memoized per
 * `(chain, wallet)` for CACHE_TTL.MORPHO_DISCOVERY so a portfolio summary
 * called several times back-to-back hits the cache instead of re-scanning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cache } from "../src/data/cache.js";

const WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";

describe("discoverMorphoMarketIds — discovery cache (#88)", () => {
  beforeEach(() => {
    vi.resetModules();
    cache.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cache.clear();
  });

  it("caches discovery results per (chain, wallet), sparing the RPC on re-runs", async () => {
    // Thinnest client stub that still lets the scan run — one chunk.
    // getBlockNumber returns a block only slightly above deploymentBlock
    // so we complete in a single iteration, reducing the test's mocking
    // surface to exactly three getLogs calls (the critical counter).
    const getLogs = vi.fn().mockResolvedValue([]);
    const getBlockNumber = vi.fn().mockResolvedValue(18_883_124n + 5n);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBlockNumber,
        getLogs,
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));

    const { discoverMorphoMarketIds } = await import(
      "../src/modules/morpho/discover.js"
    );

    const first = await discoverMorphoMarketIds(WALLET, "ethereum");
    const second = await discoverMorphoMarketIds(WALLET, "ethereum");
    const third = await discoverMorphoMarketIds(WALLET, "ethereum");

    // Deep equality — the cached value is the same array reference each
    // time AND callers see identical contents.
    expect(first).toEqual(second);
    expect(second).toEqual(third);

    // Critical assertion: the scan ran ONCE. Without the cache, each call
    // would fan out 3 getLogs per chunk. With the cache, subsequent calls
    // bypass the scan entirely. The current impl scans a single chunk on
    // this mocked chain => exactly 3 getLogs invocations total.
    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it("uses separate cache entries per chain and per wallet", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const getBlockNumber = vi.fn().mockResolvedValue(18_883_124n + 5n);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBlockNumber,
        getLogs,
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { discoverMorphoMarketIds } = await import(
      "../src/modules/morpho/discover.js"
    );

    // Same wallet, different chain → new scan (even though base doesn't
    // have a Morpho deployment block configured, the call still happens
    // cleanly and short-circuits with []).
    await discoverMorphoMarketIds(WALLET, "ethereum");
    await discoverMorphoMarketIds(WALLET, "ethereum"); // cached
    // Different wallet, same chain → new scan (cache key differs).
    await discoverMorphoMarketIds(
      "0x000000000000000000000000000000000000dEaD",
      "ethereum",
    );

    // Two distinct (wallet, chain) pairs → two scans × 3 getLogs each = 6.
    expect(getLogs).toHaveBeenCalledTimes(6);
  });

  it("is case-insensitive on the wallet address so checksummed vs lowercase don't duplicate scans", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const getBlockNumber = vi.fn().mockResolvedValue(18_883_124n + 5n);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBlockNumber,
        getLogs,
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { discoverMorphoMarketIds } = await import(
      "../src/modules/morpho/discover.js"
    );
    await discoverMorphoMarketIds(WALLET, "ethereum");
    // Same address, all-lowercase — a caller that normalizes differently
    // shouldn't miss the cache.
    await discoverMorphoMarketIds(
      WALLET.toLowerCase() as `0x${string}`,
      "ethereum",
    );
    expect(getLogs).toHaveBeenCalledTimes(3);
  });
});
