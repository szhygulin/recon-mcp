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
import { mintAmountsWithSlippage, type PoolState } from "./position-math.js";
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

// Re-export erc20Abi so future builders in this module don't need a
// duplicate import; tests also reach for it.
export { erc20Abi };
