/**
 * Tron base-layer chain-health signals for `get_market_incident_status`.
 * Issue #238 v1 + small-wins follow-up (sr_rotation_anomaly,
 * tronGrid_divergence).
 *
 * Signals:
 *   - block_progression     (tip ageSeconds > 9 → production stalled)
 *   - missed_blocks_rate    (last ~1h: > 10% missed → SR liveness degraded)
 *   - sr_concentration      (Nakamoto on SR vote-weight ≤ 6 → BFT halt risk)
 *   - sr_rotation_anomaly   (≥ 3 unknown producers in last 30 blocks →
 *                            non-active-SR producing, or encoding mismatch
 *                            we surface honestly via available:false)
 *   - tronGrid_divergence   (block-height gap > 5 vs an optional second
 *                            TronGrid-compatible endpoint set via
 *                            TRON_RPC_URL_SECONDARY; mirror of the Solana
 *                            rpc_divergence pattern)
 *
 * Tracked separately as v2 follow-ups (out of this PR's scope):
 *   - usdt_blacklist_event           — issue #249
 *   - network_resource_exhaustion    — issue #250
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
/** sr_rotation_anomaly: scan last N blocks for unknown producers. */
const SR_ROTATION_WINDOW = 30;
/** sr_rotation_anomaly: ≥ this many unknown producers in window → flagged. */
const SR_ROTATION_UNKNOWN_FLAG = 3;
/** tronGrid_divergence: tip-block height gap > this vs secondary endpoint → flagged. */
const TRONGRID_DIVERGENCE_BLOCK_GAP = 5;

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
        // Producer field is present in /wallet/getblockbylimitnext responses;
        // encoding depends on whether `?visible=true` was passed (base58 vs
        // hex). The sr_rotation_anomaly path uses `?visible=true` so we get
        // base58, matching the SR set returned by listTronWitnesses.
        witness_address?: string;
      };
    };
  }[];
}

