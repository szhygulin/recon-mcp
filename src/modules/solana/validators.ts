/**
 * `list_solana_validators` — read-only validator-ranking helper for
 * `prepare_native_stake_delegate` (issue #436). Mirrors the role
 * `list_tron_witnesses` plays for TRON SR voting.
 *
 * Data source: stakewiz.com public feed (`https://api.stakewiz.com/validators`).
 * No auth required. The feed publishes pre-computed `wiz_score` (composite
 * quality ranking, 0-100), per-validator APY estimates broken out into
 * inflation + Jito-MEV components, and operational signals (delinquent,
 * skip rate, uptime, superminority penalty) the agent would otherwise
 * have to compute by epoch-walking `getInflationReward`.
 *
 * Why stakewiz over validators.app:
 *   - validators.app requires a per-user API token; stakewiz is open.
 *   - stakewiz exposes both `total_apy` (inflation + MEV) AND the
 *     `wiz_score` composite — covers the issue's "performance / stake /
 *     commission" sortBy directly without needing a separate ranking pass.
 *
 * Invariant #14 awareness: this tool is a HELPER. The agent / user is
 * NOT meant to trust the MCP's enumeration as the source of truth for
 * "which validator should I delegate to" — the validator vote pubkey is
 * a durable on-chain object selected from a multi-candidate set
 * (Invariant #14 territory; b040 attack class). Before delegating, the
 * user should:
 *   1. Re-verify the chosen validator on stakewiz.com or validators.app
 *      independently via their browser.
 *   2. Byte-equality-check the `votePubkey` in the
 *      `prepare_native_stake_delegate` response against the one
 *      confirmed in step 1.
 * The tool's `notes` array surfaces these instructions verbatim on every
 * response so the agent passes them through to the user.
 */
import { z } from "zod";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { fetchWithTimeout } from "../../data/http.js";

const STAKEWIZ_URL = "https://api.stakewiz.com/validators";

/**
 * Subset of the stakewiz response we read. The API publishes ~70 fields
 * per validator; we narrow to the ones load-bearing for ranking +
 * surfacing. Anything unused stays out of the type so a stakewiz schema
 * change in fields we don't touch can't break this module.
 */
interface StakewizValidator {
  rank: number;
  identity: string;
  vote_identity: string;
  name?: string | null;
  description?: string | null;
  website?: string | null;
  ip_country?: string | null;
  version?: string | null;
  activated_stake: number;
  commission: number;
  delinquent: boolean;
  superminority_penalty: number;
  wiz_score: number;
  skip_rate: number;
  uptime: number;
  is_jito: boolean;
  jito_commission_bps: number;
  total_apy: number | null;
  staking_apy: number | null;
  jito_apy: number | null;
}

