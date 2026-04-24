/**
 * Issue #88 continuation: Lido mainnet per-wallet multicalls were
 * contributing to Infura 429s on multi-wallet portfolio fan-outs.
 * prefetchLidoMainnet batches all wallets' stETH + wstETH balance reads
 * + the shared stEthPerToken constant into ONE ethereum multicall,
 * populating a raw-data cache that fetchLidoPositions' ethereum path
 * checks first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET_A = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";
const WALLET_B = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075";
const WALLET_C = "0x4f51950425824dBaC8F8Ec950aCCaCb54ec1F7CA";
const WALLET_D = "0xb4FA2eaF9a47BbD649E6F31C19E022914aaE573e";

describe("prefetchLidoMainnet — cross-wallet batch (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("issues ONE ethereum multicall containing stEthPerToken + all wallets' balanceOf pairs", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    // stEthPerToken = 1.2 stETH/wstETH (rough current rate, just needs
    // to be nonzero). Wallets: A has both, others empty.
    const multicall = vi.fn().mockResolvedValue([
      { status: "success", result: 1_200_000_000_000_000_000n }, // stEthPerToken
      // Wallet A
      { status: "success", result: 500_000_000_000_000_000n },   // stETH
      { status: "success", result: 0n },                          // wstETH
      // Wallet B
      { status: "success", result: 0n },
      { status: "success", result: 0n },
      // Wallet C
      { status: "success", result: 0n },
      { status: "success", result: 0n },
      // Wallet D
      { status: "success", result: 0n },
      { status: "success", result: 0n },
    ]);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));

    const { prefetchLidoMainnet } = await import(
      "../src/modules/staking/lido.js"
    );
    await prefetchLidoMainnet([WALLET_A, WALLET_B, WALLET_C, WALLET_D]);
    // Exactly ONE multicall, regardless of wallet count.
    expect(multicall).toHaveBeenCalledTimes(1);
    // Contract list has 1 stEthPerToken + 2 per wallet = 1 + 2*4 = 9.
    expect(
      (multicall.mock.calls[0][0] as { contracts: unknown[] }).contracts,
    ).toHaveLength(9);
    // Per-wallet raw cache entries are populated.
    const walletACache = cache.get<{
      stEthWei: bigint;
      wstEthWei: bigint;
      stEthPerToken: bigint;
    }>(`lido-raw-eth:${WALLET_A.toLowerCase()}`);
    expect(walletACache?.stEthWei).toBe(500_000_000_000_000_000n);
    expect(walletACache?.wstEthWei).toBe(0n);
    expect(walletACache?.stEthPerToken).toBe(1_200_000_000_000_000_000n);
  });

  it("fetchLidoPositions hits the raw-data cache and skips its own multicall", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    // Seed the cache directly — as if prefetch had already populated it.
    cache.set(
      `lido-raw-eth:${WALLET_A.toLowerCase()}`,
      {
        stEthWei: 1_000_000_000_000_000_000n, // 1 stETH
        wstEthWei: 0n,
        stEthPerToken: 1_200_000_000_000_000_000n,
      },
      60_000,
    );

    const multicall = vi.fn();
    const readContract = vi.fn();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall, readContract }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 3000, // ETH price, used to value stETH
    }));
    // yields fetch is also skipped by neutralizing it
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ));

    const { getLidoPositions } = await import(
      "../src/modules/staking/lido.js"
    );
    const positions = await getLidoPositions(WALLET_A, ["ethereum"]);
    // Position was computed from the cached raw data — zero RPC traffic.
    expect(multicall).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    // And the position is correct: 1 stETH with stEth-per-wst = 1.2 yields
    // 1 stETH total (no wstETH in this case).
    expect(positions).toHaveLength(1);
    expect(positions[0].protocol).toBe("lido");
    expect(positions[0].chain).toBe("ethereum");
    expect(positions[0].stakedAmount.amount).toBe("1000000000000000000");
  });

  it("falls back to the per-wallet multicall when the batch prefetch rejects (cache unpoisoned)", async () => {
    const { cache } = await import("../src/data/cache.js");
    cache.clear();

    const multicall = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchLidoMainnet } = await import(
      "../src/modules/staking/lido.js"
    );
    await prefetchLidoMainnet([WALLET_A, WALLET_B]);
    // Rejected prefetch → no cache entries (not stale/poisoned). The
    // per-wallet path will then re-attempt with its own multicall.
    expect(cache.get(`lido-raw-eth:${WALLET_A.toLowerCase()}`)).toBeUndefined();
    expect(cache.get(`lido-raw-eth:${WALLET_B.toLowerCase()}`)).toBeUndefined();
  });

  it("is a no-op on an empty wallet list", async () => {
    const multicall = vi.fn();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { prefetchLidoMainnet } = await import(
      "../src/modules/staking/lido.js"
    );
    await prefetchLidoMainnet([]);
    expect(multicall).not.toHaveBeenCalled();
  });
});
