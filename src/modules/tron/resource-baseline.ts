/**
 * Persistent rolling baseline of TRON chain-wide resource counters
 * for the `network_resource_exhaustion` incident signal (issue #250).
 *
 * What we track
 * -------------
 * `/wallet/getaccountresource` includes four chain-wide totals as
 * top-level fields (verified live against api.trongrid.io 2026-04-26):
 *   - `TotalEnergyLimit`  — chain-wide energy production cap per period
 *   - `TotalEnergyWeight` — total TRX (in sun) staked for energy
 *   - `TotalNetLimit`     — chain-wide bandwidth production cap
 *   - `TotalNetWeight`    — total TRX (in sun) staked for bandwidth
 *
 * The "per-unit cost in TRX" of energy is `TotalEnergyWeight / TotalEnergyLimit`
 * (more TRX staked → more competition → more TRX needed per energy unit
 * via staking). Bandwidth pricing follows the same shape. A sustained
 * 2× rise in either is the DoS / spam pressure signal the issue calls for.
 *
 * Sampling cadence
 * ----------------
 * v1 is **lazy-sample-on-call**: each invocation of
 * `get_market_incident_status({ protocol: "tron" })` records a fresh
 * sample, then computes P50/P90 over the persisted ring buffer.
 *
 * Trade-off explicitly documented in PR:
 *   - PRO: no background process lifecycle, no race conditions on
 *     shared file across multiple MCP instances.
 *   - CON: agents that don't call the incident tool often won't grow
 *     the baseline. A 24h reliable baseline takes 24h of usage.
 *   - Mitigation: persistence across restarts (samples survive process
 *     exits); tighter min-samples threshold (6) to start emitting
 *     signals earlier.
 *
 * If lazy sampling proves too slow in practice, a follow-up adds a
 * background timer (similar to WC keepalive) without changing the
 * persistence shape.
 *
 * Persistence
 * -----------
 * `${getConfigDir()}/tron-resource-baseline.json`. Atomic writes
 * via `writeFileSync(tmp)` → `renameSync(tmp, dst)` — POSIX rename is
 * atomic on the same filesystem, so a partial write can't leave a
 * corrupted file readable. Read-once-on-load + in-memory ring; written
 * back on every sample append. File mode 0o600 (config dir is 0o700).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TRONGRID_BASE_URL } from "../../config/tron.js";
import {
  getConfigDir,
  readUserConfig,
  resolveTronApiKey,
} from "../../config/user-config.js";
import { fetchWithTimeout } from "../../data/http.js";

/** Max samples retained in the ring buffer. 144 samples × 10 min = 24h. */
const MAX_SAMPLES = 144;

/**
 * Minimum samples required before the signal can flag. Lower = signal
 * goes "live" faster on a fresh install but P90 is noisier with N<24.
 * Tightened from 24 → 6 for v1 because lazy-sample cadence is slower
 * than the issue's 10-min recommendation; if false-positive rate
 * proves high in practice, raise this knob first.
 */
const MIN_SAMPLES = 6;

/**
 * Anomaly threshold: current value > THRESHOLD × P90 of recent window
 * → flagged. Issue #250 design table.
 */
const ANOMALY_THRESHOLD = 2.0;

/** Address used as the `address` arg of `getaccountresource` — any
 * valid TRON address works for chain-wide totals. We use the USDT
 * contract because it's already a known constant in this module. */
const QUERY_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** One persisted sample. Times are milliseconds (`Date.now()`). */
export interface ResourceSample {
  /** Sample wall-clock time (ms since epoch). */
  ts: number;
  /** Chain-wide energy production cap. */
  totalEnergyLimit: number;
  /** Total TRX staked for energy, in sun. */
  totalEnergyWeight: number;
  /** Chain-wide bandwidth production cap. */
  totalNetLimit: number;
  /** Total TRX staked for bandwidth, in sun. */
  totalNetWeight: number;
}

