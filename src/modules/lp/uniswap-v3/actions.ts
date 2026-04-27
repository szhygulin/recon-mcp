/**
 * Uniswap V3 LP write builders. Currently exposes `buildUniswapMint`
 * (PR1 of Milestone 1 in `claude-work/plan-dex-liquidity-provision.md`);
 * `_increase_liquidity`, `_decrease_liquidity`, `_collect`, `_burn`, and
 * `_rebalance` follow in subsequent PRs.
 *
 * The slippage-aware Position math (`maxLiquidityForAmounts`,
 * `mintAmounts`, `mintAmountsWithSlippage`) is a pure-bigint port from
 * `@uniswap/v3-sdk`, in `tick-math.ts` + `sqrt-price-math.ts` +
 * `position-math.ts`. The original SDK was dropped from the dep tree —
 * it transitively pulled in `@uniswap/swap-router-contracts`, which
 * itself pulled in hardhat + mocha + sentry + solc + undici. Each came
 * with its own CVE tail (Snyk failed PR #334 on the dep chain even
 * though no path is reachable at runtime). Calldata is encoded via
 * viem `encodeFunctionData` against `src/abis/uniswap-position-manager.ts`.
 */
import { encodeFunctionData, parseUnits } from "viem";
import { CONTRACTS } from "../../../config/contracts.js";
import { getClient } from "../../../data/rpc.js";
import { uniswapPositionManagerAbi } from "../../../abis/uniswap-position-manager.js";
import { uniswapPoolAbi, uniswapFactoryAbi } from "../../../abis/uniswap-pool.js";
import { erc20Abi } from "../../../abis/erc20.js";
import {
  buildApprovalTx,
  chainApprovals,
  resolveApprovalCap,
} from "../../shared/approval.js";
import { resolveTokenPairMeta } from "../../shared/token-meta.js";
import { parseSlippageBps } from "../preflight.js";
import { TICK_SPACINGS, nearestUsableTick } from "./tick-math.js";
import {
  burnAmounts,
  burnAmountsWithSlippage,
  mintAmountsWithSlippage,
  type PoolState,
} from "./position-math.js";
import type { SupportedChain, UnsignedTx } from "../../../types/index.js";

const SUPPORTED_FEE_TIERS = [100, 500, 3000, 10000] as const;
type SupportedFeeTier = (typeof SUPPORTED_FEE_TIERS)[number];

export interface BuildUniswapMintParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  /** Either token order accepted; we sort canonically before submission. */
  tokenA: `0x${string}`;
  tokenB: `0x${string}`;
  /** 100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%. */
  feeTier: SupportedFeeTier;
  /** Lower bound of the position's price range (must align to feeTier's tickSpacing). */
  tickLower: number;
  /** Upper bound (must align, must be > tickLower). */
  tickUpper: number;
  /** Human-readable amount the user wants to deposit of `tokenA`. */
  amountADesired: string;
  /** Human-readable amount the user wants to deposit of `tokenB`. */
  amountBDesired: string;
  /** Out of 10000. Soft-capped at 100 unless `acknowledgeHighSlippage`. */
  slippageBps?: number;
  acknowledgeHighSlippage?: boolean;
  /** Seconds from now until the on-chain `deadline` parameter expires. Default: 1200 (20 min). */
  deadlineSec?: number;
  /** Approval cap for both tokens; see `resolveApprovalCap`. */
  approvalCap?: string;
  /** Recipient of the minted NFT. Default: wallet. */
  recipient?: `0x${string}`;
}

const DEFAULT_DEADLINE_SEC = 20 * 60;

