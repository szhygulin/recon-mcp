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
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: async () => {
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
  beforeEach(() => {
    vi.resetModules();
    // Bug 7 above mocks the compound module; clear that so we exercise the real reader.
    vi.doUnmock("../src/modules/compound/index.js");
  });
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

describe("Bug 9: Portfolio summary aggregates Compound alongside Aave", () => {
  // Live bug: user held 184874 cUSDCv3 but get_portfolio_summary showed $0 lending because
  // only Aave was wired into the aggregator. Fix wires getCompoundPositions in parallel
  // and merges into the `lending` bucket.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("includes Compound netValueUsd in lendingNetUsd and per-chain totals", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBalance: async () => 0n,
        multicall: async () => [],
        readContract: async () => {
          throw new Error("no data");
        },
      }),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 0,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });
    // Aave returns nothing; Compound returns one ethereum position worth $184874.
    vi.doMock("../src/modules/positions/index.js", () => ({
      getLendingPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
      getLpPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
    }));
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [
          {
            protocol: "compound-v3" as const,
            chain: "ethereum" as const,
            market: "cUSDCv3",
            marketAddress: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as `0x${string}`,
            baseSupplied: null,
            baseBorrowed: null,
            collateral: [],
            totalCollateralUsd: 0,
            totalDebtUsd: 0,
            totalSuppliedUsd: 184874,
            netValueUsd: 184874,
          },
        ],
      }),
    }));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum", "arbitrum"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>>;

    // Single-wallet summary → has a breakdown.
    const single = summary as Extract<typeof summary, { breakdown: unknown }>;
    expect(single.lendingNetUsd).toBe(184874);
    expect(single.perChain.ethereum).toBe(184874);
    expect(single.perChain.arbitrum).toBe(0);
    expect(single.totalUsd).toBe(184874);
    expect(single.breakdown.lending).toHaveLength(1);
    expect(single.breakdown.lending[0].protocol).toBe("compound-v3");
  });
});

describe("Bug 10: LiFi fee cost aggregation ignores amountUSD when it contradicts amount*priceUSD", () => {
  // Live session: a 100 USDC → Polygon bridge reported feeCostsUsd ≈ $249,940. LiFi
  // returned feeCosts[0].amountUSD as "249940000" (raw 6-decimal token units) while the
  // token price and amount said the real fee was ~$0.25. Reading amountUSD verbatim
  // inflated the number by 6 orders of magnitude. Fix: derive USD from amount + priceUSD
  // when both are available and clamp stated amountUSD that disagrees by more than 10×.
  beforeEach(() => {
    vi.resetModules();
    // Isolate from a dev-machine 1inch key so these tests don't hit the network.
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("prefers amount*priceUSD over amountUSD when amountUSD is raw-units-shaped", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "polygon-pos-bridge",
        action: {
          fromToken: { symbol: "USDC", decimals: 6 },
          toToken: { symbol: "USDC.e", decimals: 6 },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          toAmount: "99750000",
          toAmountMin: "99500000",
          executionDuration: 1140,
          feeCosts: [
            {
              // The bug: amountUSD is actually raw token units. Derived USD (~$0.25) is
              // ~6 orders of magnitude smaller — must be preferred.
              amountUSD: "249940000",
              amount: "250000",
              token: { decimals: 6, priceUSD: "1" },
            },
          ],
          gasCosts: [
            {
              amountUSD: "0.14",
              amount: "50000000000000000",
              token: { decimals: 18, priceUSD: "2800" },
            },
          ],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async () => 6,
      }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "polygon",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      amount: "100",
    });

    // Fee should be $0.25 (the derived value), not $249,940,000.
    expect(quote.feeCostsUsd).toBeCloseTo(0.25, 2);
    // Gas stated USD ($0.14) roughly matches derived ($0.14), so we accept the stated value.
    expect(quote.gasCostsUsd).toBeCloseTo(0.14, 2);
  });

  it("falls back to amountUSD when token priceUSD is missing", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-dex",
        action: {
          fromToken: { symbol: "WETH", decimals: 18 },
          toToken: { symbol: "DAI", decimals: 18 },
          fromAmount: "1000000000000000000",
        },
        estimate: {
          fromAmount: "1000000000000000000",
          toAmount: "2800000000000000000000",
          toAmountMin: "2790000000000000000000",
          executionDuration: 30,
          feeCosts: [
            {
              amountUSD: "1.5",
              amount: "500000000000000",
              // No token.priceUSD → derivation impossible → trust amountUSD.
              token: { decimals: 18 },
            },
          ],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async () => 18,
      }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      amount: "1",
    });
    expect(quote.feeCostsUsd).toBeCloseTo(1.5, 2);
  });
});

