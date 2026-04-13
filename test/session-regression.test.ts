import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAddress } from "viem";
import { CONTRACTS } from "../src/config/contracts.js";

/**
 * Regression tests that mirror the calls made during a live Claude Code session where
 * three production bugs were uncovered:
 *   1. EigenLayer delegationManager address failed viem's EIP-55 checksum validation.
 *   2. Aave V3 get_lending_positions crashed on Arbitrum because the UiPoolDataProvider
 *      struct shape had drifted (stable-rate fields removed in 3.2). Aggregate totals
 *      (HF, collateral, debt) come from Pool.getUserAccountData and were still valid —
 *      we should keep them and just skip the per-reserve breakdown.
 *   3. get_compound_positions failed when ANY market in the registry reverted — one bad
 *      market address blew up the entire call. Should be best-effort per market.
 *
 * These are unit-level regression tests: we mock the viem PublicClient so we don't need
 * a live RPC. Each test asserts the bug's specific failure mode is now handled.
 */

describe("Bug 1: all registered contract addresses have valid EIP-55 checksums", () => {
  // viem's readContract calls getAddress() on the `to` field and throws InvalidAddressError
  // if the checksum is wrong. Every address in our registry must round-trip through
  // getAddress(). This would have caught the EigenLayer `F37A` typo at test time.
  const walk = (obj: unknown, path: string[] = []): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    if (typeof obj === "string" && /^0x[0-9a-fA-F]{40}$/.test(obj)) {
      out.push([path.join("."), obj]);
    } else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        out.push(...walk(v, [...path, k]));
      }
    }
    return out;
  };

  const entries = walk(CONTRACTS);

  it("registry has at least a dozen addresses (sanity)", () => {
    expect(entries.length).toBeGreaterThan(12);
  });

  it.each(entries)("%s (%s) passes EIP-55 checksum", (_path, addr) => {
    // Passes if getAddress(addr) === addr. Throws otherwise.
    expect(getAddress(addr)).toBe(addr);
  });
});

describe("Bug 2: Aave lending returns aggregate-only when UiPoolDataProvider ABI drifts", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns aggregate position (HF, totals, LTV) even if getUserReservesData throws", async () => {
    // Mock getClient to return a client whose Pool.getUserAccountData succeeds but
    // UiPoolDataProvider reads throw (simulating ABI mismatch).
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        if (params.functionName === "getUserAccountData") {
          // [collateralBase, debtBase, availableBorrows, liqThreshold, ltv, healthFactor]
          // 10,000 USD collateral, 5,000 debt, 8250 bps liqThresh, 8000 LTV, HF=1.65e18.
          return [
            1_000_000_000_000n, // 10,000 * 1e8
            500_000_000_000n, // 5,000 * 1e8
            300_000_000_000n,
            8250n,
            8000n,
            1_650_000_000_000_000_000n, // 1.65e18
          ];
        }
        if (
          params.functionName === "getUserReservesData" ||
          params.functionName === "getReservesData"
        ) {
          throw new Error(
            `Bytes value "..." is not a valid boolean.` // mirrors real viem decode failure
          );
        }
        throw new Error(`unexpected call: ${params.functionName}`);
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const pos = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "arbitrum"
    );
    expect(pos).not.toBeNull();
    expect(pos!.totalCollateralUsd).toBe(10_000);
    expect(pos!.totalDebtUsd).toBe(5_000);
    expect(pos!.healthFactor).toBeCloseTo(1.65, 2);
    expect(pos!.ltv).toBe(8000);
    expect(pos!.liquidationThreshold).toBe(8250);
    // Per-reserve breakdown degraded to empty — acceptable fallback.
    expect(pos!.collateral).toEqual([]);
    expect(pos!.debt).toEqual([]);
  });

  it("returns null when the user has no Aave activity (totals are zero)", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        if (params.functionName === "getUserAccountData") {
          return [0n, 0n, 0n, 0n, 0n, 0n];
        }
        throw new Error("should not be called when totals are zero");
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const pos = await getAaveLendingPosition(
      "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      "ethereum"
    );
    expect(pos).toBeNull();
  });
});

