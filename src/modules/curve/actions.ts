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
import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { getClient } from "../../data/rpc.js";
import {
  buildApprovalTx,
  chainApproval,
  resolveApprovalCap,
} from "../shared/approval.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import {
  curveLegacyStableSwapAbi,
  curveStableNgFactoryAbi,
  curveStableNgPlainPoolAbi,
} from "../../abis/curve.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { UnsignedTx } from "../../types/index.js";
import type {
  PrepareCurveAddLiquidityArgs,
  PrepareCurveSwapArgs,
} from "./schemas.js";

/**
 * Indices on the canonical Curve stETH/ETH legacy StableSwap pool
 * (`0xDC24316b9AE028F1497c275EB9192a3Ea0f67022`). Verified on
 * Etherscan: `coins(0)` returns the ETH sentinel
 * `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` and `coins(1)` returns
 * stETH `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84`.
 */
const STETH_POOL_COIN_ETH = 0;
const STETH_POOL_COIN_STETH = 1;

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

/**
 * Build a `prepare_curve_swap` UnsignedTx for the canonical Curve
 * stETH/ETH legacy StableSwap pool (issue #615). Pool coin order:
 * 0=ETH (native, payable), 1=stETH.
 *
 *   eth_to_steth: i=0, j=1, value=dx (native), no approval.
 *   steth_to_eth: i=1, j=0, value=0, prepended with stETH approval to
 *     the pool (USDT-style reset handled by `buildApprovalTx`).
 *
 * Slippage gate is required: caller passes `minOut` (explicit) or
 * `slippageBps` (server computes via `get_dy * (1 - bps/10000)`).
 * Refusing to default to zero protects against MEV — Curve's exchange
 * silently accepts `min_dy=0` and would deliver whatever the pool
 * state allows, including post-sandwich.
 *
 * Tighter spread than aggregators for stETH↔ETH: the pool is the
 * historical best venue for this pair (deeper liquidity, no aggregator
 * cut). Other Curve pools use distinct ABIs (cryptoswap, tricrypto,
 * stable_ng) and are NOT supported here — the schema's `direction`
 * enum is the entire surface. Adding a `pool` parameter without
 * per-pool ABI dispatch would silently encode wrong selectors.
 */
export async function buildCurveStethSwap(
  p: PrepareCurveSwapArgs,
): Promise<UnsignedTx> {
  const wallet = p.wallet as Address;
  const pool = CONTRACTS.ethereum.curve.stEthEthPool as Address;
  const stETH = CONTRACTS.ethereum.lido.stETH as Address;
  const client = getClient("ethereum");
  const dx = parseUnits(p.amount, 18);

  const ethToSteth = p.direction === "eth_to_steth";
  const i = ethToSteth ? STETH_POOL_COIN_ETH : STETH_POOL_COIN_STETH;
  const j = ethToSteth ? STETH_POOL_COIN_STETH : STETH_POOL_COIN_ETH;

  // Resolve min_dy. Mirrors `prepare_curve_add_liquidity`'s gate.
  let minDy: bigint;
  if (p.minOut !== undefined) {
    minDy = BigInt(p.minOut);
  } else if (p.slippageBps !== undefined) {
    if (p.slippageBps > 100 && p.acknowledgeHighSlippage !== true) {
      throw new Error(
        `Requested slippage is ${p.slippageBps} bps (${(p.slippageBps / 100).toFixed(2)}%). ` +
          `The default cap is 100 bps (1%) because anything higher is almost always a ` +
          `sandwich-bait misconfiguration. Retry with \`acknowledgeHighSlippage: true\` if ` +
          `genuinely intended.`,
      );
    }
    const expectedOut = (await client.readContract({
      address: pool,
      abi: curveLegacyStableSwapAbi,
      functionName: "get_dy",
      args: [BigInt(i), BigInt(j), dx],
    })) as bigint;
    minDy = (expectedOut * BigInt(10000 - p.slippageBps)) / 10000n;
  } else {
    throw new Error(
      "prepare_curve_swap requires either `minOut` (explicit decimal-string uint256) or " +
        "`slippageBps`. The pool's exchange() accepts min_dy=0 silently — defaulting to that " +
        "would let MEV extract the entire output, so the gate is mandatory.",
    );
  }

  const exchangeData = encodeFunctionData({
    abi: curveLegacyStableSwapAbi,
    functionName: "exchange",
    args: [BigInt(i), BigInt(j), dx, minDy],
  });

  const fromSym = ethToSteth ? "ETH" : "stETH";
  const toSym = ethToSteth ? "stETH" : "ETH";
  const minOutFormatted = formatUnits(minDy, 18);
  const description =
    `Swap ${p.amount} ${fromSym} → ≥${minOutFormatted} ${toSym} via Curve stETH/ETH pool ${pool}`;

  const swapTx: UnsignedTx = {
    chain: "ethereum",
    to: pool,
    data: exchangeData,
    value: ethToSteth ? dx.toString() : "0",
    from: wallet,
    description,
    decoded: {
      functionName: "exchange",
      args: {
        pool,
        i: String(i),
        j: String(j),
        dx: `${p.amount} ${fromSym}`,
        minOut: `${minOutFormatted} ${toSym}`,
        ...(p.slippageBps !== undefined ? { slippageBps: String(p.slippageBps) } : {}),
      },
    },
  };

  if (ethToSteth) return swapTx;

  // stETH → ETH: prepend ERC-20 approval of stETH to the pool. stETH
  // is a rebasing OpenZeppelin-style token, no USDT quirk, but
  // buildApprovalTx still handles the reset path defensively.
  const meta = await resolveTokenMeta("ethereum", stETH);
  const { approvalAmount, display } = resolveApprovalCap(p.approvalCap, dx, meta.decimals);
  const approval = await buildApprovalTx({
    chain: "ethereum",
    wallet,
    asset: stETH,
    spender: pool,
    amountWei: dx,
    approvalAmount,
    approvalDisplay: display,
    symbol: meta.symbol,
    spenderLabel: `Curve stETH/ETH pool ${pool}`,
  });
  return chainApproval(approval, swapTx);
}
