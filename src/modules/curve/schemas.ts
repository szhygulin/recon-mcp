import { z } from "zod";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";
import { approvalCapSchema } from "../shared/approval.js";

const evmAddress = z.string().regex(EVM_ADDRESS);

export const getCurvePositionsInput = z.object({
  wallet: evmAddress.describe(
    "0x EVM wallet address. v0.1 only reads Ethereum stable_ng plain pools — Arbitrum / Polygon and other factory variants land in follow-up PRs.",
  ),
});
export type GetCurvePositionsArgs = z.infer<typeof getCurvePositionsInput>;

export const prepareCurveAddLiquidityInput = z.object({
  wallet: evmAddress.describe("0x EVM wallet address that will sign the tx."),
  pool: evmAddress.describe(
    "Pool address (== LP token address on stable_ng). Must be a stable_ng plain pool — meta pools rejected with a clear error in v0.1; use `get_curve_positions` to discover valid pools the wallet has access to.",
  ),
  /**
   * Per-coin deposit amounts. Length MUST match the pool's `N_COINS`.
   * Single-token deposits = pass amounts with zeros in the unused slots.
   * Use raw token units (apply per-coin decimals before passing).
   */
  amounts: z
    .array(z.string().regex(/^\d+$/))
    .min(1)
    .max(8)
    .describe(
      "Per-coin deposit amounts as decimal-string-encoded uint256, in the order returned by `get_curve_positions(...).coins`. Length must match the pool's N_COINS. Pass '0' for slots you're not depositing into (single-coin deposit).",
    ),
  /**
   * Slippage protection. Caller picks one of:
   *   - `minLpOut` — explicit minimum LP tokens to receive
   *   - `slippageBps` — server computes minLpOut = expected * (1 - slippageBps / 10000)
   *   - neither: rejected (require explicit slippage choice)
   */
  minLpOut: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Explicit minimum LP tokens to receive (decimal-string uint256). Passes through to the pool's `add_liquidity(amounts, min_mint_amount)`. Either `minLpOut` or `slippageBps` is required.",
    ),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Server-side slippage allowance in basis points (e.g. 50 = 0.5%). When set, `minLpOut = calc_token_amount * (1 - slippageBps / 10000)`. Capped at 10% (1000 bps) to prevent accidental wide gates. Either `minLpOut` or `slippageBps` is required.",
    ),
  approvalCap: approvalCapSchema.optional(),
});
export type PrepareCurveAddLiquidityArgs = z.infer<
  typeof prepareCurveAddLiquidityInput
>;
