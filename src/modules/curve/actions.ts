/**
 * Curve write-side actions — v0.1.
 *
 * Single tool: `prepare_curve_add_liquidity` for stable_ng plain pools on
 * Ethereum. Bundles ERC-20 approvals (one per non-zero deposit slot)
 * before the add_liquidity call via `chainApproval`. Per the existing
 * Aave / Compound pattern in this codebase.
 *
 * Slippage gate: caller passes either `minLpOut` (explicit) or
 * `slippageBps` (server computes via `calc_token_amount`). Refusing to
 * accept neither is the conservative-default (better to require the
 * gate explicitly than to silently default to 0 and let the user lose
 * to MEV).
 */
import { encodeFunctionData, type Address } from "viem";
import { getClient } from "../../data/rpc.js";
import {
  buildApprovalTx,
  chainApproval,
  resolveApprovalCap,
} from "../shared/approval.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import {
  curveStableNgFactoryAbi,
  curveStableNgPlainPoolAbi,
} from "../../abis/curve.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { UnsignedTx } from "../../types/index.js";
import type { PrepareCurveAddLiquidityArgs } from "./schemas.js";

/**
 * Build a `prepare_curve_add_liquidity` UnsignedTx (with bundled
 * approvals) for a stable_ng plain pool on Ethereum.
 *
 * Validation order:
 *   1. Reject meta pools — out of v0.1 scope (different ABI).
 *   2. Confirm `amounts.length === N_COINS` of the pool.
 *   3. Resolve `minLpOut` from explicit value or slippageBps.
 *   4. Build per-asset approvals (skip slots with zero amount).
 *   5. Encode add_liquidity call.
 *   6. Return chained approval(s) + action.
 */
export async function buildCurveAddLiquidity(
  p: PrepareCurveAddLiquidityArgs,
): Promise<UnsignedTx> {
  const wallet = p.wallet as Address;
  const pool = p.pool as Address;
  const factory = CONTRACTS.ethereum.curve.stableNgFactory as Address;
  const client = getClient("ethereum");

  // Read pool metadata + N_COINS in one multicall.
  const [isMetaR, nCoinsR, coinsR] = await client.multicall({
    contracts: [
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "is_meta",
        args: [pool],
      },
      {
        address: pool,
        abi: curveStableNgPlainPoolAbi,
        functionName: "N_COINS",
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_coins",
        args: [pool],
      },
    ],
    allowFailure: false,
  });

  if (isMetaR === true) {
    throw new Error(
      `Curve pool ${pool} is a meta pool. v0.1 only supports plain stable_ng pools — meta-pool support tracked as a follow-up. Use a plain pool's address (call \`get_curve_positions\` to discover them).`,
    );
  }
  const nCoins = Number(nCoinsR as bigint);
  if (p.amounts.length !== nCoins) {
    throw new Error(
      `Pool ${pool} has N_COINS=${nCoins}, but ${p.amounts.length} amounts were provided. Pad with '0' for slots you're not depositing into.`,
    );
  }

  const amountsBig = p.amounts.map((a) => BigInt(a));

  // Resolve minLpOut.
  let minLpOut: bigint;
  if (p.minLpOut !== undefined) {
    minLpOut = BigInt(p.minLpOut);
  } else if (p.slippageBps !== undefined) {
    const expected = (await client.readContract({
      address: pool,
      abi: curveStableNgPlainPoolAbi,
      functionName: "calc_token_amount",
      args: [amountsBig, true],
    })) as bigint;
    // expected * (10000 - slippageBps) / 10000
    minLpOut = (expected * BigInt(10000 - p.slippageBps)) / 10000n;
  } else {
    throw new Error(
      "prepare_curve_add_liquidity requires either `minLpOut` (explicit) or `slippageBps`. The pool's add_liquidity refuses without a slippage floor; setting one explicitly avoids MEV-adjacent loss.",
    );
  }

  // Encode the add_liquidity call.
  const addLiquidityData = encodeFunctionData({
    abi: curveStableNgPlainPoolAbi,
    functionName: "add_liquidity",
    args: [amountsBig, minLpOut],
  });

  // Build approvals — one per non-zero deposit slot.
  const coins = (coinsR as readonly Address[]).slice(0, nCoins);
  const symbols: string[] = [];
  let chainedApproval: UnsignedTx | null = null;
  for (let i = 0; i < nCoins; i++) {
    const amt = amountsBig[i];
    if (amt === 0n) continue;
    const asset = coins[i];
    const meta = await resolveTokenMeta("ethereum", asset);
    symbols.push(`${p.amounts[i]}-raw ${meta.symbol}`);
    const { approvalAmount, display } = resolveApprovalCap(
      p.approvalCap,
      amt,
      meta.decimals,
    );
    const a = await buildApprovalTx({
      chain: "ethereum",
      wallet,
      asset,
      spender: pool,
      amountWei: amt,
      approvalAmount,
      approvalDisplay: display,
      symbol: meta.symbol,
      spenderLabel: `Curve stable_ng plain pool ${pool}`,
    });
    if (a !== null) {
      chainedApproval = chainedApproval === null ? a : chainApproval(chainedApproval, a);
    }
  }

  const addTx: UnsignedTx = {
    chain: "ethereum",
    to: pool,
    data: addLiquidityData,
    value: "0",
    from: wallet,
    description: `Add liquidity to Curve stable_ng pool ${pool} (${symbols.join(", ")})`,
    decoded: {
      functionName: "add_liquidity",
      args: {
        pool,
        amounts: p.amounts.join(","),
        minLpOut: minLpOut.toString(),
        ...(p.slippageBps !== undefined ? { slippageBps: String(p.slippageBps) } : {}),
      },
    },
  };

  return chainedApproval === null ? addTx : chainApproval(chainedApproval, addTx);
}
