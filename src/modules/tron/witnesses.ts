import { TRONGRID_BASE_URL, TRX_DECIMALS, isTronAddress } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import type { TronWitnessInfo, TronWitnessList, TronVoteAllocation } from "../../types/index.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * TRON mainnet reward constants used for the voter-APR estimate. These are the
 * chain-parameter defaults and have been stable for years; a live
 * `/wallet/getchainparameters` fetch would be more accurate but adds a round-trip
 * for marginal precision. If TRON governance ever shifts these, the estimates
 * drift until this file is updated.
 */
const VOTER_REWARD_POOL_TRX_PER_BLOCK = 160;
const BLOCK_TIME_SECONDS = 3;
const BLOCKS_PER_DAY = (24 * 60 * 60) / BLOCK_TIME_SECONDS; // 28800
const DAYS_PER_YEAR = 365;
const ACTIVE_SR_COUNT = 27;
/**
 * The 160 TRX voter-reward pool is distributed pro-rata to voters for the
 * top 127 witnesses (active SRs + standby candidates), not per-SR. Every
 * voter's per-TRX APR is therefore roughly uniform within the top-127 band
 * and driven by the total vote weight cast across it.
 */
const REWARD_ELIGIBLE_SR_COUNT = 127;

interface TrongridWitness {
  /** Base58 when called with visible=true. */
  address?: string;
  voteCount?: number;
  url?: string;
  totalProduced?: number;
  totalMissed?: number;
  latestBlockNum?: number;
  latestSlotNum?: number;
  isJobs?: boolean;
}

interface TrongridListWitnessesResponse {
  witnesses?: TrongridWitness[];
}

interface TrongridAccountVotesEntry {
  vote_address?: string;
  vote_count?: number;
}

interface TrongridV1Account {
  address?: string;
  votes?: TrongridAccountVotesEntry[];
  frozenV2?: Array<{ amount?: number; type?: "BANDWIDTH" | "ENERGY" }>;
}

interface TrongridV1AccountResponse {
  data?: TrongridV1Account[];
}

async function trongridGet<T>(path: string, apiKey: string | undefined): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Rough annualised voter APR.
 *
 *   apr = (VOTER_REWARD_POOL × BLOCKS_PER_DAY × 365) / totalTop127Votes
 *
 * The 160 TRX voter-reward pool is split each block pro-rata by vote share
 * across the top 127 witnesses. A hypothetical 1-TRX vote anywhere in the
 * top 127 therefore claims 160/totalTop127Votes per block, independent of
 * which specific SR it's cast for. APRs are roughly uniform within the top
 * 127; real differences come from per-SR commission rates (not exposed by
 * this endpoint) and reliability (totalMissed). Out-of-top-127 ⇒ 0.
 *
 * This ignores block-reward APR (16 TRX/block to producers, ~1/27 of blocks
 * per active SR, divided by voteCount) which contributes <10 % of typical
 * voter returns and varies per-SR — leaving it out keeps the estimate simple
 * and roughly flat across the top 127, matching how most TRON staking UIs
 * present the number.
 */
function estimateVoterApr(rank: number, totalTop127Votes: number): number {
  if (rank > REWARD_ELIGIBLE_SR_COUNT) return 0;
  if (totalTop127Votes <= 0) return 0;
  return (
    (VOTER_REWARD_POOL_TRX_PER_BLOCK * BLOCKS_PER_DAY * DAYS_PER_YEAR) /
    totalTop127Votes
  );
}

/** SUN → integer TRX floor (1 vote = 1 whole TRX of frozen TRON Power). */
function sunToVotes(sun: bigint): number {
  return Number(sun / BigInt(10 ** TRX_DECIMALS));
}

/**
 * List TRON Super Representatives and SR candidates, ranked by total votes.
 * Every witness in the top 127 (active SRs + standby candidates) shares the
 * same voter APR estimate — the 160 TRX/block pool is split pro-rata across
 * all of them. Witnesses ranked > 127 get APR 0.
 *
 * When `address` is provided, also returns the wallet's current vote
 * allocation, total TRON Power (frozenV2 sum), and available (unused) votes
 * so the caller can diff before building a `prepare_tron_vote` tx.
 *
 * `includeCandidates` defaults to false — most agents only care about the
 * top 27. Pass true to include the long tail.
 *
 * Filters out any witness whose address doesn't pass `isTronAddress` so that
 * if TronGrid returns hex-form addresses (e.g. if `visible=true` is ignored
 * on a proxy deployment) we fail closed with an empty list instead of
 * emitting addresses that can't round-trip into `prepare_tron_vote`.
 */
export async function listTronWitnesses(
  address?: string,
  includeCandidates = false
): Promise<TronWitnessList> {
  if (address !== undefined && !isTronAddress(address)) {
    throw new Error(
      `"${address}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`
    );
  }

  const apiKey = resolveTronApiKey(readUserConfig());

  const [witnessRes, accountRes] = await Promise.all([
    trongridGet<TrongridListWitnessesResponse>("/wallet/listwitnesses?visible=true", apiKey),
    address !== undefined
      ? trongridGet<TrongridV1AccountResponse>(`/v1/accounts/${address}`, apiKey)
      : Promise.resolve(undefined),
  ]);

  const raw = witnessRes.witnesses ?? [];
  const sorted = [...raw].sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0));

  // Total votes across the top 127 — the denominator for voter APR.
  let totalTop127Votes = 0;
  for (let i = 0; i < Math.min(sorted.length, REWARD_ELIGIBLE_SR_COUNT); i++) {
    totalTop127Votes += sorted[i].voteCount ?? 0;
  }

  const witnesses: TronWitnessInfo[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (!w.address || !isTronAddress(w.address)) continue;
    const rank = i + 1;
    const isActive = rank <= ACTIVE_SR_COUNT;
    if (!isActive && !includeCandidates) continue;
    const voteCount = w.voteCount ?? 0;
    witnesses.push({
      address: w.address,
      ...(w.url !== undefined ? { url: w.url } : {}),
      voteCount: voteCount.toString(),
      isActive,
      rank,
      ...(w.totalProduced !== undefined ? { totalProduced: w.totalProduced } : {}),
      ...(w.totalMissed !== undefined ? { totalMissed: w.totalMissed } : {}),
      estVoterApr: estimateVoterApr(rank, totalTop127Votes),
    });
  }

  const result: TronWitnessList = { witnesses };

  if (address !== undefined) {
    const acc = accountRes?.data?.[0];
    const userVotes: TronVoteAllocation[] = [];
    for (const v of acc?.votes ?? []) {
      if (!v.vote_address) continue;
      const count = v.vote_count ?? 0;
      if (count <= 0) continue;
      userVotes.push({ address: v.vote_address, count });
    }
    let frozenSun = 0n;
    for (const f of acc?.frozenV2 ?? []) {
      frozenSun += BigInt(f.amount ?? 0);
    }
    const totalTronPower = sunToVotes(frozenSun);
    const totalVotesCast = userVotes.reduce((s, v) => s + v.count, 0);
    const availableVotes = Math.max(0, totalTronPower - totalVotesCast);
    result.userVotes = userVotes;
    result.totalTronPower = totalTronPower;
    result.totalVotesCast = totalVotesCast;
    result.availableVotes = availableVotes;
  }

  return result;
}