export async function buildUniswapMint(
  p: BuildUniswapMintParams,
): Promise<UnsignedTx> {
  // 1. Resolve config + canonical token order. Uniswap V3 pools store
  //    tokens in ascending-address order; the user's amountA/amountB
  //    might map either way around so we sort locally and re-thread.
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  if (p.tokenA.toLowerCase() === p.tokenB.toLowerCase()) {
    throw new Error("tokenA and tokenB must differ.");
  }
  const tokenAIsToken0 =
    p.tokenA.toLowerCase() < p.tokenB.toLowerCase();
  const token0Addr = (tokenAIsToken0 ? p.tokenA : p.tokenB) as `0x${string}`;
  const token1Addr = (tokenAIsToken0 ? p.tokenB : p.tokenA) as `0x${string}`;
  const amount0Human = tokenAIsToken0 ? p.amountADesired : p.amountBDesired;
  const amount1Human = tokenAIsToken0 ? p.amountBDesired : p.amountADesired;

  // 2. Validate fee tier + tick alignment. nearestUsableTick is a soft
  //    helper; we *reject* mis-aligned ticks rather than silently
  //    rounding so the caller never gets a surprise position bound.
  const tickSpacing = TICK_SPACINGS[p.feeTier];
  if (!tickSpacing) {
    throw new Error(
      `Unsupported feeTier ${p.feeTier}. Allowed: ${SUPPORTED_FEE_TIERS.join(", ")}.`,
    );
  }
  if (p.tickLower >= p.tickUpper) {
    throw new Error(
      `tickLower (${p.tickLower}) must be < tickUpper (${p.tickUpper}).`,
    );
  }
  if (
    p.tickLower % tickSpacing !== 0 ||
    p.tickUpper % tickSpacing !== 0
  ) {
    throw new Error(
      `tickLower/tickUpper must align to tickSpacing=${tickSpacing} for ` +
        `fee tier ${p.feeTier}. Got ${p.tickLower}/${p.tickUpper}; nearest ` +
        `usable: ${nearestUsableTick(p.tickLower, tickSpacing)}/` +
        `${nearestUsableTick(p.tickUpper, tickSpacing)}.`,
    );
  }
  const slippageBps = parseSlippageBps({
    slippageBps: p.slippageBps,
    acknowledgeHighSlippage: p.acknowledgeHighSlippage,
  });

  // 3. Resolve token meta + pool address + current pool state. One
  //    multicall on the pool covers slot0 (sqrtPriceX96 + currentTick) +
  //    liquidity (the pool's in-range L). Token meta is a separate
  //    multicall via M0's resolveTokenPairMeta.
  const factoryAddr = cfg.factory as `0x${string}`;
  const positionManager = cfg.positionManager as `0x${string}`;
  const client = getClient(p.chain);

  const [meta, poolAddr] = await Promise.all([
    resolveTokenPairMeta(p.chain, [token0Addr, token1Addr]),
    client.readContract({
      address: factoryAddr,
      abi: uniswapFactoryAbi,
      functionName: "getPool",
      args: [token0Addr, token1Addr, p.feeTier],
    }) as Promise<`0x${string}`>,
  ]);
  if (poolAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Pool ${token0Addr}/${token1Addr} fee=${p.feeTier} does not exist on ${p.chain}. ` +
        `Mint requires an initialized pool — create the pool first or pick a different fee tier.`,
    );
  }
  const [decimals0, decimals1] = [meta[0].decimals, meta[1].decimals];
  const [symbol0, symbol1] = [meta[0].symbol, meta[1].symbol];
  const amount0Wei = parseUnits(amount0Human, decimals0);
  const amount1Wei = parseUnits(amount1Human, decimals1);
  if (amount0Wei === 0n && amount1Wei === 0n) {
    throw new Error(
      "At least one of amountADesired / amountBDesired must be > 0.",
    );
  }

  const [slot0, poolLiquidity] = await client.multicall({
    contracts: [
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "slot0" },
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "liquidity" },
    ],
    allowFailure: false,
  });
  const sqrtPriceX96 = (slot0 as readonly [bigint, number, ...unknown[]])[0];
  const currentTick = Number((slot0 as readonly [bigint, number, ...unknown[]])[1]);
  // poolLiquidity is read off-chain but the math here doesn't consume
  // it (the SDK's `Pool` class carried it for swap simulation we don't
  // do). Kept in the multicall above for future increase / decrease /
  // rebalance flows that may need it.
  void poolLiquidity;

  // 4. Slippage-bounded floors via the local Position math port.
  //    `useFullPrecision: true` (inside the helper) mirrors the
  //    Uniswap UI's mainstream choice for maximum liquidity-per-amount.
  const poolState: PoolState = {
    fee: p.feeTier,
    sqrtRatioX96: sqrtPriceX96,
    tickCurrent: currentTick,
    tickSpacing,
  };
  const { amount0: amount0Min, amount1: amount1Min } = mintAmountsWithSlippage({
    pool: poolState,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    amount0Desired: amount0Wei,
    amount1Desired: amount1Wei,
    slippageBps,
  });

  // 5. Encode mint() calldata via viem against our locally-pinned ABI.
  //    Recipient defaults to wallet; deadline is `now + deadlineSec`.
  const recipient = p.recipient ?? p.wallet;
  const deadlineSec = p.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const mintData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "mint",
    args: [
      {
        token0: token0Addr,
        token1: token1Addr,
        fee: p.feeTier,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0Desired: amount0Wei,
        amount1Desired: amount1Wei,
        amount0Min,
        amount1Min,
        recipient,
        deadline,
      },
    ],
  });
  const mintTx: UnsignedTx = {
    chain: p.chain,
    to: positionManager,
    data: mintData,
    value: "0",
    from: p.wallet,
    description:
      `Mint Uniswap V3 LP position: ${amount0Human} ${symbol0} + ${amount1Human} ${symbol1} ` +
      `at ${p.feeTier / 10_000}% fee, ticks [${p.tickLower}, ${p.tickUpper}], ` +
      `slippage ${slippageBps} bps`,
    decoded: {
      functionName: "mint",
      args: {
        token0: token0Addr,
        token1: token1Addr,
        fee: String(p.feeTier),
        tickLower: String(p.tickLower),
        tickUpper: String(p.tickUpper),
        amount0Desired: amount0Human,
        amount1Desired: amount1Human,
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),
        recipient,
        deadline: deadline.toString(),
      },
    },
  };

  // 6. Approvals. NPM pulls each token via transferFrom — one approval
  //    per nonzero deposit side. Skip the side whose desired amount is
  //    0 (single-sided range deposits). USDT-style reset is handled by
  //    `buildApprovalTx`; chainApprovals walks tails.
  const approvals: Array<UnsignedTx | null> = [];
  if (amount0Wei > 0n) {
    const cap0 = resolveApprovalCap(p.approvalCap, amount0Wei, decimals0);
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: token0Addr,
        spender: positionManager,
        amountWei: amount0Wei,
        approvalAmount: cap0.approvalAmount,
        approvalDisplay: cap0.display,
        symbol: symbol0,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }
  if (amount1Wei > 0n) {
    const cap1 = resolveApprovalCap(p.approvalCap, amount1Wei, decimals1);
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: token1Addr,
        spender: positionManager,
        amountWei: amount1Wei,
        approvalAmount: cap1.approvalAmount,
        approvalDisplay: cap1.display,
        symbol: symbol1,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }

  return chainApprovals(approvals, mintTx);
}

export interface BuildUniswapIncreaseParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  /** ERC-721 tokenId of the existing position to add liquidity to. */
  tokenId: string;
  /**
   * Human-readable amount of the position's token0 to add. Pass "0"
   * for a single-sided range deposit when the current price is
   * outside [tickLower, tickUpper] and only the other side is needed.
   */
  amount0Desired: string;
  /** Same for token1. */
  amount1Desired: string;
  slippageBps?: number;
  acknowledgeHighSlippage?: boolean;
  deadlineSec?: number;
  approvalCap?: string;
}

/**
 * Build an unsigned `increaseLiquidity()` tx for an existing Uniswap V3
 * LP position. Reads the position's (token0, token1, fee, tickLower,
 * tickUpper) on-chain so the caller doesn't have to thread them; uses
 * the same Position math as mint to derive amount0Min / amount1Min.
 *
 * Hard refusal up front:
 *   - tokenId not owned by `wallet` — funds would route into someone
 *     else's position. The on-chain call would still succeed; the
 *     position owner gets the new liquidity, not the caller. Refused.
 *   - position not initialized (positions(tokenId) reverts) — caught
 *     and surfaced as a clear "tokenId not found" error.
 *   - both desired amounts zero.
 */
export async function buildUniswapIncrease(
  p: BuildUniswapIncreaseParams,
): Promise<UnsignedTx> {
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  const positionManager = cfg.positionManager as `0x${string}`;
  const factoryAddr = cfg.factory as `0x${string}`;
  const client = getClient(p.chain);

  const tokenIdBig = BigInt(p.tokenId);
  const slippageBps = parseSlippageBps({
    slippageBps: p.slippageBps,
    acknowledgeHighSlippage: p.acknowledgeHighSlippage,
  });

  // 1. Position state + ownership in one multicall. positions() reverts
  //    on a non-existent tokenId — `allowFailure: false` lets that
  //    bubble; we wrap to surface the "tokenId not found" path cleanly.
  let positionData: readonly [
    bigint,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  let owner: `0x${string}`;
  try {
    const [posResult, ownerResult] = await client.multicall({
      contracts: [
        {
          address: positionManager,
          abi: uniswapPositionManagerAbi,
          functionName: "positions",
          args: [tokenIdBig],
        },
        {
          address: positionManager,
          abi: uniswapPositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenIdBig],
        },
      ],
      allowFailure: false,
    });
    positionData = posResult as typeof positionData;
    owner = ownerResult as `0x${string}`;
  } catch (err) {
    throw new Error(
      `Uniswap V3 NPM positions(${p.tokenId}) read failed on ${p.chain}. ` +
        `Most likely the tokenId does not exist. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (owner.toLowerCase() !== p.wallet.toLowerCase()) {
    throw new Error(
      `Uniswap V3 LP NFT tokenId=${p.tokenId} is owned by ${owner}, not ${p.wallet}. ` +
        `Refusing to increase liquidity — the on-chain call would route the deposit into ` +
        `someone else's position. Verify the tokenId is one this wallet actually holds ` +
        `(see get_lp_positions).`,
    );
  }

  const [, , token0Addr, token1Addr, fee, tickLower, tickUpper] = positionData;

  // 2. Token meta + pool address + slot0. Same layered reads as mint;
  //    just with the position's pre-known (token0, token1, fee).
  const [meta, poolAddr] = await Promise.all([
    resolveTokenPairMeta(p.chain, [token0Addr, token1Addr]),
    client.readContract({
      address: factoryAddr,
      abi: uniswapFactoryAbi,
      functionName: "getPool",
      args: [token0Addr, token1Addr, fee],
    }) as Promise<`0x${string}`>,
  ]);
  if (poolAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Uniswap V3 pool ${token0Addr}/${token1Addr} fee=${fee} on ${p.chain} ` +
        `does not resolve. The position's pool was uninitialized — should not happen ` +
        `for an existing tokenId. Investigate.`,
    );
  }
  const [decimals0, decimals1] = [meta[0].decimals, meta[1].decimals];
  const [symbol0, symbol1] = [meta[0].symbol, meta[1].symbol];
  const amount0Wei = parseUnits(p.amount0Desired, decimals0);
  const amount1Wei = parseUnits(p.amount1Desired, decimals1);
  if (amount0Wei === 0n && amount1Wei === 0n) {
    throw new Error(
      "At least one of amount0Desired / amount1Desired must be > 0.",
    );
  }

  const [slot0, poolLiquidity] = await client.multicall({
    contracts: [
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "slot0" },
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "liquidity" },
    ],
    allowFailure: false,
  });
  const sqrtPriceX96 = (slot0 as readonly [bigint, number, ...unknown[]])[0];
  const currentTick = Number((slot0 as readonly [bigint, number, ...unknown[]])[1]);
  void poolLiquidity;

  const tickSpacing = TICK_SPACINGS[fee];
  if (!tickSpacing) {
    throw new Error(
      `Uniswap V3 position ${p.tokenId} has unknown fee tier ${fee}. Refusing.`,
    );
  }

  // 3. Slippage-bounded floors. Same math helper as mint; the position's
  //    existing tick range comes from positions().
  const { amount0: amount0Min, amount1: amount1Min } = mintAmountsWithSlippage({
    pool: {
      fee,
      sqrtRatioX96: sqrtPriceX96,
      tickCurrent: currentTick,
      tickSpacing,
    },
    tickLower,
    tickUpper,
    amount0Desired: amount0Wei,
    amount1Desired: amount1Wei,
    slippageBps,
  });

  // 4. Encode increaseLiquidity() calldata.
  const deadlineSec = p.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const increaseData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "increaseLiquidity",
    args: [
      {
        tokenId: tokenIdBig,
        amount0Desired: amount0Wei,
        amount1Desired: amount1Wei,
        amount0Min,
        amount1Min,
        deadline,
      },
    ],
  });
  const increaseTx: UnsignedTx = {
    chain: p.chain,
    to: positionManager,
    data: increaseData,
    value: "0",
    from: p.wallet,
    description:
      `Increase Uniswap V3 LP position #${p.tokenId}: ` +
      `${p.amount0Desired} ${symbol0} + ${p.amount1Desired} ${symbol1} ` +
      `at ${fee / 10_000}% fee, ticks [${tickLower}, ${tickUpper}], ` +
      `slippage ${slippageBps} bps`,
    decoded: {
      functionName: "increaseLiquidity",
      args: {
        tokenId: p.tokenId,
        amount0Desired: p.amount0Desired,
        amount1Desired: p.amount1Desired,
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),
        deadline: deadline.toString(),
      },
    },
  };

  // 5. Approvals — one per nonzero side; reuse the chain machinery.
  const approvals: Array<UnsignedTx | null> = [];
  if (amount0Wei > 0n) {
    const cap0 = resolveApprovalCap(p.approvalCap, amount0Wei, decimals0);
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: token0Addr,
        spender: positionManager,
        amountWei: amount0Wei,
        approvalAmount: cap0.approvalAmount,
        approvalDisplay: cap0.display,
        symbol: symbol0,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }
  if (amount1Wei > 0n) {
    const cap1 = resolveApprovalCap(p.approvalCap, amount1Wei, decimals1);
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: token1Addr,
        spender: positionManager,
        amountWei: amount1Wei,
        approvalAmount: cap1.approvalAmount,
        approvalDisplay: cap1.display,
        symbol: symbol1,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }

  return chainApprovals(approvals, increaseTx);
}

