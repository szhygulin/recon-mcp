import { z } from "zod";
import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * `get_portfolio_diff` input shape. Mirrors the shape of
 * `get_portfolio_summary` for the wallet args, plus a `window` enum.
 *
 * At least one address must be supplied; everything else is optional.
 * Bitcoin is single-address only for the diff (multi-address BTC adds
 * material complexity for per-asset history walks; defer until asked).
 */
/**
 * Note: kept as a plain `ZodObject` (not `.refine()`-wrapped) because the
 * MCP server registration consumes `.shape` directly, which `ZodEffects`
 * doesn't expose. The "at least one address" invariant is enforced in
 * the handler instead via `assertAtLeastOneAddress` below.
 */
export const getPortfolioDiffInput = z.object({
  wallet: z
    .string()
    .regex(EVM_ADDRESS)
    .optional()
    .describe(
      "EVM wallet (Ethereum / Arbitrum / Polygon / Base / Optimism). " +
        "Used to fetch current balances and walk EVM tx history for the window.",
    ),
  tronAddress: z
    .string()
    .regex(TRON_ADDRESS)
    .optional()
    .describe(
      "TRON mainnet base58 address (T-prefix). Folds TRX + TRC-20 balances " +
        "and TRON history into the diff.",
    ),
  solanaAddress: z
    .string()
    .regex(SOLANA_ADDRESS)
    .optional()
    .describe(
      "Solana mainnet base58 pubkey. Folds SOL + SPL balances and Solana " +
        "history into the diff.",
    ),
  bitcoinAddress: z
    .string()
    .optional()
    .describe(
      "Bitcoin address (any type). Folds BTC balance + history. Only one " +
        "BTC address per call in v1.",
    ),
  window: z
    .enum(["24h", "7d", "30d", "ytd"])
    .default("30d")
    .describe(
      'Time window for the diff. "24h" / "7d" / "30d" are rolling; "ytd" is ' +
        "calendar-year-to-date (UTC). For periods longer than 30d the underlying " +
        "history fetcher's per-chain item cap (~50) may truncate flow accounting; " +
        "the response surfaces `truncated: true` when this happens.",
    ),
  format: z
    .enum(["structured", "narrative", "both"])
    .default("both")
    .describe(
      '"structured" returns the JSON envelope only. "narrative" returns only the ' +
        'pre-rendered string. "both" (default) returns both — agents typically use ' +
        "the narrative for verbatim relay and the structured for follow-up questions.",
    ),
});

export function assertAtLeastOneAddress(args: GetPortfolioDiffArgs): void {
  if (!args.wallet && !args.tronAddress && !args.solanaAddress && !args.bitcoinAddress) {
    throw new Error(
      "At least one of `wallet` / `tronAddress` / `solanaAddress` / `bitcoinAddress` is required.",
    );
  }
}

export type GetPortfolioDiffArgs = z.infer<typeof getPortfolioDiffInput>;

/**
 * One row per asset currently held — the per-asset breakdown for the
 * structured envelope. A row whose `endingValueUsd` and `startingValueUsd`
 * are both zero is omitted (the user neither held nor received this asset
 * during the window).
 */
export interface AssetDiffRow {
  symbol: string;
  /**
   * Asset identifier — EVM contract address, Solana mint, "native" for the
   * chain's native coin, etc. Used for display + as a stable key.
   */
  token: string;
  chain: string;
  startingQty: string;
  endingQty: string;
  /** Historical price at window start (USD per token). Absent if DefiLlama couldn't price it. */
  startingPriceUsd?: number;
  /** Current price (USD per token). Absent if DefiLlama couldn't price it. */
  endingPriceUsd?: number;
  startingValueUsd: number;
  endingValueUsd: number;
  /**
   * USD delta attributable to price moves alone, measured on the quantity
   * that was held the *entire* window. Computed as
   * `min(startingQty, endingQty) * (endingPrice - startingPrice)`.
   */
  priceEffectUsd: number;
  /**
   * USD delta attributable to quantity changes (deposits, withdrawals,
   * yield, swap legs). Computed as the residual:
   * `endingValue - startingValue - priceEffect`.
   */
  quantityEffectUsd: number;
  /**
   * Net flow in raw quantity for this asset during the window. Positive =
   * net inflow into the wallet; negative = net outflow.
   */
  netFlowQty: string;
  /** USD value of the net flow (sum of priced transfers). */
  netFlowUsd: number;
  /**
   * Set when the starting quantity reconstruction would have been negative
   * (user received the asset entirely within the window — they had zero at
   * window start). `startingQty` is then clamped to 0 and this flag fires
   * so the agent can mention it.
   */
  startedAtZero?: boolean;
}

export interface ChainDiffSlice {
  chain: string;
  startingValueUsd: number;
  endingValueUsd: number;
  topLevelChangeUsd: number;
  inflowsUsd: number;
  outflowsUsd: number;
  netFlowsUsd: number;
  /** Sum of `priceEffectUsd` across all assets on the chain. */
  priceEffectUsd: number;
  /**
   * Residual after price effect + net flows are accounted for. Catches
   * lending interest accrual, LST appreciation, swap PnL, MEV — anything
   * that isn't a clean per-asset price move or external transfer. Named
   * "other" because the v1 decomposition doesn't separate these further.
   */
  otherEffectUsd: number;
  perAsset: AssetDiffRow[];
  /** True if the per-chain history fetcher hit its row cap during the window. */
  truncated: boolean;
}

export interface PortfolioDiffSummary {
  window: "24h" | "7d" | "30d" | "ytd";
  windowStartIso: string;
  windowEndIso: string;

  startingValueUsd: number;
  endingValueUsd: number;
  topLevelChangeUsd: number;

  inflowsUsd: number;
  outflowsUsd: number;
  netFlowsUsd: number;
  priceEffectUsd: number;
  otherEffectUsd: number;

  perChain: ChainDiffSlice[];

  /** True if any per-chain history fetcher truncated. */
  truncated: boolean;
  /** "full" / "partial" / "none" — worst case across all priced lookups. */
  priceCoverage: "full" | "partial" | "none";
  /** Free-form notes — caveats, missing-data flags, scope reminders. */
  notes: string[];
  /** Pre-rendered narrative; absent when `format === "structured"`. */
  narrative?: string;
}
