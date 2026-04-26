/**
 * Tron base-layer chain-health signals for `get_market_incident_status`.
 * Issue #238 v1.
 *
 * Signals:
 *   - block_progression  (tip ageSeconds > 9 → production stalled)
 *   - missed_blocks_rate (last ~1h: > 10% missed → SR liveness degraded)
 *   - sr_concentration   (Nakamoto on SR vote-weight ≤ 6 → BFT halt risk)
 *
 * Deferred to v2 (per the v1 scope):
 *   - sr_rotation_anomaly (needs producer-history join)
 *   - usdt_blacklist_event (scoped, optional)
 *   - network_resource_exhaustion (needs baseline)
 *   - tronGrid_divergence (needs 2nd endpoint)
 */
import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { fetchWithTimeout } from "../../data/http.js";
import { listTronWitnesses } from "../tron/witnesses.js";

/** Tron target block time: 3 seconds. */
const TRON_BLOCK_TARGET_SECONDS = 3;
/** block_progression: tip ageSeconds > 3× target → flagged. */
const BLOCK_PROGRESSION_FLAG_SECONDS = TRON_BLOCK_TARGET_SECONDS * 3;
/** missed_blocks_rate: > this fraction → flagged. */
const MISSED_BLOCKS_FLAG = 0.10;
/** Window for missed-block computation. ~1h at 3s blocks ≈ 1200 blocks. */
const MISSED_BLOCKS_WINDOW = 1200;
/** sr_concentration Nakamoto threshold: ≤ this many SRs hold > 33% → halt risk. */
const SR_NAKAMOTO_FLAG = 6;

export interface TronChainIncidentStatus {
  protocol: "tron";
  chain: "tron";
  tipBlock: number;
  tipBlockTimestamp: number;
  tipAgeSeconds: number;
  incident: boolean;
  signals: TronSignal[];
}

export type TronSignal =
  | {
      name: string;
      available: true;
      flagged: boolean;
      detail: Record<string, unknown>;
    }
  | { name: string; available: false; reason: string };

interface TronGridGetNowBlockResponse {
  block_header?: {
    raw_data?: {
      number?: number;
      timestamp?: number;
    };
  };
}

interface TronGridGetBlockByLimitNextResponse {
  block?: {
    block_header?: {
      raw_data?: {
        number?: number;
        timestamp?: number;
      };
    };
  }[];
}