// uint128 max — used by `collect()` to harvest everything the position
// is owed without a 256-bit cap argument.
const U128_MAX = (1n << 128n) - 1n;

/**
 * Read positions(tokenId) + ownerOf(tokenId) for a Uniswap V3 LP NFT;
 * assert ownership matches `wallet`. Returns the parsed tuple. Used by
 * decrease / collect / burn — all three need the same preflight.
 */
async function readOwnedPosition(
  chain: SupportedChain,
  positionManager: `0x${string}`,
  wallet: `0x${string}`,
  tokenId: bigint,
): Promise<{
  nonce: bigint;
  operator: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}> {
  const client = getClient(chain);
  let posResult: readonly unknown[];
  let owner: `0x${string}`;
  try {
    const [pos, ownerRes] = await client.multicall({
      contracts: [
        {
          address: positionManager,
          abi: uniswapPositionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        },
        {
          address: positionManager,
          abi: uniswapPositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        },
      ],
      allowFailure: false,
    });
    posResult = pos as readonly unknown[];
    owner = ownerRes as `0x${string}`;
  } catch (err) {
    throw new Error(
      `Uniswap V3 NPM positions(${tokenId}) read failed on ${chain}. ` +
        `Most likely the tokenId does not exist. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (owner.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `Uniswap V3 LP NFT tokenId=${tokenId} is owned by ${owner}, not ${wallet}. ` +
        `Refusing — the on-chain call would credit the actual position owner, ` +
        `not the caller. Verify the tokenId via get_lp_positions.`,
    );
  }
  return {
    nonce: posResult[0] as bigint,
    operator: posResult[1] as `0x${string}`,
    token0: posResult[2] as `0x${string}`,
    token1: posResult[3] as `0x${string}`,
    fee: posResult[4] as number,
    tickLower: posResult[5] as number,
    tickUpper: posResult[6] as number,
    liquidity: posResult[7] as bigint,
    feeGrowthInside0LastX128: posResult[8] as bigint,
    feeGrowthInside1LastX128: posResult[9] as bigint,
    tokensOwed0: posResult[10] as bigint,
    tokensOwed1: posResult[11] as bigint,
  };
}

export interface BuildUniswapDecreaseParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  tokenId: string;
  /**
   * Percentage of the position's liquidity to withdraw, 1-100. Pass
   * `100` to fully drain (typical close-out path is then collect+burn).
   * Mutually exclusive with `liquidity`.
   */
  liquidityPct?: number;
  /**
   * Raw liquidity amount to withdraw. Use this when you need exact
   * accounting; otherwise prefer `liquidityPct`. Mutually exclusive
   * with `liquidityPct`.
   */
  liquidity?: string;
  slippageBps?: number;
  acknowledgeHighSlippage?: boolean;
  deadlineSec?: number;
}

/**
 * Build an unsigned `decreaseLiquidity()` tx for an existing Uniswap V3
 * LP position. The decrease ALONE does not transfer tokens to the
 * caller — it credits `tokensOwed{0,1}` on the position. The agent
 * follows up with `prepare_uniswap_v3_collect` (or, for full close-out,
 * with rebalance / burn) to actually move the tokens.
 *
 * The `liquidity` arg the on-chain call needs is computed from
 * `liquidityPct` × `position.liquidity`. amount0Min/amount1Min come
 * from `burnAmountsWithSlippage`.
 */
export async function buildUniswapDecrease(
  p: BuildUniswapDecreaseParams,
): Promise<UnsignedTx> {
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  if (
    (p.liquidityPct === undefined && p.liquidity === undefined) ||
    (p.liquidityPct !== undefined && p.liquidity !== undefined)
  ) {
    throw new Error(
      "Pass exactly one of `liquidityPct` (1-100) or `liquidity` (raw bigint string).",
    );
  }
  if (p.liquidityPct !== undefined) {
    if (
      !Number.isInteger(p.liquidityPct) ||
      p.liquidityPct < 1 ||
      p.liquidityPct > 100
    ) {
      throw new Error(
        `liquidityPct must be an integer in [1, 100] (got ${p.liquidityPct}).`,
      );
    }
  }
  const positionManager = cfg.positionManager as `0x${string}`;
  const factoryAddr = cfg.factory as `0x${string}`;
  const tokenIdBig = BigInt(p.tokenId);
  const slippageBps = parseSlippageBps({
    slippageBps: p.slippageBps,
    acknowledgeHighSlippage: p.acknowledgeHighSlippage,
  });

  const pos = await readOwnedPosition(p.chain, positionManager, p.wallet, tokenIdBig);

  if (pos.liquidity === 0n) {
    throw new Error(
      `Position #${p.tokenId} has zero liquidity already — nothing to decrease. ` +
        `If you want to harvest fees only, use \`prepare_uniswap_v3_collect\`. ` +
        `If you want to remove the NFT entirely, use \`prepare_uniswap_v3_burn\`.`,
    );
  }

  const liquidityToBurn =
    p.liquidity !== undefined
      ? BigInt(p.liquidity)
      : (pos.liquidity * BigInt(p.liquidityPct!)) / 100n;
  if (liquidityToBurn === 0n) {
    throw new Error(
      `liquidityPct=${p.liquidityPct} on position #${p.tokenId} resolved to 0. ` +
        `Pass a higher percentage or use raw \`liquidity\`.`,
    );
  }
  if (liquidityToBurn > pos.liquidity) {
    throw new Error(
      `liquidity=${liquidityToBurn} exceeds position liquidity ${pos.liquidity}.`,
    );
  }

  const client = getClient(p.chain);
  const [meta, poolAddr] = await Promise.all([
    resolveTokenPairMeta(p.chain, [pos.token0, pos.token1]),
    client.readContract({
      address: factoryAddr,
      abi: uniswapFactoryAbi,
      functionName: "getPool",
      args: [pos.token0, pos.token1, pos.fee],
    }) as Promise<`0x${string}`>,
  ]);
  if (poolAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Uniswap V3 pool ${pos.token0}/${pos.token1} fee=${pos.fee} on ${p.chain} ` +
        `does not resolve. Investigate.`,
    );
  }
  const [symbol0, symbol1] = [meta[0].symbol, meta[1].symbol];

  const [slot0] = await client.multicall({
    contracts: [
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "slot0" },
    ],
    allowFailure: false,
  });
  const sqrtPriceX96 = (slot0 as readonly [bigint, number, ...unknown[]])[0];
  const currentTick = Number((slot0 as readonly [bigint, number, ...unknown[]])[1]);

  const tickSpacing = TICK_SPACINGS[pos.fee];
  if (!tickSpacing) {
    throw new Error(
      `Uniswap V3 position ${p.tokenId} has unknown fee tier ${pos.fee}.`,
    );
  }

  const { amount0: amount0Min, amount1: amount1Min } = burnAmountsWithSlippage({
    pool: {
      fee: pos.fee,
      sqrtRatioX96: sqrtPriceX96,
      tickCurrent: currentTick,
      tickSpacing,
    },
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: liquidityToBurn,
    slippageBps,
  });

  const deadlineSec = p.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const data = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: tokenIdBig,
        liquidity: liquidityToBurn,
        amount0Min,
        amount1Min,
        deadline,
      },
    ],
  });
  const pctLabel =
    p.liquidityPct !== undefined ? `${p.liquidityPct}%` : `${liquidityToBurn} raw`;
  return {
    chain: p.chain,
    to: positionManager,
    data,
    value: "0",
    from: p.wallet,
    description:
      `Decrease Uniswap V3 LP position #${p.tokenId} by ${pctLabel} ` +
      `(${symbol0}/${symbol1} at ${pos.fee / 10_000}% fee, slippage ${slippageBps} bps). ` +
      `Withdrawn tokens become tokensOwed on the position — follow up with ` +
      `prepare_uniswap_v3_collect to actually move them to the wallet.`,
    decoded: {
      functionName: "decreaseLiquidity",
      args: {
        tokenId: p.tokenId,
        liquidity: liquidityToBurn.toString(),
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),
        deadline: deadline.toString(),
      },
    },
  };
}

