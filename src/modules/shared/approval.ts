import { encodeFunctionData, parseUnits, maxUint256 } from "viem";
import { z } from "zod";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Shared ERC-20 approval builder. Every prepare_* tool that needs an allowance
 * before its main call routes through buildApprovalTx() so the USDT reset
 * pattern, the optional cap logic, and the description string stay in one
 * place. Previously each module hand-rolled its own `ensureApprovalTx` with
 * subtle divergences (some exact, some unlimited, some missing the USDT
 * reset).
 */

/**
 * Resolves the caller-supplied `approvalCap` to a concrete bigint and a
 * human-readable display string.
 *
 * Semantics:
 *   undefined / "unlimited" → maxUint256 (traditional DeFi UX default)
 *   "exact"                 → amountWei (approve only what's needed)
 *   decimal string ("500")  → parseUnits(cap, decimals), must be ≥ amountWei
 *
 * Callers decide the default for their tool by the value they pass: omit the
 * arg to get "unlimited", or hardcode "exact" (Aave / swap already do this).
 */
export function resolveApprovalCap(
  cap: string | undefined,
  amountWei: bigint,
  decimals: number
): { approvalAmount: bigint; display: string } {
  if (cap === undefined || cap === "unlimited") {
    return { approvalAmount: maxUint256, display: "unlimited" };
  }
  if (cap === "exact") {
    return { approvalAmount: amountWei, display: "exact amount" };
  }
  const parsed = parseUnits(cap, decimals);
  if (parsed < amountWei) {
    throw new Error(
      `approvalCap (${cap}) is less than the amount being transacted. ` +
        `Raise the cap, omit it for "unlimited", or pass "exact".`
    );
  }
  return { approvalAmount: parsed, display: `${cap} (capped)` };
}

export interface BuildApprovalArgs {
  chain: SupportedChain;
  wallet: `0x${string}`;
  asset: `0x${string}`;
  spender: `0x${string}`;
  /** Amount the follow-up action will actually pull (required on-chain). */
  amountWei: bigint;
  /** Amount to approve; resolved via resolveApprovalCap. */
  approvalAmount: bigint;
  /** Display-only label for the cap (unlimited / exact amount / N capped). */
  approvalDisplay: string;
  symbol: string;
  /** Spender label for descriptions, e.g. "Compound V3 cUSDCv3". */
  spenderLabel: string;
}

/**
 * Build an approve tx (or a reset→approve chain for USDT-style tokens).
 * Returns null when the current allowance already covers `amountWei` —
 * no approval needed.
 *
 * Note: we key the "skip" check off amountWei (what the action needs), not
 * approvalAmount (what the cap says). If the user's cap is lower than their
 * current allowance, we leave the allowance alone rather than reducing it.
 * Reducing would be an extra tx the user didn't ask for.
 */
export async function buildApprovalTx(a: BuildApprovalArgs): Promise<UnsignedTx | null> {
  const client = getClient(a.chain);
  const allowance = (await client.readContract({
    address: a.asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [a.wallet, a.spender],
  })) as bigint;
  if (allowance >= a.amountWei) return null;

  const approveTx: UnsignedTx = {
    chain: a.chain,
    to: a.asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [a.spender, a.approvalAmount],
    }),
    value: "0",
    from: a.wallet,
    description: `Approve ${a.symbol} for ${a.spenderLabel} (${a.approvalDisplay})`,
    decoded: {
      functionName: "approve",
      args: { spender: a.spender, amount: a.approvalDisplay },
    },
  };

  if (allowance > 0n) {
    // USDT-style reset: some ERC-20s (notably USDT on Ethereum) revert on
    // approve(nonzero → nonzero). Chain approve(0) → approve(N).
    return {
      chain: a.chain,
      to: a.asset,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [a.spender, 0n],
      }),
      value: "0",
      from: a.wallet,
      description: `Reset ${a.symbol} allowance to 0 (required by USDT-style tokens before re-approval)`,
      decoded: { functionName: "approve", args: { spender: a.spender, amount: "0" } },
      next: approveTx,
    };
  }

  return approveTx;
}

/**
 * Zod schema fragment for an optional `approvalCap` tool parameter. Share
 * across every prepare_* tool that emits an approval.
 */
export const approvalCapSchema = z
  .string()
  .describe(
    "Cap on the ERC-20 approval preceding this action. " +
      'Omit for "unlimited" (standard DeFi UX — fewer follow-up approvals). ' +
      'Pass "exact" to approve only what this action pulls. ' +
      'Pass a decimal string (e.g. "500") for a specific ceiling in the asset\'s human units; ' +
      "must be ≥ the action amount, otherwise the transaction would revert."
  )
  .optional();
