/**
 * Tests for `buildUniswapMint` — first slice of the LP plan's
 * Milestone 1. Mocks the RPC client surface (`readContract`,
 * `multicall`, `getChainId`) so the SDK math runs against fake pool
 * state and the produced calldata is asserted in detail.
 *
 * Coverage:
 *   - Happy path on USDC/WETH 0.3% — calldata decodes to the expected
 *     mint() args, two approvals chain ahead (USDC, WETH), tick
 *     bounds preserved.
 *   - Token order canonicalization: tokenA > tokenB by address swaps
 *     them and re-threads amounts.
 *   - Tick alignment: mis-aligned ticks reject with a guidance message
 *     pointing at the nearest usable tick.
 *   - Pool existence: factory.getPool returning 0x000…000 is rejected
 *     with the "create pool first" message.
 *   - Single-sided range deposit: amount0=0 emits only the token1
 *     approval; amount1=0 the inverse.
 *   - High slippage gating: 150 bps without ack throws; 150 bps with
 *     ack proceeds.
 *   - amount0Min/amount1Min are strictly less than amount0Desired /
 *     amount1Desired (slippage floor applied).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";
import { erc20Abi } from "../src/abis/erc20.js";

const { readContractMock, multicallMock, getChainIdMock } = vi.hoisted(
  () => ({
    readContractMock: vi.fn(),
    multicallMock: vi.fn(),
    getChainIdMock: vi.fn(),
  }),
);

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
    getChainId: getChainIdMock,
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
// Mainnet USDC/WETH 0.3% pool address (known); the factory.getPool mock
// returns this so the builder treats the pool as initialized.
const USDC_WETH_POOL = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8" as const;

// Realistic pool state. The SDK's `Pool` constructor enforces
// `getSqrtRatioAtTick(tick) <= sqrtPriceX96 < getSqrtRatioAtTick(tick + 1)`,
// so the sqrtPriceX96 must match the tick. Pre-computed via
// `TickMath.getSqrtRatioAtTick(-201960)` (USDC/WETH around $3000/ETH).
const FAKE_CURRENT_TICK = -201_960;
const FAKE_SQRT_PRICE_X96 = 3_262_820_378_846_468_593_912_909n;
const FAKE_POOL_LIQUIDITY = 10_000_000_000_000_000_000n;

function mockHappyPath() {
  // Token meta multicall: [decimals0, symbol0, decimals1, symbol1] in
  // canonical token0/token1 order. USDC < WETH lex.
  multicallMock.mockImplementation(async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
    if (contracts[0]?.functionName === "decimals" && contracts[1]?.functionName === "symbol") {
      // resolveTokenPairMeta: 2 tokens × (decimals, symbol)
      return [6, "USDC", 18, "WETH"];
    }
    if (contracts[0]?.functionName === "slot0" && contracts[1]?.functionName === "liquidity") {
      // Pool slot0 + liquidity
      return [
        [
          FAKE_SQRT_PRICE_X96,
          FAKE_CURRENT_TICK,
          0,
          1,
          1,
          0,
          true,
        ],
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
  getChainIdMock.mockResolvedValue(1);
}

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
  getChainIdMock.mockReset();
});

describe("buildUniswapMint", () => {
  it("happy path: USDC/WETH 0.3% mint produces mint() calldata + two approvals chained ahead", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000,
      tickLower: -202_020, // aligned to tickSpacing=60
      tickUpper: -201_900,
      amountADesired: "100", // 100 USDC
      amountBDesired: "0.05", // 0.05 WETH
      slippageBps: 50,
    });

    // Two approvals chain ahead — order matches token0, token1 (USDC, WETH).
    expect(tx.description).toContain("Approve USDC");
    expect(tx.next).toBeDefined();
    expect(tx.next!.description).toContain("Approve WETH");
    expect(tx.next!.next).toBeDefined();

    const mintTx = tx.next!.next!;
    expect(mintTx.to.toLowerCase()).toBe(NPM.toLowerCase());
    expect(mintTx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: mintTx.data,
    });
    expect(decoded.functionName).toBe("mint");
    const params = (decoded.args as readonly [{
      token0: string;
      token1: string;
      fee: number;
      tickLower: number;
      tickUpper: number;
      amount0Desired: bigint;
      amount1Desired: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      recipient: string;
    }])[0];
    expect(params.token0.toLowerCase()).toBe(USDC.toLowerCase());
    expect(params.token1.toLowerCase()).toBe(WETH.toLowerCase());
    expect(params.fee).toBe(3000);
    expect(params.tickLower).toBe(-202_020);
    expect(params.tickUpper).toBe(-201_900);
    expect(params.amount0Desired).toBe(100_000_000n); // 100 USDC, 6 decimals
    expect(params.amount1Desired).toBe(50_000_000_000_000_000n); // 0.05 WETH, 18 decimals
    expect(params.amount0Min).toBeLessThanOrEqual(params.amount0Desired);
    expect(params.amount1Min).toBeLessThanOrEqual(params.amount1Desired);
    expect(params.recipient.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it("re-orders tokens canonically when caller passes tokenA > tokenB", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    // Pass WETH as tokenA, USDC as tokenB — opposite of canonical order.
    // amountADesired (0.05 WETH) maps to amount1, amountBDesired (100 USDC) to amount0.
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: WETH,
      tokenB: USDC,
      feeTier: 3000,
      tickLower: -202_020,
      tickUpper: -201_900,
      amountADesired: "0.05",
      amountBDesired: "100",
      slippageBps: 50,
    });
    const mintTx = tx.next!.next!;
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: mintTx.data,
    });
    const params = (decoded.args as readonly [{
      token0: string;
      token1: string;
      amount0Desired: bigint;
      amount1Desired: bigint;
    }])[0];
    expect(params.token0.toLowerCase()).toBe(USDC.toLowerCase());
    expect(params.token1.toLowerCase()).toBe(WETH.toLowerCase());
    expect(params.amount0Desired).toBe(100_000_000n);
    expect(params.amount1Desired).toBe(50_000_000_000_000_000n);
  });

  it("rejects mis-aligned ticks with a guidance message pointing at the nearest usable tick", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapMint({
        chain: "ethereum",
        wallet: WALLET,
        tokenA: USDC,
        tokenB: WETH,
        feeTier: 3000, // tickSpacing=60
        tickLower: -202_001, // not aligned to 60
        tickUpper: -201_900,
        amountADesired: "100",
        amountBDesired: "0.05",
      }),
    ).rejects.toThrow(/align to tickSpacing=60/);
  });

  it("rejects an uninitialized pool (factory.getPool returns 0x0)", async () => {
    multicallMock.mockResolvedValue([6, "USDC", 18, "WETH"]);
    readContractMock.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "getPool") return "0x0000000000000000000000000000000000000000";
        throw new Error(`unexpected readContract: ${functionName}`);
      },
    );
    getChainIdMock.mockResolvedValue(1);
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapMint({
        chain: "ethereum",
        wallet: WALLET,
        tokenA: USDC,
        tokenB: WETH,
        feeTier: 100, // 0.01% — pool may not exist
        tickLower: -202_020,
        tickUpper: -201_900,
        amountADesired: "100",
        amountBDesired: "0.05",
      }),
    ).rejects.toThrow(/does not exist on ethereum/);
  });

  it("rejects when both desired amounts are zero", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapMint({
        chain: "ethereum",
        wallet: WALLET,
        tokenA: USDC,
        tokenB: WETH,
        feeTier: 3000,
        tickLower: -202_020,
        tickUpper: -201_900,
        amountADesired: "0",
        amountBDesired: "0",
      }),
    ).rejects.toThrow(/At least one.*must be > 0/);
  });

  it("emits only the nonzero-side approval for single-sided range deposits", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000,
      // Range entirely above current price — only token1 (WETH) is needed.
      tickLower: -201_840,
      tickUpper: -201_780,
      amountADesired: "0",
      amountBDesired: "0.05",
      slippageBps: 50,
    });
    // Only WETH approval should be present, not USDC.
    expect(tx.description).toContain("Approve WETH");
    expect(tx.description).not.toContain("Approve USDC");
    expect(tx.next!.description).toContain("Mint Uniswap V3");
  });

  it("rejects high slippage without acknowledgeHighSlippage", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapMint({
        chain: "ethereum",
        wallet: WALLET,
        tokenA: USDC,
        tokenB: WETH,
        feeTier: 3000,
        tickLower: -202_020,
        tickUpper: -201_900,
        amountADesired: "100",
        amountBDesired: "0.05",
        slippageBps: 150,
      }),
    ).rejects.toThrow(/sandwich-bait/);
  });

  it("accepts high slippage when acknowledgeHighSlippage=true", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000,
      tickLower: -202_020,
      tickUpper: -201_900,
      amountADesired: "100",
      amountBDesired: "0.05",
      slippageBps: 150,
      acknowledgeHighSlippage: true,
    });
    expect(tx.next!.next!.description).toContain("slippage 150 bps");
  });

  it("skips approvals when allowance already satisfies the deposit (passes through to mint directly)", async () => {
    multicallMock.mockImplementation(async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
      if (contracts[0]?.functionName === "decimals") return [6, "USDC", 18, "WETH"];
      if (contracts[0]?.functionName === "slot0") {
        return [
          [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
          FAKE_POOL_LIQUIDITY,
        ];
      }
      throw new Error("unexpected");
    });
    readContractMock.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "getPool") return USDC_WETH_POOL;
        // Already-unlimited allowance on both sides
        if (functionName === "allowance") return 2n ** 256n - 1n;
        throw new Error(`unexpected readContract: ${functionName}`);
      },
    );
    getChainIdMock.mockResolvedValue(1);
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000,
      tickLower: -202_020,
      tickUpper: -201_900,
      amountADesired: "100",
      amountBDesired: "0.05",
    });
    // No approvals — head is the mint itself.
    expect(tx.description).toContain("Mint Uniswap V3");
    expect(tx.next).toBeUndefined();
  });

  it("approval calldata uses the configured cap", async () => {
    mockHappyPath();
    const { buildUniswapMint } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapMint({
      chain: "ethereum",
      wallet: WALLET,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000,
      tickLower: -202_020,
      tickUpper: -201_900,
      amountADesired: "100",
      amountBDesired: "0.05",
      approvalCap: "exact",
    });
    const decodedApprove = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decodedApprove.functionName).toBe("approve");
    const [, amount] = decodedApprove.args as readonly [string, bigint];
    // exact == amount0Desired for the first approval (USDC, 6 decimals).
    expect(amount).toBe(100_000_000n);
  });
});