describe("Bug 4: EigenLayer revert does not crash getStakingPositions", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns [] when StrategyManager.getDeposits reverts", async () => {
    // Regression: we previously called `stakerStrategyList(address)` — a signature that
    // doesn't exist (the public mapping's auto-getter is (address, uint256)), so the call
    // reverts with no data. Even after switching to the correct `getDeposits`, contract
    // upgrades or RPC flakiness shouldn't blow up the whole portfolio call.
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error(
          `The contract function "getDeposits" reverted.\nDetails: execution reverted`
        );
      }),
      multicall: vi.fn(),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getEigenLayerPositions } = await import("../src/modules/staking/eigenlayer.js");
    const positions = await getEigenLayerPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075"
    );
    expect(positions).toEqual([]);
  });

  it("returns [] when a user has no EigenLayer deposits (empty strategies array)", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getDeposits") {
          return [[], []]; // empty strategies + shares
        }
        if (params.functionName === "delegatedTo") {
          return "0x0000000000000000000000000000000000000000";
        }
        throw new Error(`unexpected: ${params.functionName}`);
      }),
      multicall: vi.fn(),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getEigenLayerPositions } = await import("../src/modules/staking/eigenlayer.js");
    const positions = await getEigenLayerPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075"
    );
    expect(positions).toEqual([]);
    expect(mockClient.multicall).not.toHaveBeenCalled();
  });
});

describe("Bug 3: Compound positions skip individual markets that revert", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns positions for healthy markets and silently skips failing ones", async () => {
    // Simulate a multicall batch of 4 reads per market: first market fails (one of the
    // four returns failure), second succeeds and shows a balance, third market has zero
    // balance and should be filtered out by the null-position check.
    let callCount = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callCount++;
        // All multicalls in this flow have exactly 4 contracts (baseToken, numAssets,
        // balanceOf, borrowBalanceOf) — except the metadata follow-up which has >=2.
        if (contracts.length === 4) {
          if (callCount === 1) {
            // Market 1: baseToken call reverts (bad address in registry).
            return [
              { status: "failure", error: new Error("returned no data") },
              { status: "success", result: 0 },
              { status: "success", result: 0n },
              { status: "success", result: 0n },
            ];
          }
          if (callCount === 2) {
            // Market 2: healthy with a supplied balance but no collateral assets.
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 0 }, // numAssets = 0
              { status: "success", result: 2_000_000_000n }, // 2000 USDC supplied
              { status: "success", result: 0n },
            ];
          }
          // Market 3+: wallet has no position.
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        // Metadata call: decimals, symbol for the base token (no collateral assets here).
        return [
          { status: "success", result: 6 },
          { status: "success", result: "USDC" },
        ];
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    // Price layer hits the network; stub it so tests are hermetic.
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const { positions } = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    // At least one healthy market with a position should come back. Failing markets silently
    // drop; empty markets drop via the null-filter.
    expect(positions.length).toBeGreaterThanOrEqual(1);
    expect(positions[0].baseSupplied?.symbol).toBe("USDC");
    expect(positions[0].baseSupplied?.formatted).toBe("2000");
  });
});

describe("Bug 4: RPC transport batching is opt-in (public endpoints mishandle batched POSTs)", () => {
  // We don't have a clean hook to intercept viem.http from inside the test runner, so
  // we assert directly on the source: batching must be env-gated, not unconditional.
  it("rpc.ts gates batching on RPC_BATCH env, with batch:false as default path", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/data/rpc.ts", import.meta.url), "utf8");
    expect(src).toMatch(/process\.env\.RPC_BATCH/);
    // Must NOT have an unconditional `batch: true,`
    expect(src).not.toMatch(/\bbatch:\s*true\s*,/);
  });
});