async function trongridPost<T>(
  path: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function getTronChainHealthSignals(): Promise<TronChainIncidentStatus> {
  const apiKey = resolveTronApiKey(readUserConfig());

  // Fetch tip via getNowBlock; fail-fast if unreachable.
  const tip = await trongridPost<TronGridGetNowBlockResponse>(
    "/wallet/getnowblock",
    {},
    apiKey,
  );
  const tipNumber = tip.block_header?.raw_data?.number;
  const tipTimestampMs = tip.block_header?.raw_data?.timestamp;
  if (typeof tipNumber !== "number" || typeof tipTimestampMs !== "number") {
    throw new Error(
      `TronGrid /wallet/getnowblock returned malformed response (number=${tipNumber}, timestamp=${tipTimestampMs}).`,
    );
  }
  // Tron timestamps are milliseconds.
  const tipTimestampSeconds = Math.floor(tipTimestampMs / 1000);
  const tipAgeSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - tipTimestampSeconds,
  );

  const signals: TronSignal[] = [];

  // block_progression
  signals.push({
    name: "block_progression",
    available: true,
    flagged: tipAgeSeconds > BLOCK_PROGRESSION_FLAG_SECONDS,
    detail: {
      tipBlock: tipNumber,
      tipAgeSeconds,
      targetBlockSeconds: TRON_BLOCK_TARGET_SECONDS,
      flagThresholdSeconds: BLOCK_PROGRESSION_FLAG_SECONDS,
    },
  });

  // missed_blocks_rate — fetch the last MISSED_BLOCKS_WINDOW blocks and
  // compare the observed timespan against the expected (window × 3s).
  // If the chain produced fewer blocks than expected over the same wall-
  // clock interval, blocks were missed. /wallet/getblockbylimitnext takes
  // [startNum, endNum) and returns the slice; cap at 100 per call (the
  // node's hard limit) and concat.
  try {
    const startNum = Math.max(1, tipNumber - MISSED_BLOCKS_WINDOW);
    // Fetch the OLDEST block in the window, plus the tip; the timespan
    // between them tells us how many blocks COULD have been produced
    // in that wall-clock interval. We don't need every block in between.
    const startBlock = await trongridPost<TronGridGetBlockByLimitNextResponse>(
      "/wallet/getblockbylimitnext",
      { startNum, endNum: startNum + 1 },
      apiKey,
    );
    const startTs = startBlock.block?.[0]?.block_header?.raw_data?.timestamp;
    if (typeof startTs !== "number") {
      signals.push({
        name: "missed_blocks_rate",
        available: false,
        reason: `could not fetch start block ${startNum} for window analysis`,
      });
    } else {
      const startTsSec = Math.floor(startTs / 1000);
      const wallclockSpan = tipTimestampSeconds - startTsSec;
      const expectedBlocks = Math.floor(wallclockSpan / TRON_BLOCK_TARGET_SECONDS);
      const actualBlocks = tipNumber - startNum;
      const missedFraction =
        expectedBlocks > 0
          ? Math.max(0, (expectedBlocks - actualBlocks) / expectedBlocks)
          : 0;
      signals.push({
        name: "missed_blocks_rate",
        available: true,
        flagged: missedFraction > MISSED_BLOCKS_FLAG,
        detail: {
          windowBlocks: MISSED_BLOCKS_WINDOW,
          wallclockSeconds: wallclockSpan,
          expectedBlocks,
          actualBlocks,
          missedFraction: Number(missedFraction.toFixed(4)),
          flagThreshold: MISSED_BLOCKS_FLAG,
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "missed_blocks_rate",
      available: false,
      reason: `TronGrid error during window block fetch: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // sr_concentration — Nakamoto coefficient over witness vote-weight.
  // Reuses listTronWitnesses (already wired). Top-127 includes SRs +
  // candidates, but only the top 27 are actively producing; concentration
  // analysis is on the active set.
  try {
    const witnessList = await listTronWitnesses(undefined, true);
    // voteCount is a decimal-string of vote weight (1 frozen TRX = 1 vote);
    // parse to number for the Nakamoto sum. Top-27 are the active SRs
    // (witness ranks 1..27); concentration analysis runs on this set.
    const stakes = witnessList.witnesses
      .slice(0, 27)
      .map((w) => Number(w.voteCount))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
    const total = stakes.reduce((sum, s) => sum + s, 0);
    if (total === 0) {
      signals.push({
        name: "sr_concentration",
        available: false,
        reason: "listTronWitnesses returned zero total stake across active SRs",
      });
    } else {
      const target = total * 0.34;
      let acc = 0;
      let n = 0;
      for (const s of stakes) {
        acc += s;
        n++;
        if (acc > target) break;
      }
      signals.push({
        name: "sr_concentration",
        available: true,
        flagged: n <= SR_NAKAMOTO_FLAG,
        detail: {
          nakamotoCoefficient: n,
          activeSrCount: stakes.length,
          flagThreshold: SR_NAKAMOTO_FLAG,
          note: "smallest SR set summing to > 33% of active-SR vote weight (BFT halt threshold; needs 19/27 to commit, so 9 colluding can halt)",
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "sr_concentration",
      available: false,
      reason: `listTronWitnesses error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    protocol: "tron",
    chain: "tron",
    tipBlock: tipNumber,
    tipBlockTimestamp: tipTimestampSeconds,
    tipAgeSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}
