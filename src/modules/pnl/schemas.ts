import { z } from "zod";
import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * `get_pnl_summary` input shape. Mirrors `get_portfolio_diff` for the
 * wallet args, swapping `window` for `period` and adding an `inception`
 * option (capped at 365d in v1 to keep the history fetch bounded).
 *
 * Same "at least one address" rule as the diff tool — enforced in the
 * handler via `assertAtLeastOneAddress` since the MCP server consumes
 * `.shape` directly and `ZodEffects` doesn't expose it.
 *
 * Bitcoin is intentionally NOT supported in v1 — the diff path's BTC
 * branch is "current balance only, no in-window flow accounting", which
 * means BTC's `pnlUsd` would always be the price effect on the held
 * balance with no net-flow component. That's misleading enough to
 * justify deferring the BTC branch entirely until in-window flow
 * accounting lands.
 */
export const getPnlSummaryInput = z.object({
  wallet: z
    .string()
    .regex(EVM_ADDRESS)
    .optional()
    .describe(
      "EVM wallet (Ethereum / Arbitrum / Polygon / Base / Optimism). " +
        "Used to fetch current balances and walk EVM tx history for the period.",
    ),
  tronAddress: z
    .string()
    .regex(TRON_ADDRESS)
    .optional()
    .describe(
      "TRON mainnet base58 address (T-prefix). Folds TRX + TRC-20 balances " +
        "and TRON history into the PnL.",
    ),
  solanaAddress: z
    .string()
    .regex(SOLANA_ADDRESS)
    .optional()
    .describe(
      "Solana mainnet base58 pubkey. Folds SOL + SPL balances and Solana " +
        "history into the PnL.",
    ),
  period: z
    .enum(["24h", "7d", "30d", "mtd", "ytd", "inception"])
    .default("30d")
    .describe(
      'Time window. "24h" / "7d" / "30d" are rolling; "mtd" is calendar-' +
        'month-to-date (UTC, from the 1st of the current month); "ytd" is ' +
        'calendar-year-to-date (UTC); "inception" is a 365-day rolling window ' +
        'in v1 — "since wallet creation" is approximated, not literal, to keep ' +
        "the history fetch bounded. Periods longer than ~30d may under-count " +
        "flows because the underlying history fetcher caps at ~50 items per " +
        "chain; the response surfaces `truncated: true` when this happens.",
    ),
});

export function assertAtLeastOneAddress(args: GetPnlSummaryArgs): void {
  if (!args.wallet && !args.tronAddress && !args.solanaAddress) {
    throw new Error(
      "At least one of `wallet` / `tronAddress` / `solanaAddress` is required.",
    );
  }
}

export type GetPnlSummaryArgs = z.infer<typeof getPnlSummaryInput>;

/**
 * Per-asset row in the PnL breakdown. Thin projection of the diff's
 * `AssetDiffRow` (which carries the same data plus extra
 * decomposition columns we don't want to surface in the simpler PnL
 * view).
 */
export interface PnlAssetRow {
  symbol: string;
  /** EVM contract address, Solana mint, "native" for the chain's native coin. */
  token: string;
  startingQty: string;
  endingQty: string;
  startingPriceUsd?: number;
  endingPriceUsd?: number;
  /** `endingValueUsd - startingValueUsd - netFlowUsd` — the per-asset PnL. */
  pnlUsd: number;
}

/**
 * Per-chain PnL slice. One per non-empty chain. Values are aggregated
 * from the diff's per-asset rows for the chain.
 */
export interface PnlChainSlice {
  chain: string;
  startingValueUsd: number;
  endingValueUsd: number;
  inflowsUsd: number;
  outflowsUsd: number;
  /** `(endingValueUsd - startingValueUsd) - (inflowsUsd - outflowsUsd)`. */
  pnlUsd: number;
  perAsset: PnlAssetRow[];
  /** True if the per-chain history fetcher hit its row cap during the window. */
  truncated: boolean;
}

/**
 * Top-level PnL summary returned by `get_pnl_summary`.
 *
 * The honest math: `pnlUsd = walletValueChangeUsd - netUserContributionUsd`.
 * Where `walletValueChangeUsd = endingValueUsd - startingValueUsd` and
 * `netUserContributionUsd = inflowsUsd - outflowsUsd`. The split removes
 * the user's own deposits/withdrawals from the value delta so what's
 * left is genuine PnL (price moves + DeFi accrual + swap legs + MEV +
 * any other intra-wallet effects).
 */
export interface PnlSummary {
  period: "24h" | "7d" | "30d" | "mtd" | "ytd" | "inception";
  periodStartIso: string;
  periodEndIso: string;

  startingValueUsd: number;
  endingValueUsd: number;
  /** `endingValueUsd - startingValueUsd`. */
  walletValueChangeUsd: number;

  /** External transfers IN, summed at time-of-receipt. */
  inflowsUsd: number;
  /** External transfers OUT, summed at time-of-send. */
  outflowsUsd: number;
  /** `inflowsUsd - outflowsUsd`. The user's net contribution to the wallet. */
  netUserContributionUsd: number;

  /** `walletValueChangeUsd - netUserContributionUsd`. */
  pnlUsd: number;

  perChain: PnlChainSlice[];

  /** True if any per-chain history fetcher truncated. */
  truncated: boolean;
  /** "full" / "partial" / "none" — worst case across all priced lookups. */
  priceCoverage: "full" | "partial" | "none";
  /** Free-form caveats — DeFi exclusion, gas exclusion, scope reminders. */
  notes: string[];
}