export interface BuildUniswapCollectParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  tokenId: string;
  /** Recipient of the harvested tokens. Default: wallet. */
  recipient?: `0x${string}`;
}

/**
 * Build an unsigned `collect()` tx that harvests every token the
 * position is owed (decreased liquidity + accrued fees) up to
 * `uint128.max` per side. The on-chain implementation pays out the
 * lesser of `tokensOwed` and the provided cap, so passing the max
 * is the standard way to drain everything in one call.
 */
export async function buildUniswapCollect(
  p: BuildUniswapCollectParams,
): Promise<UnsignedTx> {
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  const positionManager = cfg.positionManager as `0x${string}`;
  const tokenIdBig = BigInt(p.tokenId);
  const pos = await readOwnedPosition(p.chain, positionManager, p.wallet, tokenIdBig);

  // tokensOwed* on the position struct is the *settled* fee + decreased-
  // liquidity buffer. Uncollected fees that haven't been settled to the
  // position struct yet (the fee-growth tracker delta) ALSO get
  // harvested by collect() — the protocol updates owed first inside the
  // call. So a position with tokensOwed0 = 0 may still receive tokens,
  // and we should not refuse on that basis.
  const recipient = p.recipient ?? p.wallet;

  const client = getClient(p.chain);
  const meta = await resolveTokenPairMeta(p.chain, [pos.token0, pos.token1]);
  const [symbol0, symbol1] = [meta[0].symbol, meta[1].symbol];
  void client;

  const data = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId: tokenIdBig,
        recipient,
        amount0Max: U128_MAX,
        amount1Max: U128_MAX,
      },
    ],
  });
  return {
    chain: p.chain,
    to: positionManager,
    data,
    value: "0",
    from: p.wallet,
    description:
      `Collect Uniswap V3 LP position #${p.tokenId} fees + tokensOwed (${symbol0}/${symbol1}) ` +
      `to ${recipient.toLowerCase() === p.wallet.toLowerCase() ? "wallet" : recipient}. ` +
      `Harvests everything (amount0Max=amount1Max=uint128.max).`,
    decoded: {
      functionName: "collect",
      args: {
        tokenId: p.tokenId,
        recipient,
        amount0Max: "uint128.max",
        amount1Max: "uint128.max",
      },
    },
  };
}

