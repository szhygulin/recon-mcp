/**
 * Vendored static lists for the Solana program-layer incident scan.
 * Issue #242 v1 — option (a) "vendored JSON in repo" baseline. Runtime
 * feed augmentation (option (c) hybrid via SOLANA_INCIDENT_FEED_URL) is
 * deferred to v2.
 *
 * Editing policy: every entry should reference a verifiable source
 * (DeFiLlama, rekt.news, Sec3 advisory, official program announcement)
 * in `source`. PRs that add entries without source are not merged.
 *
 * The scan uses these as the **default-known program set** when no
 * `wallet` arg is provided. With a wallet, v2 will scope the scan to
 * programs the user actually has exposure to via SPL holdings.
 */

export interface SolanaKnownProgram {
  programId: string;
  name: string;
  protocol: string;
}

export interface SolanaKnownPythFeed {
  feedAddress: string;
  symbol: string;
  source: string;
}

export interface SolanaIncidentRecord {
  programId: string;
  protocol: string;
  incidentDate: string; // ISO date
  severity: "critical" | "high" | "medium" | "low";
  status: "active" | "under_investigation" | "resolved";
  summary: string;
  source: string;
}

/**
 * Programs we scan for `recent_program_upgrade` and against which we
 * cross-check the vendored incident list. Conservative starter set —
 * the major Solana DeFi protocols this MCP already integrates with.
 */
export const KNOWN_PROGRAM_IDS: readonly SolanaKnownProgram[] = [
  // MarginFi v2
  {
    programId: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    name: "MarginFi v2",
    protocol: "marginfi",
  },
  // Marinade
  {
    programId: "MarBmsSgKXdrN1egZf5sqe1TMThczhMLJhJEAnCpyqr",
    name: "Marinade Staking",
    protocol: "marinade",
  },
  // Jito stake-pool
  {
    programId: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    name: "SPL Stake Pool (Jito uses this program)",
    protocol: "jito",
  },
  // Kamino Lend
  {
    programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    name: "Kamino Lend",
    protocol: "kamino",
  },
  // Jupiter v6 (swaps)
  {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    name: "Jupiter Aggregator v6",
    protocol: "jupiter",
  },
  // Raydium AMM v4
  {
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium AMM v4",
    protocol: "raydium",
  },
] as const;

/**
 * Pyth price feed accounts the scan checks for staleness. Subset chosen
 * to cover the assets the protocols above price (SOL, USDC, USDT, ETH,
 * BTC, JitoSOL). Full Pyth feed list is at https://pyth.network/price-feeds —
 * use that to add more.
 */
export const KNOWN_PYTH_FEEDS: readonly SolanaKnownPythFeed[] = [
  {
    feedAddress: "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",
    symbol: "SOL/USD",
    source: "https://pyth.network/price-feeds/crypto-sol-usd",
  },
  {
    feedAddress: "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD",
    symbol: "USDC/USD",
    source: "https://pyth.network/price-feeds/crypto-usdc-usd",
  },
  {
    feedAddress: "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL",
    symbol: "USDT/USD",
    source: "https://pyth.network/price-feeds/crypto-usdt-usd",
  },
] as const;

/**
 * Vendored historic-incident list. Each entry is a documented exploit /
 * compromise of a Solana program. The scan flags `known_exploit` only
 * when status is `active` or `under_investigation`. Resolved incidents
 * are returned in the response under `historicalIncidents` so the agent
 * can surface "Marinade had a critical incident in 2023, since resolved"
 * context — but they don't trip the `flagged: true` rollup.
 *
 * Empty by default in v1: this is the baseline for the curation workflow
 * to extend over time. PRs adding entries should cite a source per the
 * policy above. The Mango / Wormhole / Cashio / Nirvana cases listed in
 * the issue body are intentionally NOT pre-populated here so the
 * vendored list doesn't fossilize attribution claims (program IDs of
 * exploited entities have shifted since 2022; getting one wrong creates
 * a false-positive that a user has to manually rule out).
 */
export const KNOWN_SOLANA_INCIDENTS: readonly SolanaIncidentRecord[] = [
] as const;