describe("Bug 5: Aave reader returns null on 0x / transient RPC failures (not throws)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("getAaveLendingPosition returns null when getPool returns 0x (simulated as throw)", async () => {
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const result = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toBeNull();
  });

  it("getAaveLendingPosition returns null when getUserAccountData returns 0x", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const result = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toBeNull();
  });
});

describe("Bug 6: Uniswap V3 reader returns [] on transient RPC failures (not throws)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns [] when NPM.balanceOf throws", async () => {
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
      multicall: vi.fn(async () => []),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getUniswapPositions } = await import("../src/modules/positions/uniswap.js");
    const result = await getUniswapPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toEqual([]);
  });
});

describe("Bug 7: Portfolio summary degrades gracefully when subqueries fail", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns a valid summary with zeroed sub-totals when Aave/LP/staking all throw", async () => {
    // Native + ERC-20 balance path still works; every position reader throws.
    const mockClient = {
      getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), // 1 ETH
      multicall: vi.fn(async () => []), // no ERC-20 positions
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 2000,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });
    // Force every position module to throw.
    vi.doMock("../src/modules/positions/index.js", () => ({
      getLendingPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
      getLpPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
    }));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>> & { walletBalancesUsd: number };

    // Native balance priced at $2000 should survive; the three position readers zero out.
    expect(summary.walletBalancesUsd).toBe(2000);
    expect(summary.lendingNetUsd).toBe(0);
    expect(summary.lpUsd).toBe(0);
    expect(summary.stakingUsd).toBe(0);
    expect(summary.totalUsd).toBe(2000);
  });
});

describe("Bug 8: Compound V3 reader surfaces base balance even when a getAssetInfo call fails", () => {
  // Reproduces the live-session bug where wallet C0f5...4075 had 184874 cUSDCv3
  // supplied but get_compound_positions returned an empty array. Root cause: the
  // downstream metaCalls multicall used allowFailure:false, so one flaky getAssetInfo
  // (out of ~8 collateral assets) threw → outer .catch(() => null) swallowed → the
  // whole healthy position disappeared. Fix: allowFailure:true everywhere downstream.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns the supplied base balance when one collateral's getAssetInfo reverts", async () => {
    let callIdx = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callIdx++;
        // Only simulate ONE market (ethereum cUSDCv3); ignore additional ones.
        if (contracts.length === 4) {
          if (callIdx === 1) {
            // Baseline reads: healthy base supply, 3 collateral assets declared.
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 3 },
              { status: "success", result: 184_874_394_340n },
              { status: "success", result: 0n },
            ];
          }
          // Any further market reads: empty so the outer loop filters them out.
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        // Meta multicall: decimals + symbol for base, then 3 getAssetInfo calls.
        // Simulate that the MIDDLE getAssetInfo reverts (the bug's trigger).
        if ((contracts[0] as { functionName: string }).functionName === "decimals") {
          return [
            { status: "success", result: 6 },
            { status: "success", result: "USDC" },
            {
              status: "success",
              result: { asset: "0xbe9895146f7AF43049ca1c1AE358B0541Ea49704" as const },
            },
            { status: "failure", error: new Error('returned no data ("0x")') },
            {
              status: "success",
              result: { asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as const },
            },
          ];
        }
        // Collateral balances multicall: 2 surviving assets * 3 calls each.
        // Both have zero balance → we just want to confirm base survives.
        return Array.from({ length: contracts.length }, (_, i) => {
          const mod = i % 3;
          if (mod === 0) return { status: "success", result: 0n };
          if (mod === 1) return { status: "success", result: 18 };
          return { status: "success", result: "COL" };
        });
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const { positions } = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    expect(positions.length).toBeGreaterThanOrEqual(1);
    const ethMarket = positions.find((p) => p.chain === "ethereum");
    expect(ethMarket).toBeDefined();
    expect(ethMarket!.baseSupplied?.symbol).toBe("USDC");
    expect(ethMarket!.baseSupplied?.formatted).toBe("184874.39434");
  });
});