export interface BuildUniswapBurnParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  tokenId: string;
}

/**
 * Build an unsigned `burn()` tx that destroys the position NFT.
 *
 * Hard-refuses unless the position is already drained: liquidity == 0
 * AND tokensOwed0 == 0 AND tokensOwed1 == 0. The on-chain call would
 * revert otherwise; refusing at prepare time gives the caller a more
 * actionable error pointing at the right sequence (decrease → collect
 * → burn, or use rebalance).
 */
export async function buildUniswapBurn(
  p: BuildUniswapBurnParams,
): Promise<UnsignedTx> {
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  const positionManager = cfg.positionManager as `0x${string}`;
  const tokenIdBig = BigInt(p.tokenId);
  const pos = await readOwnedPosition(p.chain, positionManager, p.wallet, tokenIdBig);

  if (pos.liquidity > 0n) {
    throw new Error(
      `Position #${p.tokenId} still has liquidity=${pos.liquidity}. ` +
        `burn() reverts on a position with non-zero liquidity. Run ` +
        `prepare_uniswap_v3_decrease_liquidity({ liquidityPct: 100 }) first, ` +
        `then prepare_uniswap_v3_collect, then this. (Or use rebalance to ` +
        `compose the whole thing in one tx.)`,
    );
  }
  if (pos.tokensOwed0 > 0n || pos.tokensOwed1 > 0n) {
    throw new Error(
      `Position #${p.tokenId} has unharvested tokensOwed (${pos.tokensOwed0} token0, ` +
        `${pos.tokensOwed1} token1). burn() reverts unless both are 0. Run ` +
        `prepare_uniswap_v3_collect first to harvest them, then burn.`,
    );
  }

  const data = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "burn",
    args: [tokenIdBig],
  });
  return {
    chain: p.chain,
    to: positionManager,
    data,
    value: "0",
    from: p.wallet,
    description:
      `Burn Uniswap V3 LP NFT #${p.tokenId} (irreversible — destroys the position record).`,
    decoded: {
      functionName: "burn",
      args: { tokenId: p.tokenId },
    },
  };
}