async function trongridPost<T>(
  path: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<T> {
  return trongridPostUrl<T>(`${TRONGRID_BASE_URL}${path}`, body, apiKey);
}

/**
 * Like `trongridPost` but takes a full URL instead of a path. Used by
 * `tronGrid_divergence` which queries a user-configured secondary endpoint
 * (`TRON_RPC_URL_SECONDARY`) — that endpoint may not be the canonical
 * `api.trongrid.io` host. The API-key header is still forwarded; if the
 * secondary endpoint doesn't honor TRON-PRO-API-KEY (most TronGrid-compat
 * RPCs do, some private nodes don't) the call still succeeds — the header
 * is just ignored.
 */
async function trongridPostUrl<T>(
  fullUrl: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(fullUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${fullUrl} returned ${res.status} ${res.statusText}`);
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

  // Fetch the active SR set ONCE — both sr_concentration and
  // sr_rotation_anomaly need it. On failure both signals degrade to
  // available:false rather than each retrying.
  let activeWitnessAddresses: string[] | null = null;
  let activeWitnessStakes: number[] | null = null;
  let witnessFetchError: string | null = null;
  try {
    const witnessList = await listTronWitnesses(undefined, true);
    // listTronWitnesses(_, includeCandidates=true) returns the full set;
    // top-27 (by witness rank) are the active SRs. The witnesses array is
    // pre-sorted by vote weight, so slicing 0..27 gives the active set.
    const top27 = witnessList.witnesses.slice(0, 27);
    activeWitnessAddresses = top27.map((w) => w.address);
    activeWitnessStakes = top27
      .map((w) => Number(w.voteCount))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
  } catch (err) {
    witnessFetchError = err instanceof Error ? err.message : String(err);
  }

  // sr_concentration — Nakamoto coefficient over witness vote-weight.
  if (witnessFetchError !== null) {
    signals.push({
      name: "sr_concentration",
      available: false,
      reason: `listTronWitnesses error: ${witnessFetchError}`,
    });
  } else {
    const stakes = activeWitnessStakes!;
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
  }

  // sr_rotation_anomaly — fetch last SR_ROTATION_WINDOW blocks and check
  // each producer against the active SR set. Producers OUTSIDE the active
  // set indicate rotation anomalies (or, if the encoding mismatches,
  // we surface that as available:false rather than silently flag-everything).
  // Uses ?visible=true so witness_address comes back base58, matching the
  // base58 addresses in the SR list.
  if (witnessFetchError !== null) {
    signals.push({
      name: "sr_rotation_anomaly",
      available: false,
      reason: `requires the SR list; listTronWitnesses error: ${witnessFetchError}`,
    });
  } else {
    try {
      const startNum = Math.max(1, tipNumber - SR_ROTATION_WINDOW + 1);
      const blocks = await trongridPost<TronGridGetBlockByLimitNextResponse>(
        "/wallet/getblockbylimitnext?visible=true",
        { startNum, endNum: tipNumber + 1 },
        apiKey,
      );
      const producers = (blocks.block ?? [])
        .map((b) => b.block_header?.raw_data?.witness_address)
        .filter((w): w is string => typeof w === "string" && w.length > 0);
      if (producers.length === 0) {
        signals.push({
          name: "sr_rotation_anomaly",
          available: false,
          reason:
            "TronGrid /wallet/getblockbylimitnext returned no decodable witness_address fields",
        });
      } else {
        const activeSet = new Set(activeWitnessAddresses!);
        const knownProducers = producers.filter((p) => activeSet.has(p));
        const unknownProducers = producers.filter((p) => !activeSet.has(p));
        // Defensive sanity check: if NONE of the producers match the
        // active SR set, that almost certainly means address-encoding
        // mismatch (block returned hex, SR list returned base58, or vice
        // versa) rather than every block being produced by a non-SR.
        // Surface the ambiguity rather than flagging the full window.
        if (knownProducers.length === 0) {
          signals.push({
            name: "sr_rotation_anomaly",
            available: false,
            reason: `0/${producers.length} block producers matched the active SR set — likely an address-encoding mismatch between TronGrid block witness_address and listTronWitnesses output. Skipping rotation analysis to avoid a false-positive flood.`,
          });
        } else {
          signals.push({
            name: "sr_rotation_anomaly",
            available: true,
            flagged: unknownProducers.length >= SR_ROTATION_UNKNOWN_FLAG,
            detail: {
              windowBlocks: SR_ROTATION_WINDOW,
              producersObserved: producers.length,
              knownProducers: knownProducers.length,
              unknownProducers: unknownProducers.length,
              flagThreshold: SR_ROTATION_UNKNOWN_FLAG,
              ...(unknownProducers.length > 0
                ? { unknownProducerSamples: unknownProducers.slice(0, 5) }
                : {}),
            },
          });
        }
      }
    } catch (err) {
      signals.push({
        name: "sr_rotation_anomaly",
        available: false,
        reason: `TronGrid error during producer-window fetch: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // tronGrid_divergence — when TRON_RPC_URL_SECONDARY is set, probe the
  // secondary endpoint for its tip block and flag if it disagrees with
  // the primary tip by > TRONGRID_DIVERGENCE_BLOCK_GAP blocks. Mirrors
  // the Solana rpc_divergence shape; degrades to available:false when
  // the env var is unset.
  const secondaryUrl = process.env.TRON_RPC_URL_SECONDARY;
  if (!secondaryUrl) {
    signals.push({
      name: "tronGrid_divergence",
      available: false,
      reason: "requires TRON_RPC_URL_SECONDARY env var pointing at a second TronGrid-compatible endpoint",
    });
  } else {
    try {
      const secondaryTip = await trongridPostUrl<TronGridGetNowBlockResponse>(
        `${secondaryUrl.replace(/\/$/, "")}/wallet/getnowblock`,
        {},
        apiKey,
      );
      const secondaryNumber = secondaryTip.block_header?.raw_data?.number;
      if (typeof secondaryNumber !== "number") {
        signals.push({
          name: "tronGrid_divergence",
          available: false,
          reason: "secondary endpoint returned malformed getnowblock response",
        });
      } else {
        const gap = Math.abs(tipNumber - secondaryNumber);
        signals.push({
          name: "tronGrid_divergence",
          available: true,
          flagged: gap > TRONGRID_DIVERGENCE_BLOCK_GAP,
          detail: {
            primaryTip: tipNumber,
            secondaryTip: secondaryNumber,
            blockGap: gap,
            flagThreshold: TRONGRID_DIVERGENCE_BLOCK_GAP,
            secondaryEndpoint: secondaryUrl,
          },
        });
      }
    } catch (err) {
      signals.push({
        name: "tronGrid_divergence",
        available: false,
        reason: `secondary endpoint error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
