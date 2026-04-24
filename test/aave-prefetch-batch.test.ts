/**
 * Issue #88 continuation: Aave per-wallet getUserAccountData reads
 * were contributing to free-tier Infura saturation on multi-wallet
 * portfolio fan-outs. prefetchAaveAccountData batches all wallets'
 * aggregate reads into ONE multicall per chain and populates the
 * per-wallet cache; downstream readAaveLendingPosition then hits the
 * cache rather than firing its own readContract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET_A = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";
const WALLET_B = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075";
const WALLET_C = "0x4f51950425824dBaC8F8Ec950aCCaCb54ec1F7CA";
const WALLET_D = "0xb4FA2eaF9a47BbD649E6F31C19E022914aaE573e";

describe("prefetchAaveAccountData — cross-wallet batch (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("issues ONE multicall per chain for N wallets (plus the cached pool-address resolve)", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    const readContract = vi
      .fn()
      .mockResolvedValue("0x1234000000000000000000000000000000000001"); // pool addr
    const multicall = vi
      .fn()
      .mockResolvedValue(
        Array(4).fill({
          status: "success",
          result: [0n, 0n, 0n, 0n, 0n, 0n] as const,
        }),
      );
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract, multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));

    const { prefetchAaveAccountData } = await import(
      "../src/modules/positions/aave.js"
    );
    await prefetchAaveAccountData(
      [WALLET_A, WALLET_B, WALLET_C, WALLET_D],
      ["ethereum"],
    );
    // Exactly ONE multicall per chain, containing 4 getUserAccountData
    // entries (one per wallet). Without this batch, 4 separate
    // readContract calls would have fired from the per-wallet path.
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(
      (multicall.mock.calls[0][0] as { contracts: unknown[] }).contracts,
    ).toHaveLength(4);
    // Pool address resolved exactly once (cached for the chain).
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("caches empty results so per-wallet readAaveLendingPosition short-circuits to null on subsequent calls", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    const readContract = vi
      .fn()
      .mockResolvedValue("0x1234000000000000000000000000000000000001");
    const multicall = vi.fn().mockResolvedValue([
      {
        status: "success",
        result: [0n, 0n, 0n, 0n, 0n, 0n] as const, // all zeros → empty position
      },
    ]);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract, multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchAaveAccountData, getAaveLendingPosition } = await import(
      "../src/modules/positions/aave.js"
    );
    await prefetchAaveAccountData([WALLET_A], ["ethereum"]);
    // Prefetch fired one multicall + one readContract (pool-addr resolve).
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledTimes(1);

    // Per-wallet call: the aggregate cache says "empty" — returns null
    // immediately, no new RPC traffic. This is the primary win for
    // wallets with no Aave exposure (the common case in a multi-wallet
    // portfolio).
    const position = await getAaveLendingPosition(WALLET_A, "ethereum");
    expect(position).toBeNull();
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("doesn't populate cache when the batch multicall rejects (falls back to per-wallet path)", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    const readContract = vi
      .fn()
      .mockResolvedValue("0x1234000000000000000000000000000000000001");
    const multicall = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract, multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchAaveAccountData } = await import(
      "../src/modules/positions/aave.js"
    );
    await prefetchAaveAccountData([WALLET_A, WALLET_B], ["ethereum"]);
    // Prefetch rejection must NOT leave stale/poisoned cache entries —
    // otherwise the per-wallet readAaveLendingPosition would reuse
    // stale data when the endpoint recovers. Verify cache miss.
    expect(cache.get(`aave-account:ethereum:${WALLET_A.toLowerCase()}`)).toBeUndefined();
    expect(cache.get(`aave-account:ethereum:${WALLET_B.toLowerCase()}`)).toBeUndefined();
  });

  it("is a no-op on empty wallets or empty chains (defensive)", async () => {
    const multicall = vi.fn();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchAaveAccountData } = await import(
      "../src/modules/positions/aave.js"
    );
    await prefetchAaveAccountData([], ["ethereum"]);
    await prefetchAaveAccountData([WALLET_A], []);
    expect(multicall).not.toHaveBeenCalled();
  });
});