export interface BuildUniswapRebalanceParams {
  chain: SupportedChain;
  wallet: `0x${string}`;
  /** Position to rebalance — its (token0, token1, fee) are reused for the new mint. */
  tokenId: string;
  /** New lower tick (must align to feeTier's tickSpacing, must be < newTickUpper). */
  newTickLower: number;
  /** New upper tick. */
  newTickUpper: number;
  /**
   * Whether to also burn the old NFT in the same multicall. v1 default
   * is true — the old position has zero liquidity after the decrease+
   * collect phases and a stub NFT serves no purpose. Set to false to
   * keep the old tokenId alive (e.g. for off-chain bookkeeping).
   */
  burnOld?: boolean;
  slippageBps?: number;
  acknowledgeHighSlippage?: boolean;
  deadlineSec?: number;
  approvalCap?: string;
}

/**
 * Build an unsigned `multicall()` tx that rebalances a Uniswap V3 LP
 * position from its current tick range to a new one in a single
 * transaction. Composes:
 *
 *   1. `decreaseLiquidity({ liquidity: 100% })` — burns the old
 *      position's liquidity, settles tokens to `tokensOwed`.
 *   2. `collect({ amount0Max=u128.max, amount1Max=u128.max })` —
 *      moves the tokens from `tokensOwed` to the wallet (recipient).
 *   3. `burn(oldTokenId)` — only if `burnOld: true` (default).
 *   4. `mint({ ..., tickLower: newTickLower, tickUpper: newTickUpper })`
 *      — opens a new position over the new range.
 *
 * Slippage is **compounded** across the close + re-deposit steps: a
 * 50 bps user input applies to BOTH the burn-side floor and the
 * mint-side floor, so the effective tolerance against the spot price
 * is roughly 2× input bps. The description surfaces this explicitly so
 * the user sees the real bound.
 *
 * v1 amount-source choice: the new mint's `amount0Desired`/
 * `amount1Desired` are estimated from the position's expected burn
 * amounts (`burnAmounts` at current price). On-chain, the actual
 * minted amounts are bounded by what was actually collected; any
 * surplus is refunded to the wallet by the NPM contract. This is the
 * standard Uniswap UI client-side approach — a smart-contract-helper
 * alternative would deploy a thin rebalancer contract and is out of
 * scope.
 *
 * Hard refusals (same as the underlying tools):
 *   - tokenId not owned by `wallet`
 *   - tick alignment mismatch on the new range
 *   - new range identical to old (no-op rebalance)
 *
 * NOTE on approvals: rebalance starts from a position that already
 * holds the user's tokens — the close phase pulls them BACK to the
 * wallet via collect, then the mint phase pulls them again via the
 * NPM's transferFrom. So we still need ERC-20 approvals for the new
 * mint. Up to two are chained ahead of the multicall().
 */
