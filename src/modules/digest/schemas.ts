import { z } from "zod";
import {
  EVM_ADDRESS,
  TRON_ADDRESS,
  SOLANA_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * `get_daily_briefing` input. Mirrors `getPortfolioDiff`'s address+window
 * shape for consistency — same address validators, same window enum
 * (minus `ytd`, since the plan limits the digest to rolling 24h/7d/30d).
 *
 * `period: "24h"` is the canonical "what happened overnight" briefing;
 * `7d` and `30d` extend the same shape for "what happened this week /
 * this month" without new code paths. The diff's `ytd` is intentionally
 * NOT exposed here — calendar-year snapshots aren't a "what's happening
 * RIGHT NOW" question and the narrative template would need a different
 * voice. Use `get_portfolio_diff` directly for that case.
 */
export const getDailyBriefingInput = z.object({
  wallet: z
    .string()
    .regex(EVM_ADDRESS)
    .optional()
    .describe(
      "EVM wallet (Ethereum / Arbitrum / Polygon / Base / Optimism). " +
        "Drives the EVM portion of every section: portfolio total, asset " +
        "movers, Aave health-factor alert, recent activity counts.",
    ),
  tronAddress: z
    .string()
    .regex(TRON_ADDRESS)
    .optional()
    .describe(
      "TRON mainnet base58 address. Folds TRX + TRC-20 totals + history " +
        "into the briefing.",
    ),
  solanaAddress: z
    .string()
    .regex(SOLANA_ADDRESS)
    .optional()
    .describe(
      "Solana mainnet base58 pubkey. Folds SOL + SPL totals + history " +
        "into the briefing.",
    ),
  bitcoinAddress: z
    .string()
    .optional()
    .describe(
      "Bitcoin address (any type). Folds BTC balance into the briefing. " +
        "Bitcoin tx-history-derived activity counts are best-effort " +
        "(indexer caps may truncate).",
    ),
  period: z
    .enum(["24h", "7d", "30d"])
    .default("24h")
    .describe(
      'Briefing window. "24h" is the canonical morning-coffee briefing; ' +
        '"7d" / "30d" extend to weekly / monthly summaries. Pre-rendered ' +
        "narrative voice tightens for shorter windows.",
    ),
  format: z
    .enum(["structured", "narrative", "both"])
    .default("both")
    .describe(
      '"structured" returns the JSON envelope only. "narrative" returns ' +
        'only the pre-rendered string. "both" (default) returns both — ' +
        "agents typically use the narrative for verbatim relay and the " +
        "structured for follow-up questions.",
    ),
});

export function assertAtLeastOneAddress(args: GetDailyBriefingArgs): void {
  if (
    !args.wallet &&
    !args.tronAddress &&
    !args.solanaAddress &&
    !args.bitcoinAddress
  ) {
    throw new Error(
      "At least one of `wallet` / `tronAddress` / `solanaAddress` / " +
        "`bitcoinAddress` is required.",
    );
  }
}

export type GetDailyBriefingArgs = z.infer<typeof getDailyBriefingInput>;

/**
 * One asset row in the "top movers" section. Sorted desc by
 * `|absChangeUsd|`. We carry both directional (`changeUsd`) and
 * absolute (`absChangeUsd`) so renderers can format up vs down without
 * recomputing.
 */
export interface TopMover {
  symbol: string;
  chain: string;
  startingValueUsd: number;
  endingValueUsd: number;
  /** Signed; positive = portfolio went UP from this asset. */
  changeUsd: number;
  /** `Math.abs(changeUsd)` — the sort key. */
  absChangeUsd: number;
}

/**
 * Lending-position alert row. Mirrors `getHealthAlerts` output one-to-one
 * — re-exporting the shape here so digest-only callers don't need to
 * import the positions module's types. Issue #427 added the `protocol`
 * discriminator + `market` handle so the digest line can label the
 * specific protocol the user is at risk on (Aave / Compound V3 / Morpho /
 * MarginFi / Kamino) rather than always saying "Aave".
 */
export interface HealthAlertRow {
  protocol: "aave-v3" | "compound-v3" | "morpho-blue" | "marginfi" | "kamino";
  chain: string;
  /** Protocol-specific market handle; null for Aave (per-chain aggregation). */
  market: string | null;
  healthFactor: number;
  collateralUsd: number;
  debtUsd: number;
  /** % HF would need to drop by to hit liquidation. */
  marginToLiquidation: number;
}

/**
 * Tx-count breakdown for the activity section. Direction split is
 * always present; action-type classification is best-effort: when an
 * external tx has a resolved `methodName` containing "swap" / "supply" /
 * "borrow" / "repay" / "deposit" / "withdraw", it counts toward that
 * bucket INSTEAD of received/sent. Items without a methodName classify
 * as received/sent based on `from`/`to` matching the user's wallet.
 *
 * `total` is the union (received + sent + each action bucket) — i.e.
 * each tx counts in exactly one bucket and `total === sum-of-buckets`.
 * `byChain` carries the same shape per chain for drill-down.
 */
export interface ActivityCounts {
  total: number;
  received: number;
  sent: number;
  swapped: number;
  supplied: number;
  borrowed: number;
  repaid: number;
  withdrew: number;
  /** Anything that didn't classify as the above. */
  other: number;
}

/**
 * The structured envelope returned alongside the narrative string. Each
 * section maps to one of the bullets in `plan-portfolio-digest.md`.
 *
 * `unavailable` flags surface punted dependencies honestly — agent can
 * tell the difference between "this number really is zero" and "we
 * didn't compute it". For v1 the two unavailable flags are
 * `bestStablecoinYield` (depends on a `compare_yields` tool that hasn't
 * shipped) and `liquidationCalendar` (depends on scheduled-txs).
 */
export interface DailyBriefing {
  period: "24h" | "7d" | "30d";
  windowStartIso: string;
  windowEndIso: string;
  /** Echoed back so the structured envelope is self-describing. */
  addresses: {
    wallet?: string;
    tronAddress?: string;
    solanaAddress?: string;
    bitcoinAddress?: string;
  };
  totals: {
    /** Current portfolio total in USD. */
    currentUsd: number;
    /** USD delta over the window (signed). */
    changeUsd: number;
    /** Percentage delta over the window (signed). Absent when starting value was 0. */
    changePct?: number;
  };
  topMovers: TopMover[];
  healthAlerts: {
    threshold: number;
    atRisk: HealthAlertRow[];
  };
  activity: ActivityCounts;
  bestStablecoinYield: { available: false; reason: string };
  liquidationCalendar: { available: false; reason: string };
  /**
   * Per-section warnings the renderer hoists to the narrative. Empty
   * when everything went cleanly.
   */
  notes: string[];
  /** Pre-rendered narrative string when format ∈ {"narrative","both"}. */
  narrative?: string;
}
