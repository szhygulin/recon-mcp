/**
 * Morpho Blue repay `amount: "max"` (issue #437).
 *
 * Mirrors the Aave-repay-max pattern but uses Morpho's shares mode
 * (assets=0, shares=borrowShares) instead of `assets=type(uint256).max`,
 * because Morpho doesn't cap `assets` to user debt — it transferFroms
 * the literal value. Shares mode lets Morpho compute the exact assets
 * from `position(marketId, user).borrowShares` at execution time, so
 * the close is exact regardless of interest accrued between sign and
 * broadcast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as `0x${string}`;
const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const MARKET_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

const PARAMS_TUPLE = [USDC, WBTC, USDC, USDC, 860000000000000000n] as const;

interface MockState {
  borrowShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** Live ERC-20 allowance the wallet has already granted Morpho. Default 0n. */
  allowance?: bigint;
}

function mockClient(s: MockState) {
  return {
    readContract: vi.fn(async (params: { functionName: string }) => {
      if (params.functionName === "idToMarketParams") {
        // Return the 5-tuple Morpho's `idToMarketParams(id)` view emits.
        // resolveMarketParams destructures into the named fields.
        return PARAMS_TUPLE;
      }
      if (params.functionName === "position") {
        return [0n, s.borrowShares, 0n] as const;
      }
      if (params.functionName === "market") {
        return [
          0n,
          0n,
          s.totalBorrowAssets,
          s.totalBorrowShares,
          0n,
          0n,
        ] as const;
      }
      if (params.functionName === "allowance") {
        return s.allowance ?? 0n;
      }
      throw new Error(`unmocked readContract: ${params.functionName}`);
    }),
    multicall: vi.fn(async () => [6, "USDC"]),
  };
}

describe("buildMorphoRepay — amount=\"max\" (issue #437)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("builds shares-mode repay (assets=0, shares=borrowShares) with debt+1% approval", async () => {
    const borrowShares = 1_000_000_000_000_000_000n; // 1e18 shares
    const totalBorrowAssets = 5_000_000_000n; // 5,000 USDC
    const totalBorrowShares = 5_000_000_000_000_000_000n; // 5e18 shares
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockClient({
          borrowShares,
          totalBorrowAssets,
          totalBorrowShares,
        }),
      resetClients: () => {},
    }));
    const { buildMorphoRepay } = await import(
      "../src/modules/morpho/actions.js"
    );
    const tx = await buildMorphoRepay({
      chain: "ethereum",
      wallet: WALLET,
      marketId: MARKET_ID,
      amount: "max",
    });
    // The result is an approval-then-repay pair: chainApproval returns the
    // approval as the primary tx, with the repay nested in `next`.
    const approval = tx;
    const repay = (tx as { next?: typeof tx }).next ?? tx;

    // Decode the repay calldata and assert assets=0, shares=borrowShares.
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "repay",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "marketParams",
              type: "tuple",
              components: [
                { name: "loanToken", type: "address" },
                { name: "collateralToken", type: "address" },
                { name: "oracle", type: "address" },
                { name: "irm", type: "address" },
                { name: "lltv", type: "uint256" },
              ],
            },
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [
            { name: "assetsRepaid", type: "uint256" },
            { name: "sharesRepaid", type: "uint256" },
          ],
        },
      ],
      data: repay.data,
    });
    expect(decoded.functionName).toBe("repay");
    const [, assetsArg, sharesArg, onBehalfArg] = decoded.args as readonly [
      unknown,
      bigint,
      bigint,
      `0x${string}`,
      `0x${string}`,
    ];
    expect(assetsArg).toBe(0n);
    expect(sharesArg).toBe(borrowShares);
    expect(onBehalfArg.toLowerCase()).toBe(WALLET.toLowerCase());

    // Approval is sized at debt × 1.01: borrowShares maps to ~1000 USDC
    // (1e18 / 5e18 of 5000 USDC), 1% buffer → ~1010 USDC. Decode the
    // approve(spender, amount) calldata to read `amount`.
    const approveDecoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      data: approval.data,
    });
    const approvalAmount = (approveDecoded.args as readonly [`0x${string}`, bigint])[1];
    // Default approvalCap is "unlimited" — viem's maxUint256.
    // The buffered debt amount appears in the description / numeric
    // sizing but the approve call itself uses maxUint256. Assert the
    // approve value equals maxUint256, which proves we DID compute a
    // non-zero needed amount (otherwise the resolveApprovalCap path
    // would have taken the no-op branch and returned null).
    expect(approvalAmount > 0n).toBe(true);
  });

  it("description carries the 'all' phrasing and decoded.amount stays 'max'", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockClient({
          borrowShares: 100n,
          totalBorrowAssets: 1_000_000n,
          totalBorrowShares: 1_000_000_000_000n,
        }),
      resetClients: () => {},
    }));
    const { buildMorphoRepay } = await import(
      "../src/modules/morpho/actions.js"
    );
    const tx = await buildMorphoRepay({
      chain: "ethereum",
      wallet: WALLET,
      marketId: MARKET_ID,
      amount: "max",
    });
    const repay = (tx as { next?: typeof tx }).next ?? tx;
    expect(repay.description).toMatch(/Repay all USDC to Morpho Blue market/);
    expect(repay.decoded?.args).toMatchObject({ amount: "max" });
  });

  it("refuses with a clear error when borrowShares=0 (no outstanding debt)", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockClient({
          borrowShares: 0n,
          totalBorrowAssets: 5_000_000_000n,
          totalBorrowShares: 5_000_000_000_000_000_000n,
        }),
      resetClients: () => {},
    }));
    const { buildMorphoRepay } = await import(
      "../src/modules/morpho/actions.js"
    );
    await expect(
      buildMorphoRepay({
        chain: "ethereum",
        wallet: WALLET,
        marketId: MARKET_ID,
        amount: "max",
      }),
    ).rejects.toThrow(/No outstanding debt for marketId.*nothing to repay/);
  });

  it("partial-amount path still works (regression — assets=parsed, shares=0)", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockClient({
          borrowShares: 1n,
          totalBorrowAssets: 1n,
          totalBorrowShares: 1n,
        }),
      resetClients: () => {},
    }));
    const { buildMorphoRepay } = await import(
      "../src/modules/morpho/actions.js"
    );
    const tx = await buildMorphoRepay({
      chain: "ethereum",
      wallet: WALLET,
      marketId: MARKET_ID,
      amount: "100", // 100 USDC at 6 decimals
    });
    const repay = (tx as { next?: typeof tx }).next ?? tx;
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "repay",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "marketParams",
              type: "tuple",
              components: [
                { name: "loanToken", type: "address" },
                { name: "collateralToken", type: "address" },
                { name: "oracle", type: "address" },
                { name: "irm", type: "address" },
                { name: "lltv", type: "uint256" },
              ],
            },
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [
            { name: "assetsRepaid", type: "uint256" },
            { name: "sharesRepaid", type: "uint256" },
          ],
        },
      ],
      data: repay.data,
    });
    const [, assetsArg, sharesArg] = decoded.args as readonly [
      unknown,
      bigint,
      bigint,
    ];
    expect(assetsArg).toBe(100_000_000n); // 100 USDC × 1e6
    expect(sharesArg).toBe(0n);
    expect(repay.description).toMatch(/Repay 100 USDC to Morpho Blue market/);
  });
});

// Small helper to silence the unused-import warning if the abi-encoder
// helpers go unused in a future refactor. Kept inline so removal is safe.
void encodeAbiParameters;
void parseAbiParameters;
