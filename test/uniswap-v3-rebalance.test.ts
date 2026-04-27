/**
 * Tests for `buildUniswapRebalance` — M1d in
 * `claude-work/plan-dex-liquidity-provision.md`. Composes
 * decreaseLiquidity + collect + (optional) burn + mint into a single
 * `multicall(bytes[])` call against the NonfungiblePositionManager.
 *
 * Asserts:
 *   - calldata is a multicall(bytes[]) with the right inner-call count
 *     and order
 *   - each inner call decodes against the expected NPM function
 *   - `burnOld: false` skips the burn step
 *   - hard refusals: owner mismatch, identical new range, mis-aligned
 *     new ticks, zero-liquidity position, newTickLower >= newTickUpper
 *   - approvals are chained ahead of the multicall (the mint phase
 *     still needs them)
 *   - description surfaces the compounded slippage pattern
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";

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

const FAKE_CURRENT_TICK = -201_960;
const FAKE_SQRT_PRICE_X96 = 3_262_820_378_846_468_593_912_909n;
const FAKE_POOL_LIQUIDITY = 10_000_000_000_000_000_000n;
const POSITION_LIQUIDITY = 100_000_000_000n;

function positionTuple(opts: {
  liquidity?: bigint;
  tickLower?: number;
  tickUpper?: number;
} = {}) {
  return [
    0n,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    USDC,
    WETH,
    3_000,
    opts.tickLower ?? -202_020,
    opts.tickUpper ?? -201_900,
    opts.liquidity ?? POSITION_LIQUIDITY,
    0n,
    0n,
    0n,
    0n,
  ] as const;
}

function mockHappyPath(opts: {
  owner?: `0x${string}`;
  position?: ReturnType<typeof positionTuple>;
} = {}) {
  multicallMock.mockImplementation(
    async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
      if (contracts[0]?.functionName === "positions" && contracts[1]?.functionName === "ownerOf") {
        return [opts.position ?? positionTuple(), opts.owner ?? WALLET];
      }
      if (contracts[0]?.functionName === "decimals") return [6, "USDC", 18, "WETH"];
      if (contracts[0]?.functionName === "slot0") {
        return [
          [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
          FAKE_POOL_LIQUIDITY,
        ];
      }
      throw new Error("unexpected multicall");
    },
  );
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

describe("buildUniswapRebalance", () => {
  it("happy path: encodes multicall(bytes[]) with [decrease, collect, burn, mint] inner calls (default burnOld=true)", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapRebalance({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      newTickLower: -201_780, // shifted right of the old [-202020, -201900] range
      newTickUpper: -201_660,
      slippageBps: 50,
    });

    // Walk past approvals — the mint phase still needs token0 + token1 approvals.
    let cursor = tx;
    while (cursor.next && cursor.description.startsWith("Approve")) cursor = cursor.next;
    expect(cursor.to.toLowerCase()).toBe(NPM.toLowerCase());

    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: cursor.data,
    });
    expect(decoded.functionName).toBe("multicall");
    const innerCalls = decoded.args![0] as readonly `0x${string}`[];
    expect(innerCalls).toHaveLength(4); // decrease + collect + burn + mint

    const [innerDecrease, innerCollect, innerBurn, innerMint] = innerCalls;
    expect(decodeFunctionData({ abi: uniswapPositionManagerAbi, data: innerDecrease }).functionName).toBe(
      "decreaseLiquidity",
    );
    expect(decodeFunctionData({ abi: uniswapPositionManagerAbi, data: innerCollect }).functionName).toBe(
      "collect",
    );
    expect(decodeFunctionData({ abi: uniswapPositionManagerAbi, data: innerBurn }).functionName).toBe(
      "burn",
    );
    expect(decodeFunctionData({ abi: uniswapPositionManagerAbi, data: innerMint }).functionName).toBe(
      "mint",
    );

    expect(cursor.description).toContain("Rebalance Uniswap V3 LP position");
    expect(cursor.description).toContain("[-202020, -201900]");
    expect(cursor.description).toContain("[-201780, -201660]");
    // Compounded slippage callout
    expect(cursor.description).toContain("close + re-deposit");
  });

  it("burnOld=false skips the burn step", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapRebalance({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      newTickLower: -201_780,
      newTickUpper: -201_660,
      burnOld: false,
    });

    let cursor = tx;
    while (cursor.next && cursor.description.startsWith("Approve")) cursor = cursor.next;
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: cursor.data,
    });
    expect(decoded.functionName).toBe("multicall");
    const innerCalls = decoded.args![0] as readonly `0x${string}`[];
    expect(innerCalls).toHaveLength(3); // decrease + collect + mint, no burn
    const fns = innerCalls.map(
      (d) => decodeFunctionData({ abi: uniswapPositionManagerAbi, data: d }).functionName,
    );
    expect(fns).toEqual(["decreaseLiquidity", "collect", "mint"]);
  });

  it("decrease step uses 100% of the position's liquidity", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapRebalance({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      newTickLower: -201_780,
      newTickUpper: -201_660,
    });
    let cursor = tx;
    while (cursor.next && cursor.description.startsWith("Approve")) cursor = cursor.next;
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: cursor.data,
    });
    const innerCalls = decoded.args![0] as readonly `0x${string}`[];
    const decreaseDecoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: innerCalls[0],
    });
    const decreaseParams = (decreaseDecoded.args as readonly [{ liquidity: bigint }])[0];
    expect(decreaseParams.liquidity).toBe(POSITION_LIQUIDITY);
  });

  it("mint step uses the new tick range (not the old one)", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapRebalance({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      newTickLower: -201_780,
      newTickUpper: -201_660,
    });
    let cursor = tx;
    while (cursor.next && cursor.description.startsWith("Approve")) cursor = cursor.next;
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: cursor.data,
    });
    const innerCalls = decoded.args![0] as readonly `0x${string}`[];
    const mintDecoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: innerCalls[innerCalls.length - 1],
    });
    const mintParams = (mintDecoded.args as readonly [{
      tickLower: number;
      tickUpper: number;
      token0: string;
      token1: string;
      fee: number;
    }])[0];
    expect(mintParams.tickLower).toBe(-201_780);
    expect(mintParams.tickUpper).toBe(-201_660);
    expect(mintParams.token0.toLowerCase()).toBe(USDC.toLowerCase());
    expect(mintParams.token1.toLowerCase()).toBe(WETH.toLowerCase());
    expect(mintParams.fee).toBe(3_000);
  });

  it("hard-refuses on owner mismatch", async () => {
    mockHappyPath({ owner: OTHER_WALLET });
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapRebalance({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        newTickLower: -201_780,
        newTickUpper: -201_660,
      }),
    ).rejects.toThrow(/is owned by/);
  });

  it("rejects when new range is identical to old", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapRebalance({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        newTickLower: -202_020, // same as position's tickLower
        newTickUpper: -201_900, // same as position's tickUpper
      }),
    ).rejects.toThrow(/identical/);
  });

  it("rejects when newTickLower >= newTickUpper", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapRebalance({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        newTickLower: -201_660,
        newTickUpper: -201_780, // smaller than newTickLower
      }),
    ).rejects.toThrow(/must be </);
  });

  it("rejects mis-aligned new ticks with nearest-usable-tick guidance", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapRebalance({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        newTickLower: -201_781, // not aligned to tickSpacing=60
        newTickUpper: -201_660,
      }),
    ).rejects.toThrow(/align to tickSpacing=60/);
  });

  it("rejects when position has zero liquidity", async () => {
    mockHappyPath({ position: positionTuple({ liquidity: 0n }) });
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapRebalance({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        newTickLower: -201_780,
        newTickUpper: -201_660,
      }),
    ).rejects.toThrow(/zero liquidity/);
  });

  it("emits up to two approvals ahead of the multicall (mint phase still needs them)", async () => {
    mockHappyPath();
    const { buildUniswapRebalance } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapRebalance({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      newTickLower: -201_780,
      newTickUpper: -201_660,
    });
    // Approvals chain ahead. Walk and count.
    let cursor: typeof tx | undefined = tx;
    let approvalCount = 0;
    while (cursor && cursor.description.startsWith("Approve")) {
      approvalCount += 1;
      cursor = cursor.next;
    }
    expect(approvalCount).toBeGreaterThanOrEqual(1);
    expect(approvalCount).toBeLessThanOrEqual(2);
    expect(cursor).toBeDefined();
    expect(cursor!.description).toContain("Rebalance Uniswap V3 LP position");
  });
});