interface BaselineFile {
  /** Schema version; bumped on shape changes so old files are migrated. */
  version: 1;
  samples: ResourceSample[];
}

let buffer: ResourceSample[] | null = null;

function baselinePath(): string {
  return join(getConfigDir(), "tron-resource-baseline.json");
}

/** Load on first access; returns the in-memory ref thereafter. */
function loadBuffer(): ResourceSample[] {
  if (buffer !== null) return buffer;
  const path = baselinePath();
  if (!existsSync(path)) {
    buffer = [];
    return buffer;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BaselineFile>;
    if (parsed?.version === 1 && Array.isArray(parsed.samples)) {
      // Defensive shape-check on each entry — a hand-edit could insert
      // garbage; drop those rather than crash on the first divide.
      buffer = parsed.samples.filter(
        (s): s is ResourceSample =>
          typeof s === "object" &&
          s !== null &&
          typeof s.ts === "number" &&
          typeof s.totalEnergyLimit === "number" &&
          typeof s.totalEnergyWeight === "number" &&
          typeof s.totalNetLimit === "number" &&
          typeof s.totalNetWeight === "number",
      );
      return buffer;
    }
  } catch {
    // Corrupted file (truncated write from a kill -9, JSON edit gone
    // wrong) → start fresh. The atomic-rename pattern below makes
    // truncation-on-restart very unlikely going forward, but legacy
    // installs from before this lands could carry one.
  }
  buffer = [];
  return buffer;
}

function persist(samples: ResourceSample[]): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dst = baselinePath();
  const tmp = `${dst}.tmp`;
  const body: BaselineFile = { version: 1, samples };
  writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
  renameSync(tmp, dst);
}

/** Test-only hook: drop the in-memory buffer + the persisted file. */
export function _resetResourceBaselineForTests(): void {
  buffer = null;
  const path = baselinePath();
  if (existsSync(path)) {
    try {
      writeFileSync(path, JSON.stringify({ version: 1, samples: [] }) + "\n", {
        mode: 0o600,
      });
    } catch {
      // best effort
    }
  }
}

/** Test-only hook: replace the persisted samples with a fixture set. */
export function _seedResourceBaselineForTests(samples: ResourceSample[]): void {
  buffer = [...samples];
  persist(buffer);
}

/** Test-only hook: read the current buffer (post-mutation). */
export function _peekResourceBaselineForTests(): ResourceSample[] {
  return loadBuffer().slice();
}

interface TrongridGetAccountResourceResponse {
  TotalEnergyLimit?: number;
  TotalEnergyWeight?: number;
  TotalNetLimit?: number;
  TotalNetWeight?: number;
}

/**
 * Fetch the current snapshot of chain-wide resource counters from
 * TronGrid. Throws on RPC failure or missing fields — caller emits
 * `available: false` rather than silently flagging.
 */
export async function fetchResourceSnapshot(): Promise<
  Omit<ResourceSample, "ts">
> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(
    `${TRONGRID_BASE_URL}/wallet/getaccountresource`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ address: QUERY_ADDRESS, visible: true }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `TronGrid /wallet/getaccountresource returned ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as TrongridGetAccountResourceResponse;
  if (
    typeof body.TotalEnergyLimit !== "number" ||
    typeof body.TotalEnergyWeight !== "number" ||
    typeof body.TotalNetLimit !== "number" ||
    typeof body.TotalNetWeight !== "number"
  ) {
    throw new Error(
      "TronGrid /wallet/getaccountresource response missing one or more chain-wide totals " +
        "(TotalEnergyLimit/Weight, TotalNetLimit/Weight). Endpoint shape may have changed.",
    );
  }
  return {
    totalEnergyLimit: body.TotalEnergyLimit,
    totalEnergyWeight: body.TotalEnergyWeight,
    totalNetLimit: body.TotalNetLimit,
    totalNetWeight: body.TotalNetWeight,
  };
}

/**
 * Append `sample` to the persisted ring buffer. Caps at MAX_SAMPLES
 * (oldest dropped). Returns the post-append buffer for read-after-write
 * computation.
 */
export function appendSample(sample: ResourceSample): ResourceSample[] {
  const samples = loadBuffer();
  samples.push(sample);
  while (samples.length > MAX_SAMPLES) samples.shift();
  persist(samples);
  return samples;
}

/** Ratio (TRX-staked / production-cap) for energy, in sun-per-unit. */
export function energyPriceRatio(s: ResourceSample): number {
  if (s.totalEnergyLimit <= 0) return 0;
  return s.totalEnergyWeight / s.totalEnergyLimit;
}

/** Same shape for bandwidth. */
export function bandwidthPriceRatio(s: ResourceSample): number {
  if (s.totalNetLimit <= 0) return 0;
  return s.totalNetWeight / s.totalNetLimit;
}

/** Compute a percentile (0..1) over `values`. Returns NaN on empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Result of evaluating the network-resource-exhaustion signal. */
export type ResourceExhaustionResult =
  | {
      available: true;
      flagged: boolean;
      detail: {
        sample: ResourceSample;
        windowSize: number;
        energy: { current: number; p50: number; p90: number; ratioVsP90: number };
        bandwidth: { current: number; p50: number; p90: number; ratioVsP90: number };
        thresholdMultiple: number;
      };
    }
  | { available: false; reason: string };

/**
 * Take a fresh sample, append to the ring, and evaluate the
 * `network_resource_exhaustion` signal. Returns a structured result
 * the signal handler in `chain-tron.ts` translates into the standard
 * `TronSignal` envelope.
 */
export async function evaluateResourceExhaustion(options: {
  now?: number;
} = {}): Promise<ResourceExhaustionResult> {
  let snapshot;
  try {
    snapshot = await fetchResourceSnapshot();
  } catch (err) {
    return {
      available: false,
      reason: `failed to sample TronGrid /wallet/getaccountresource: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const ts = options.now ?? Date.now();
  const sample: ResourceSample = { ts, ...snapshot };
  const samples = appendSample(sample);
  if (samples.length < MIN_SAMPLES) {
    return {
      available: false,
      reason: `insufficient baseline data: ${samples.length}/${MIN_SAMPLES} samples persisted (need ≥${MIN_SAMPLES} before flagging)`,
    };
  }
  const energyValues = samples.map(energyPriceRatio);
  const bandwidthValues = samples.map(bandwidthPriceRatio);
  const energyP50 = percentile(energyValues, 0.5);
  const energyP90 = percentile(energyValues, 0.9);
  const bandwidthP50 = percentile(bandwidthValues, 0.5);
  const bandwidthP90 = percentile(bandwidthValues, 0.9);

  const energyCurrent = energyPriceRatio(sample);
  const bandwidthCurrent = bandwidthPriceRatio(sample);

  // Guard against P90 == 0 (all-zero baseline — shouldn't happen on
  // mainnet, but a fresh install hitting a transient bad-data day
  // could). When P90 is 0, ratio is meaningless → don't flag.
  const energyRatio = energyP90 > 0 ? energyCurrent / energyP90 : 0;
  const bandwidthRatio = bandwidthP90 > 0 ? bandwidthCurrent / bandwidthP90 : 0;

  const flagged =
    energyRatio > ANOMALY_THRESHOLD || bandwidthRatio > ANOMALY_THRESHOLD;

  return {
    available: true,
    flagged,
    detail: {
      sample,
      windowSize: samples.length,
      energy: {
        current: energyCurrent,
        p50: energyP50,
        p90: energyP90,
        ratioVsP90: energyRatio,
      },
      bandwidth: {
        current: bandwidthCurrent,
        p50: bandwidthP50,
        p90: bandwidthP90,
        ratioVsP90: bandwidthRatio,
      },
      thresholdMultiple: ANOMALY_THRESHOLD,
    },
  };
}