export async function buildUniswapRebalance(
  p: BuildUniswapRebalanceParams,
): Promise<UnsignedTx> {
  const cfg = CONTRACTS[p.chain]?.uniswap;
  if (!cfg) {
    throw new Error(`Uniswap V3 is not registered on ${p.chain}.`);
  }
  const positionManager = cfg.positionManager as `0x${string}`;
  const factoryAddr = cfg.factory as `0x${string}`;
  const tokenIdBig = BigInt(p.tokenId);
  const burnOld = p.burnOld ?? true;
  const slippageBps = parseSlippageBps({
    slippageBps: p.slippageBps,
    acknowledgeHighSlippage: p.acknowledgeHighSlippage,
  });

  const pos = await readOwnedPosition(p.chain, positionManager, p.wallet, tokenIdBig);

  if (pos.liquidity === 0n) {
    throw new Error(
      `Position #${p.tokenId} has zero liquidity — nothing to rebalance. ` +
        `Use \`prepare_uniswap_v3_collect\` if there are still fees to harvest, ` +
        `or \`prepare_uniswap_v3_burn\` to remove the empty NFT.`,
    );
  }
  if (p.newTickLower >= p.newTickUpper) {
    throw new Error(
      `newTickLower (${p.newTickLower}) must be < newTickUpper (${p.newTickUpper}).`,
    );
  }
  if (p.newTickLower === pos.tickLower && p.newTickUpper === pos.tickUpper) {
    throw new Error(
      `New range [${p.newTickLower}, ${p.newTickUpper}] is identical to the existing ` +
        `position range. Refusing — rebalance is a no-op. Use ` +
        `\`prepare_uniswap_v3_increase_liquidity\` if you want to add to this position.`,
    );
  }

  const tickSpacing = TICK_SPACINGS[pos.fee];
  if (!tickSpacing) {
    throw new Error(
      `Position #${p.tokenId} has unknown fee tier ${pos.fee}.`,
    );
  }
  if (
    p.newTickLower % tickSpacing !== 0 ||
    p.newTickUpper % tickSpacing !== 0
  ) {
    throw new Error(
      `newTickLower/newTickUpper must align to tickSpacing=${tickSpacing} for fee tier ${pos.fee}. ` +
        `Got ${p.newTickLower}/${p.newTickUpper}; nearest usable: ` +
        `${nearestUsableTick(p.newTickLower, tickSpacing)}/` +
        `${nearestUsableTick(p.newTickUpper, tickSpacing)}.`,
    );
  }

  const client = getClient(p.chain);
  const [meta, poolAddr] = await Promise.all([
    resolveTokenPairMeta(p.chain, [pos.token0, pos.token1]),
    client.readContract({
      address: factoryAddr,
      abi: uniswapFactoryAbi,
      functionName: "getPool",
      args: [pos.token0, pos.token1, pos.fee],
    }) as Promise<`0x${string}`>,
  ]);
  if (poolAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Uniswap V3 pool ${pos.token0}/${pos.token1} fee=${pos.fee} on ${p.chain} ` +
        `does not resolve. Investigate.`,
    );
  }
  const [decimals0, decimals1] = [meta[0].decimals, meta[1].decimals];
  const [symbol0, symbol1] = [meta[0].symbol, meta[1].symbol];

  const [slot0] = await client.multicall({
    contracts: [
      { address: poolAddr, abi: uniswapPoolAbi, functionName: "slot0" },
    ],
    allowFailure: false,
  });
  const sqrtPriceX96 = (slot0 as readonly [bigint, number, ...unknown[]])[0];
  const currentTick = Number((slot0 as readonly [bigint, number, ...unknown[]])[1]);
  const poolState: PoolState = {
    fee: pos.fee,
    sqrtRatioX96: sqrtPriceX96,
    tickCurrent: currentTick,
    tickSpacing,
  };

  const deadlineSec = p.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  // ===== Close phase =====

  // 1. decreaseLiquidity → amount0Min/amount1Min via burnAmountsWithSlippage.
  const { amount0: closeAmount0Min, amount1: closeAmount1Min } =
    burnAmountsWithSlippage({
      pool: poolState,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
      slippageBps,
    });
  const decreaseData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: tokenIdBig,
        liquidity: pos.liquidity,
        amount0Min: closeAmount0Min,
        amount1Min: closeAmount1Min,
        deadline,
      },
    ],
  });

  // 2. collect → harvest both decreased liquidity AND any accrued fees.
  //    Recipient = wallet so the new mint can pull the tokens via approval.
  const collectData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId: tokenIdBig,
        recipient: p.wallet,
        amount0Max: U128_MAX,
        amount1Max: U128_MAX,
      },
    ],
  });

  // 3. burn (optional). Skipped → the user keeps an empty stub NFT.
  const burnData = burnOld
    ? encodeFunctionData({
        abi: uniswapPositionManagerAbi,
        functionName: "burn",
        args: [tokenIdBig],
      })
    : null;

  // ===== Open phase =====

  // 4. mint with the new range. amount0Desired/amount1Desired estimated
  //    from the close-phase amounts (burnAmounts at current price);
  //    actual mint pulls bounded by what was actually collected and
  //    refunds any surplus.
  // burnAmounts at current price (no slippage applied) approximates
  // what `collect` will route to the wallet. Round-down math matches
  // on-chain accounting more closely than the mint-side round-up.
  const closeEstimate = burnAmounts({
    pool: poolState,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: pos.liquidity,
  });

  const { amount0: mintAmount0Min, amount1: mintAmount1Min } =
    mintAmountsWithSlippage({
      pool: poolState,
      tickLower: p.newTickLower,
      tickUpper: p.newTickUpper,
      amount0Desired: closeEstimate.amount0,
      amount1Desired: closeEstimate.amount1,
      slippageBps,
    });
  const mintData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "mint",
    args: [
      {
        token0: pos.token0,
        token1: pos.token1,
        fee: pos.fee,
        tickLower: p.newTickLower,
        tickUpper: p.newTickUpper,
        amount0Desired: closeEstimate.amount0,
        amount1Desired: closeEstimate.amount1,
        amount0Min: mintAmount0Min,
        amount1Min: mintAmount1Min,
        recipient: p.wallet,
        deadline,
      },
    ],
  });

  // ===== Compose multicall(bytes[]) =====

  const innerCalls: `0x${string}`[] = [decreaseData, collectData];
  if (burnData) innerCalls.push(burnData);
  innerCalls.push(mintData);

  const multicallData = encodeFunctionData({
    abi: uniswapPositionManagerAbi,
    functionName: "multicall",
    args: [innerCalls],
  });

  const effectiveBpsLabel = `${slippageBps} bps each side (~${slippageBps * 2} bps total — close + re-deposit are independently bounded)`;
  const rebalanceTx: UnsignedTx = {
    chain: p.chain,
    to: positionManager,
    data: multicallData,
    value: "0",
    from: p.wallet,
    description:
      `Rebalance Uniswap V3 LP position #${p.tokenId} ` +
      `(${symbol0}/${symbol1} at ${pos.fee / 10_000}% fee): ` +
      `[${pos.tickLower}, ${pos.tickUpper}] → [${p.newTickLower}, ${p.newTickUpper}]. ` +
      `Multicall: decreaseLiquidity(100%) + collect + ${burnOld ? "burn + " : ""}mint(new range). ` +
      `Slippage ${effectiveBpsLabel}.`,
    decoded: {
      functionName: "multicall",
      args: {
        innerCalls: String(innerCalls.length),
        steps: burnOld
          ? "decreaseLiquidity → collect → burn → mint"
          : "decreaseLiquidity → collect → mint",
        oldRange: `[${pos.tickLower}, ${pos.tickUpper}]`,
        newRange: `[${p.newTickLower}, ${p.newTickUpper}]`,
        slippageBps: String(slippageBps),
      },
    },
  };

  // Approvals — after collect routes the tokens back to the wallet, the
  // mint phase pulls them via the NPM's transferFrom. Estimate the
  // mint-side requirements at the close-estimate amounts.
  const approvals: Array<UnsignedTx | null> = [];
  if (closeEstimate.amount0 > 0n) {
    const cap0 = resolveApprovalCap(
      p.approvalCap,
      closeEstimate.amount0,
      decimals0,
    );
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: pos.token0,
        spender: positionManager,
        amountWei: closeEstimate.amount0,
        approvalAmount: cap0.approvalAmount,
        approvalDisplay: cap0.display,
        symbol: symbol0,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }
  if (closeEstimate.amount1 > 0n) {
    const cap1 = resolveApprovalCap(
      p.approvalCap,
      closeEstimate.amount1,
      decimals1,
    );
    approvals.push(
      await buildApprovalTx({
        chain: p.chain,
        wallet: p.wallet,
        asset: pos.token1,
        spender: positionManager,
        amountWei: closeEstimate.amount1,
        approvalAmount: cap1.approvalAmount,
        approvalDisplay: cap1.display,
        symbol: symbol1,
        spenderLabel: "Uniswap V3 NonfungiblePositionManager",
      }),
    );
  }

  return chainApprovals(approvals, rebalanceTx);
}

// Re-export erc20Abi so future builders in this module don't need a
// duplicate import; tests also reach for it.
export { erc20Abi };