export const listSolanaValidatorsInput = z.object({
  filters: z
    .object({
      commissionMaxPct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Exclude validators whose commission exceeds this percent (0-100)."),
      excludeDelinquent: z
        .boolean()
        .optional()
        .describe(
          "Exclude validators currently flagged delinquent by stakewiz. Defaults to true — delinquent validators don't earn rewards while delinquent."
        ),
      excludeSuperminority: z
        .boolean()
        .optional()
        .describe(
          "Exclude validators that are penalized for being in the superminority — i.e. their stake share contributes to the >33% concentration that could halt the chain. Defaults to false (delegating away from these is a network-health choice, not a yield choice)."
        ),
      minActivatedStakeSol: z
        .number()
        .nonnegative()
        .optional()
        .describe("Minimum activated stake in SOL. Filters out tiny / dormant validators."),
      mevEnabled: z
        .boolean()
        .optional()
        .describe(
          "Filter to validators running Jito (MEV-enabled) when true, or to non-MEV validators when false. Omit to include both."
        ),
    })
    .optional()
    .describe(
      "Optional filters applied before sorting. Defaults: excludeDelinquent=true, excludeSuperminority=false, no commission/stake/MEV restriction."
    ),
  sortBy: z
    .enum(["score", "apy", "stake", "commission"])
    .optional()
    .describe(
      "Sort order. `score` (default) = stakewiz composite wiz_score descending (best quality first). `apy` = total APY descending (inflation + MEV). `stake` = activated stake descending (largest first). `commission` = commission ascending (lowest first)."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of validators to return after filtering + sorting. Defaults to 25; max 100."),
});

export type ListSolanaValidatorsArgs = z.infer<typeof listSolanaValidatorsInput>;

export interface SolanaValidatorRow {
  /** stakewiz rank (1 = top wiz_score). Stable sort key tied to the source authority. */
  rank: number;
  name: string;
  votePubkey: string;
  identity: string;
  activatedStakeSol: number;
  commissionPct: number;
  mevEnabled: boolean;
  mevCommissionBps: number;
  /** Composite total APY (staking inflation + Jito-MEV bonus). null when stakewiz didn't compute it for this validator. */
  apyEstimate: number | null;
  delinquent: boolean;
  /** True when stakewiz applied a superminority penalty (validator's stake share contributes to >33% concentration). */
  superminorityPenalty: boolean;
  wizScore: number;
  skipRatePct: number;
  uptimePct: number;
  version: string;
  country: string;
  /** Validator's stakewiz profile URL — the user can paste this into a browser to verify independently before delegating. */
  stakewizUrl: string;
}

export interface ListSolanaValidatorsResult {
  validators: SolanaValidatorRow[];
  /** Number of validators in the source feed BEFORE filtering. */
  totalSourceCount: number;
  /** Number of validators that passed filtering, before `limit`. */
  filteredCount: number;
  source: "stakewiz";
  fetchedAt: string;
  /** Inv #14 + sourcing notes. Agent should surface verbatim. */
  notes: string[];
}

async function fetchStakewizValidators(): Promise<StakewizValidator[] | undefined> {
  return cache.remember("solana-validators:stakewiz", CACHE_TTL.YIELD, async () => {
    try {
      const res = await fetchWithTimeout(STAKEWIZ_URL);
      if (!res.ok) return undefined;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return undefined;
      return body as StakewizValidator[];
    } catch {
      return undefined;
    }
  });
}

function buildRow(v: StakewizValidator): SolanaValidatorRow {
  return {
    rank: v.rank,
    name: (v.name ?? "").trim() || "(unnamed)",
    votePubkey: v.vote_identity,
    identity: v.identity,
    activatedStakeSol: Math.round(v.activated_stake),
    commissionPct: v.commission,
    mevEnabled: !!v.is_jito,
    mevCommissionBps: v.jito_commission_bps ?? 0,
    apyEstimate: typeof v.total_apy === "number" ? v.total_apy : null,
    delinquent: !!v.delinquent,
    superminorityPenalty: (v.superminority_penalty ?? 0) > 0,
    wizScore: v.wiz_score,
    skipRatePct: v.skip_rate,
    uptimePct: v.uptime,
    version: v.version ?? "",
    country: v.ip_country ?? "",
    stakewizUrl: `https://stakewiz.com/validator/${v.vote_identity}`,
  };
}

export async function listSolanaValidators(
  args: ListSolanaValidatorsArgs,
): Promise<ListSolanaValidatorsResult> {
  const fetchedAt = new Date().toISOString();
  const pool = await fetchStakewizValidators();

  if (!pool) {
    return {
      validators: [],
      totalSourceCount: 0,
      filteredCount: 0,
      source: "stakewiz",
      fetchedAt,
      notes: [
        "stakewiz.com feed unreachable — try again or check connectivity. Fall back to verifying the validator address directly on stakewiz.com or validators.app in a browser before delegating.",
      ],
    };
  }

  const filters = args.filters ?? {};
  const excludeDelinquent = filters.excludeDelinquent ?? true;
  const excludeSuperminority = filters.excludeSuperminority ?? false;

  const filtered = pool.filter((v) => {
    if (excludeDelinquent && v.delinquent) return false;
    if (excludeSuperminority && (v.superminority_penalty ?? 0) > 0) return false;
    if (
      typeof filters.commissionMaxPct === "number" &&
      v.commission > filters.commissionMaxPct
    ) {
      return false;
    }
    if (
      typeof filters.minActivatedStakeSol === "number" &&
      v.activated_stake < filters.minActivatedStakeSol
    ) {
      return false;
    }
    if (typeof filters.mevEnabled === "boolean" && !!v.is_jito !== filters.mevEnabled) {
      return false;
    }
    return true;
  });

  const sortBy = args.sortBy ?? "score";
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "apy":
        return (b.total_apy ?? -1) - (a.total_apy ?? -1);
      case "stake":
        return b.activated_stake - a.activated_stake;
      case "commission":
        // Lower commission first; tie-break by wiz_score so identical-commission
        // validators surface highest-quality first.
        return a.commission - b.commission || b.wiz_score - a.wiz_score;
      case "score":
      default:
        return b.wiz_score - a.wiz_score;
    }
  });

  const limit = args.limit ?? 25;
  const validators = sorted.slice(0, limit).map(buildRow);

  const notes: string[] = [
    "Source: stakewiz.com public feed. This is a HELPER — the MCP is NOT the source of truth for which validator to delegate to.",
    "Before calling prepare_native_stake_delegate: (1) open the chosen validator's `stakewizUrl` in a browser to re-verify activated stake / commission / delinquent status independently, (2) byte-equality-check the `votePubkey` in the prepare_native_stake_delegate response against the one you confirmed here. Per Invariant #14, a compromised MCP could swap the validator pubkey between this list and the prepared tx.",
  ];

  return {
    validators,
    totalSourceCount: pool.length,
    filteredCount: filtered.length,
    source: "stakewiz",
    fetchedAt,
    notes,
  };
}
