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

/**
 * `prepare_curve_swap` — issue #615. v0.1 scope: the canonical Curve
 * stETH/ETH legacy StableSwap pool only (`0xDC24316b9AE028F1497c275EB9192a3Ea0f67022`).
 * Other Curve pools (cryptoswap / tricrypto / stable_ng) use distinct
 * ABIs and are deferred to follow-up PRs. The `direction` enum is the
 * full surface — no `pool` parameter — because exposing other pools
 * without per-pool ABI dispatch would silently encode wrong selectors.
 */
export const prepareCurveSwapInput = z.object({
  wallet: evmAddress.describe("0x EVM wallet address that will sign the tx."),
  direction: z
    .enum(["eth_to_steth", "steth_to_eth"])
    .describe(
      "Swap direction. `eth_to_steth` sends native ETH as msg.value (no approval); `steth_to_eth` requires an ERC-20 approval of stETH to the pool first (chained automatically).",
    ),
  amount: z
    .string()
    .max(50)
    .regex(/^\d+(\.\d+)?$/)
    .describe(
      'Human-readable decimal input amount in the from-token (e.g. "1.5" for 1.5 ETH or 1.5 stETH). Decimals = 18 for both legs.',
    ),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%). When set, `min_dy = get_dy(i,j,dx) * (1 - slippageBps/10000)`. Either `slippageBps` or `minOut` is required — the pool refuses without a slippage floor and silently defaulting to 0 would leak to MEV. Capped at 5% (500 bps).",
    ),
  minOut: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Explicit minimum output in the to-token's wei (decimal-string uint256). Takes precedence over `slippageBps` when both are provided.",
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Required when `slippageBps > 100` (1%). Same gate as `prepare_swap` — sandwich-MEV bots target wide-slippage txs.",
    ),
  acknowledgeNonAllowlistedSpender: z
    .literal(true)
    .optional()
    .describe(
      "AFFIRMATIVE GATE — required for `direction: \"steth_to_eth\"`. The approve step targets the canonical Curve stETH/ETH pool " +
        "(0xDC24316b9AE028F1497c275EB9192a3Ea0f67022), which is NOT in the global protocol approve-allowlist (Aave Pool, Compound " +
        "Comet, Morpho Blue, Lido Queue, EigenLayer, Uniswap NPM, Uniswap SwapRouter02, LiFi Diamond). The allowlist is a security " +
        "recommendation, not a hard requirement: it limits approvals to a small set of well-known spenders to keep prompt-injection " +
        "drains from sliding through. Setting this flag is the user's affirmative ack that they understand the approval target sits " +
        "outside that curated set — the on-device clear-sign of `approve(<curve-pool>, <amount>)` and the prepare-receipt warning " +
        "advisory are the verification anchors. Do NOT default this to true silently; surface the trade-off to the user first. " +
        "Ignored for `direction: \"eth_to_steth\"` (no approval; native ETH is sent as msg.value).",
    ),
  approvalCap: approvalCapSchema.optional(),
});
export type PrepareCurveSwapArgs = z.infer<typeof prepareCurveSwapInput>;
