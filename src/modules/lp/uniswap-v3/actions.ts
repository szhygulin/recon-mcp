/**
 * Uniswap V3 LP write builders. Currently exposes `buildUniswapMint`
 * (PR1 of Milestone 1 in `claude-work/plan-dex-liquidity-provision.md`);
 * `_increase_liquidity`, `_decrease_liquidity`, `_collect`, `_burn`, and
 * `_rebalance` follow in subsequent PRs.
 *
 * Architecture (Option C from the SDK scope-probe):
 *   - Slippage-aware Position math comes from `@uniswap/v3-sdk`'s
 *     `Position.fromAmounts` + `mintAmountsWithSlippage`. That code is
 *     bit-shifty Q64.96 sqrt-ratio math we don't want to reimplement.
 *   - Calldata for the NPM `mint(...)` call is encoded via viem's
 *     `encodeFunctionData` against `src/abis/uniswap-position-manager.ts`,
 *     keeping `@ethersproject/abi.Interface` out of our calldata path
 *     and the JSBI ↔ bigint conversion contained to the boundary
 *     between the SDK's Position output and the calldata args.
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
import {
  FeeAmount,
  Percent,
  Pool,
  Position,
  TICK_SPACINGS,
  Token,
  nearestUsableTick,
} from "./sdk.js";
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
  const tickSpacing = TICK_SPACINGS[p.feeTier as FeeAmount];
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
  const liquidity = poolLiquidity as bigint;

  // 4. Construct SDK Pool + Position. The SDK's bigints are JSBI; we
  //    feed them strings (BigintIsh) and consume the returned amounts
  //    via `.toString()` → native `BigInt(...)` at the boundary. The
  //    `useFullPrecision: true` mirrors the Uniswap UI for maximum
  //    liquidity-per-amount.
  const chainId = await client.getChainId();
  const tokenSdk0 = new Token(chainId, token0Addr, decimals0, symbol0);
  const tokenSdk1 = new Token(chainId, token1Addr, decimals1, symbol1);
  const pool = new Pool(
    tokenSdk0,
    tokenSdk1,
    p.feeTier as FeeAmount,
    sqrtPriceX96.toString(),
    liquidity.toString(),
    currentTick,
  );
  const position = Position.fromAmounts({
    pool,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    amount0: amount0Wei.toString(),
    amount1: amount1Wei.toString(),
    useFullPrecision: true,
  });

  // mintAmountsWithSlippage returns a slippage-bounded floor on each
  // side. Pass the SDK a `Percent(numerator, denominator)` matching our
  // bps: e.g. 50 bps → Percent(50, 10000).
  const slippagePercent = new Percent(slippageBps, 10_000);
  const { amount0: amount0Min, amount1: amount1Min } =
    position.mintAmountsWithSlippage(slippagePercent);

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
        amount0Min: BigInt(amount0Min.toString()),
        amount1Min: BigInt(amount1Min.toString()),
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

// Re-export erc20Abi so future builders in this module don't need a
// duplicate import; tests also reach for it.
export { erc20Abi };
