/**
 * Tests for `buildUniswapIncrease` — the increaseLiquidity-side LP
 * builder, M1b in `claude-work/plan-dex-liquidity-provision.md`.
 * Mocks the RPC client surface so positions(tokenId) + ownerOf
 * + slot0 + factory.getPool all produce deterministic values; asserts
 * the calldata + approval chain.
 *
 * Key invariants exercised:
 *   - Happy path: positions() → known pair + ticks → mintAmountsWithSlippage
 *     → increaseLiquidity() calldata, two approvals chained ahead.
 *   - Hard refuse when ownerOf(tokenId) ≠ wallet (would route the
 *     deposit into someone else's position).
 *   - Hard refuse when both desired amounts are zero.
 *   - Single-sided deposit (amount0Desired = 0) emits only the token1
 *     approval.
 *   - Slippage gating + acknowledgeHighSlippage flag.
 *   - approvalCap: "exact" produces approve(amount) calldata for the
 *     first approval.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";
import { erc20Abi } from "../src/abis/erc20.js";

const { readContractMock, multicallMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
  multicallMock: vi.fn(),
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const OTHER_WALLET = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
const USDC_WETH_POOL = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8" as const;

const TOKEN_ID = "12345";

// Realistic-ish pool state — see uniswap-v3-mint.test.ts for the
// derivation. sqrtRatioX96 corresponds to USDC/WETH near $3000/ETH at
// tick=-201960; tick range [-202020, -201900] keeps the position
// in-range so the slippage helper exercises the "in-range" branch.
const FAKE_CURRENT_TICK = -201_960;
const FAKE_SQRT_PRICE_X96 = 3_262_820_378_846_468_593_912_909n;
const FAKE_POOL_LIQUIDITY = 10_000_000_000_000_000_000n;

// positions() return tuple: (nonce, operator, token0, token1, fee,
// tickLower, tickUpper, liquidity, feeGrowthInside0LastX128,
// feeGrowthInside1LastX128, tokensOwed0, tokensOwed1)
function positionTuple(opts: {
  token0?: `0x${string}`;
  token1?: `0x${string}`;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
} = {}) {
  return [
    0n,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    opts.token0 ?? USDC,
    opts.token1 ?? WETH,
    opts.fee ?? 3_000,
    opts.tickLower ?? -202_020,
    opts.tickUpper ?? -201_900,
    1_000_000n, // existing liquidity (not consumed by builder)
    0n,
    0n,
    0n,
    0n,
  ] as const;
}

function mockHappyPath(opts: { owner?: `0x${string}` } = {}) {
  multicallMock.mockImplementation(async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
    if (contracts[0]?.functionName === "positions" && contracts[1]?.functionName === "ownerOf") {
      return [positionTuple(), opts.owner ?? WALLET];
    }
    if (contracts[0]?.functionName === "decimals" && contracts[1]?.functionName === "symbol") {
      // resolveTokenPairMeta: 2 tokens × (decimals, symbol)
      return [6, "USDC", 18, "WETH"];
    }
    if (contracts[0]?.functionName === "slot0" && contracts[1]?.functionName === "liquidity") {
      return [
        [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
        FAKE_POOL_LIQUIDITY,
      ];
    }
    throw new Error(
      `unexpected multicall: ${JSON.stringify(contracts.map((c) => c.functionName))}`,
    );
  });
  readContractMock.mockImplementation(
    async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPool") return USDC_WETH_POOL;
      if (functionName === "allowance") return 0n;
      throw new Error(`unexpected readContract: ${functionName}`);
    },
  );
}

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
});

describe("buildUniswapIncrease", () => {
  it("happy path: increase USDC/WETH 0.3% position #12345 → increaseLiquidity() calldata + 2 approvals", async () => {
    mockHappyPath();
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapIncrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      amount0Desired: "100",
      amount1Desired: "0.05",
      slippageBps: 50,
    });
    expect(tx.description).toContain("Approve USDC");
    expect(tx.next!.description).toContain("Approve WETH");
    expect(tx.next!.next).toBeDefined();

    const incTx = tx.next!.next!;
    expect(incTx.to.toLowerCase()).toBe(NPM.toLowerCase());
    expect(incTx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: incTx.data,
    });
    expect(decoded.functionName).toBe("increaseLiquidity");
    const params = (decoded.args as readonly [{
      tokenId: bigint;
      amount0Desired: bigint;
      amount1Desired: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      deadline: bigint;
    }])[0];
    expect(params.tokenId).toBe(12_345n);
    expect(params.amount0Desired).toBe(100_000_000n); // 100 USDC, 6 decimals
    expect(params.amount1Desired).toBe(50_000_000_000_000_000n); // 0.05 WETH
    expect(params.amount0Min).toBeLessThanOrEqual(params.amount0Desired);
    expect(params.amount1Min).toBeLessThanOrEqual(params.amount1Desired);
    expect(incTx.description).toContain("position #12345");
  });

  it("hard-refuses when the tokenId is owned by a different address", async () => {
    mockHappyPath({ owner: OTHER_WALLET });
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapIncrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        amount0Desired: "100",
        amount1Desired: "0.05",
      }),
    ).rejects.toThrow(/not the wallet|is owned by/);
  });

  it("surfaces a clear error when positions(tokenId) reverts (tokenId not found)", async () => {
    multicallMock.mockImplementation(
      async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
        if (contracts[0]?.functionName === "positions") {
          throw new Error("execution reverted");
        }
        throw new Error("unexpected");
      },
    );
    readContractMock.mockResolvedValue(0n);
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapIncrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: "999999999",
        amount0Desired: "1",
        amount1Desired: "1",
      }),
    ).rejects.toThrow(/tokenId does not exist|positions\(/);
  });

  it("rejects when both desired amounts are zero", async () => {
    mockHappyPath();
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapIncrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        amount0Desired: "0",
        amount1Desired: "0",
      }),
    ).rejects.toThrow(/At least one.*must be > 0/);
  });

  it("emits only the nonzero-side approval for single-sided range deposits", async () => {
    // Position with range entirely above current price → only token1 needed.
    multicallMock.mockImplementation(
      async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
        if (contracts[0]?.functionName === "positions") {
          return [
            positionTuple({ tickLower: -201_840, tickUpper: -201_780 }),
            WALLET,
          ];
        }
        if (contracts[0]?.functionName === "decimals") return [6, "USDC", 18, "WETH"];
        if (contracts[0]?.functionName === "slot0") {
          return [
            [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
            FAKE_POOL_LIQUIDITY,
          ];
        }
        throw new Error("unexpected");
      },
    );
    readContractMock.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "getPool") return USDC_WETH_POOL;
        if (functionName === "allowance") return 0n;
        throw new Error("unexpected");
      },
    );
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapIncrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      amount0Desired: "0",
      amount1Desired: "0.05",
      slippageBps: 50,
    });
    expect(tx.description).toContain("Approve WETH");
    expect(tx.description).not.toContain("Approve USDC");
    expect(tx.next!.description).toContain("Increase Uniswap V3");
  });

  it("rejects high slippage without acknowledgeHighSlippage", async () => {
    mockHappyPath();
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapIncrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        amount0Desired: "100",
        amount1Desired: "0.05",
        slippageBps: 150,
      }),
    ).rejects.toThrow(/sandwich-bait/);
  });

  it("accepts high slippage when acknowledgeHighSlippage=true", async () => {
    mockHappyPath();
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapIncrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      amount0Desired: "100",
      amount1Desired: "0.05",
      slippageBps: 150,
      acknowledgeHighSlippage: true,
    });
    expect(tx.next!.next!.description).toContain("slippage 150 bps");
  });

  it("approval calldata uses the configured cap (exact)", async () => {
    mockHappyPath();
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapIncrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      amount0Desired: "100",
      amount1Desired: "0.05",
      approvalCap: "exact",
    });
    const decodedApprove = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decodedApprove.functionName).toBe("approve");
    const [, amount] = decodedApprove.args as readonly [string, bigint];
    expect(amount).toBe(100_000_000n);
  });

  it("skips approvals when allowance already satisfies the deposit", async () => {
    multicallMock.mockImplementation(
      async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
        if (contracts[0]?.functionName === "positions") {
          return [positionTuple(), WALLET];
        }
        if (contracts[0]?.functionName === "decimals") return [6, "USDC", 18, "WETH"];
        if (contracts[0]?.functionName === "slot0") {
          return [
            [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
            FAKE_POOL_LIQUIDITY,
          ];
        }
        throw new Error("unexpected");
      },
    );
    readContractMock.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "getPool") return USDC_WETH_POOL;
        if (functionName === "allowance") return 2n ** 256n - 1n;
        throw new Error("unexpected");
      },
    );
    const { buildUniswapIncrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapIncrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      amount0Desired: "100",
      amount1Desired: "0.05",
    });
    expect(tx.description).toContain("Increase Uniswap V3");
    expect(tx.next).toBeUndefined();
  });
});