describe("Bug 11: LiFi toAmount scale check — re-derive displayed output when it implies >10× input USD", () => {
  // Live session: a 100 USDC → WBTC swap came back with toAmount=128815483595 at
  // 8 decimals — i.e. the tool claimed the user would receive 1288.15 WBTC for $100.
  // With WBTC priced around $70k, that implies ~$90M of output for $100 of input, which
  // is obviously an aggregator scaling bug. The MCP must not display that number
  // verbatim: instead re-derive toAmountExpected / toAmountMin from token prices and
  // attach a warning telling the caller not to sign a prepared tx built from this quote.
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/modules/compound/index.js");
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-derives toAmountExpected from prices and emits a warning when output USD >10× input USD", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-aggregator",
        action: {
          fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
          toToken: { symbol: "WBTC", decimals: 8, priceUSD: "70588" },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          // 128815483595 at 8 decimals = 1288.15483595 WBTC — the bug.
          toAmount: "128815483595",
          toAmountMin: "127527328759",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      amount: "100",
    });

    // Expected output derived from prices: 100 / 70588 ≈ 0.001416 WBTC.
    expect(Number(quote.toAmountExpected)).toBeCloseTo(100 / 70588, 6);
    // Min preserves the route's stated slippage ratio (~0.99).
    const ratio = 127527328759 / 128815483595;
    expect(Number(quote.toAmountMin)).toBeCloseTo((100 / 70588) * ratio, 6);
    // USD of output should be the input USD, not the inflated stated value.
    expect(quote.toAmountUsd).toBeCloseTo(100, 2);
    expect(quote.fromAmountUsd).toBeCloseTo(100, 2);
    // Warning must be present so the model/user doesn't sign a prepared tx built from this quote.
    expect(quote.warning).toBeDefined();
    expect(quote.warning).toMatch(/Do NOT sign/i);
  });

  it("passes the quote through unchanged when output USD is within a sane range of input USD", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-aggregator",
        action: {
          fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
          toToken: { symbol: "WBTC", decimals: 8, priceUSD: "70588" },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          // 0.001416 WBTC — the correct expected output.
          toAmount: "141600",
          toAmountMin: "140184",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      amount: "100",
    });

    expect(Number(quote.toAmountExpected)).toBeCloseTo(0.001416, 6);
    expect(quote.warning).toBeUndefined();
  });
});

describe("Feature: intra-chain swap quote compares LiFi against 1inch", () => {
  // Users often ask "is this the best price?" — for intra-chain swaps we can answer
  // by also quoting 1inch and returning a side-by-side comparison. The aggregator
  // with the higher output amount is flagged as `bestSource`; cross-chain swaps
  // skip 1inch entirely (it has no bridge support).
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const lifiQuoteBody = {
    tool: "uniswap",
    action: {
      fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { symbol: "WETH", decimals: 18, priceUSD: "3500" },
      fromAmount: "1000000000", // 1000 USDC
    },
    estimate: {
      fromAmount: "1000000000",
      // 1000 USDC at $3500/ETH = 0.2857 WETH. LiFi returns 0.2850 WETH.
      toAmount: "285000000000000000",
      toAmountMin: "284000000000000000",
      executionDuration: 30,
      feeCosts: [],
      gasCosts: [],
    },
  };

  it("flags 1inch as bestSource when its output exceeds LiFi's", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => ({
        // 1inch returns 0.2865 WETH — slightly better than LiFi.
        dstAmount: "286500000000000000",
        dstToken: { address: "0x0", symbol: "WETH", decimals: 18 },
        gas: 180000,
      }),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(quote.alternatives).toBeDefined();
    expect(quote.alternatives).toHaveLength(1);
    const alt = quote.alternatives![0] as { source: string; toAmountExpected: string; toAmountUsd?: number; gasEstimate?: number };
    expect(alt.source).toBe("1inch");
    expect(Number(alt.toAmountExpected)).toBeCloseTo(0.2865, 4);
    expect(alt.toAmountUsd).toBeCloseTo(0.2865 * 3500, 1);
    expect(alt.gasEstimate).toBe(180000);
    expect(quote.bestSource).toBe("1inch");
    // (0.2865 - 0.285) / 0.285 ≈ 0.526% better.
    expect(quote.savingsVsLifi!.outputDeltaPct).toBeCloseTo(0.526, 2);
    expect(quote.savingsVsLifi!.outputDeltaUsd).toBeCloseTo((0.2865 - 0.285) * 3500, 2);
  });

  it("flags LiFi as bestSource when 1inch's output is worse", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => ({
        // 1inch returns 0.2800 WETH — worse than LiFi's 0.285.
        dstAmount: "280000000000000000",
        dstToken: { address: "0x0", symbol: "WETH", decimals: 18 },
      }),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(quote.bestSource).toBe("lifi");
    expect(quote.savingsVsLifi!.outputDeltaPct).toBeLessThan(0);
  });

  it("skips 1inch entirely for cross-chain swaps", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      // Even with a key configured, cross-chain must not call 1inch.
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    const oneInchSpy = vi.fn();
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: oneInchSpy,
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "polygon",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      amount: "1000",
    });

    expect(oneInchSpy).not.toHaveBeenCalled();
    expect(quote.alternatives).toBeUndefined();
    expect(quote.bestSource).toBeUndefined();
    expect(quote.crossChain).toBe(true);
  });

  it("skips 1inch when no API key is configured", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    const oneInchSpy = vi.fn();
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: oneInchSpy,
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(oneInchSpy).not.toHaveBeenCalled();
    expect(quote.alternatives).toBeUndefined();
    expect(quote.bestSource).toBeUndefined();
  });

  it("surfaces a 1inch error as an alternatives entry without failing the whole quote", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => {
        throw new Error("1inch quote 401: Unauthorized");
      },
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    // LiFi result still present.
    expect(Number(quote.toAmountExpected)).toBeCloseTo(0.285, 3);
    expect(quote.alternatives).toHaveLength(1);
    const alt = quote.alternatives![0] as { source: string; error?: string };
    expect(alt.source).toBe("1inch");
    expect(alt.error).toMatch(/401/);
    // No bestSource when the comparison couldn't run.
    expect(quote.bestSource).toBeUndefined();
  });
});
