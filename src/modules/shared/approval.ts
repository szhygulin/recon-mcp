import { encodeFunctionData, parseUnits, maxUint256 } from "viem";
import { z } from "zod";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Distinctive description tag used whenever an approval is emitted at
 * maxUint256. Makes it easy to eyeball the Ledger preview text and also lets
 * tests assert the user-visible surfacing.
 */
export const UNLIMITED_APPROVAL_WARNING =
  "[WARNING: UNLIMITED APPROVAL — verify on Ledger device screen]";

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
 * Returns null when no approval tx is needed.
 *
 * Three outcomes, in order:
 *   1. Current allowance already satisfies the action AND the cap — return
 *      null. "Satisfies the cap" means: the user asked for "unlimited" (no
 *      cap), OR the existing allowance is ≤ approvalAmount. In other words,
 *      we only leave the allowance alone when doing so respects the caller's
 *      intent.
 *   2. Current allowance satisfies the action BUT exceeds an explicit cap —
 *      emit reset(0) → approve(cap). The user asked for a ceiling and we
 *      enforce it even if it means an extra tx. This is the fix for the
 *      silent-no-op footgun where a prior unlimited approval would defeat a
 *      new `approvalCap: "500"` request.
 *   3. Current allowance is below what the action needs — emit approve(cap)
 *      (or reset→approve for USDT-style tokens when allowance > 0).
 */
export async function buildApprovalTx(a: BuildApprovalArgs): Promise<UnsignedTx | null> {
  const client = getClient(a.chain);
  const allowance = (await client.readContract({
    address: a.asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [a.wallet, a.spender],
  })) as bigint;

  const isUnlimitedRequest = a.approvalAmount === maxUint256;
  const actionCovered = allowance >= a.amountWei;
  const capRespected = isUnlimitedRequest || allowance <= a.approvalAmount;

  // Case 1: existing allowance is already fine for the action and within the cap.
  if (actionCovered && capRespected) return null;

  const warning = isUnlimitedRequest ? ` ${UNLIMITED_APPROVAL_WARNING}` : "";
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
    description: `Approve ${a.symbol} for ${a.spenderLabel} (${a.approvalDisplay})${warning}`,
    decoded: {
      functionName: "approve",
      args: { spender: a.spender, amount: a.approvalDisplay },
    },
  };

  // Emit a reset whenever the current allowance is nonzero. Covers both the
  // USDT non-zero → non-zero revert AND the case-2 cap-enforcement rewrite
  // (reducing an existing allowance to the new cap).
  if (allowance > 0n) {
    const resetReason =
      actionCovered && !capRespected
        ? `Reduce ${a.symbol} allowance to respect approvalCap (was above the cap)`
        : `Reset ${a.symbol} allowance to 0 (required by USDT-style tokens before re-approval)`;
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
      description: resetReason,
      decoded: { functionName: "approve", args: { spender: a.spender, amount: "0" } },
      next: approveTx,
    };
  }

  return approveTx;
}

/**
 * Attach `next` to the end of an approval tx chain. If `approval` is null,
 * returns `next` unchanged — callers get the same one-liner either way,
 * replacing the `if (approval) { walk tail; attach; return approval; }
 * return next;` pattern every action builder used to hand-roll.
 */
export function chainApproval(approval: UnsignedTx | null, next: UnsignedTx): UnsignedTx {
  if (!approval) return next;
  let tail = approval;
  while (tail.next) tail = tail.next;
  tail.next = next;
  return approval;
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
