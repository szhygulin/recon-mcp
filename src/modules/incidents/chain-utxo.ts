/**
 * BTC + LTC base-layer chain-health signals for `get_market_incident_status`.
 * Issue #236 v1 — indexer-only signals (tip_staleness, hash_cliff,
 * empty_block_streak, miner_concentration). RPC-only signals (deep_reorg,
 * indexer_divergence, mempool_anomaly) surface as `available: false,
 * reason: "requires RPC"` placeholders so the rollup is never silently
 * green when a signal can't be evaluated.
 *
 * Architecture: a small per-signal computation function takes the recent-
 * blocks payload + tip and returns either a `flagged:bool` evaluation or
 * `available:false`. The rollup folds them into a single `signals[]` array
 * + `incident: any flagged`.
 */
import { getBitcoinIndexer } from "../btc/indexer.js";
import type {
  BitcoinBlockSummary,
  BitcoinBlockTip,
} from "../btc/indexer.js";
import { getLitecoinIndexer } from "../litecoin/indexer.js";
import type {
  LitecoinBlockSummary,
  LitecoinBlockTip,
} from "../litecoin/indexer.js";

/**
 * BTC/LTC base-layer signals share the same rollup shape — each is just
 * a different chain identifier with different signal thresholds. Union'd
 * here so the dispatcher in incidents/index.ts can return either via
 * one type.
 */
export interface ChainBaseLayerIncidentStatus {
  protocol: "bitcoin" | "litecoin";
  chain: "bitcoin" | "litecoin";
  tipHeight: number;
  tipHash: string;
  tipTimestamp: number;
  tipAgeSeconds: number;
  /** True if any signal in `signals[]` is flagged. */
  incident: boolean;
  signals: ChainHealthSignal[];
}

/** Discriminated by `available` so `unavailable` signals don't carry junk fields. */
export type ChainHealthSignal =
  | {
      name: string;
      available: true;
      flagged: boolean;
      detail: Record<string, unknown>;
    }
  | {
      name: string;
      available: false;
      reason: string;
    };

/** Test-only re-exports of the per-signal eval functions. The orchestrators
 *  (`getBitcoinChainHealthSignals` / `getLitecoinChainHealthSignals`) need
 *  the indexer mocked; the eval functions are pure and easy to test
 *  against a constructed input. Underscore prefix = "internal API; tests
 *  only — not part of the MCP tool surface". */
export const __test = {
  evalTipStaleness: (ageSeconds: number, targetSeconds: number) =>
    evalTipStaleness(ageSeconds, targetSeconds),
  evalHashCliff: (blocks: { timestamp: number }[], targetSeconds: number) =>
    evalHashCliff(blocks, targetSeconds),
  evalEmptyBlockStreak: (
    blocks: { txCount: number; height: number; hash: string }[],
  ) => evalEmptyBlockStreak(blocks),
  evalMinerConcentration: (blocks: { poolName?: string }[]) =>
    evalMinerConcentration(blocks),
  rpcOnlySignals: () => rpcOnlySignals(),
};

/** BTC: target 10-minute blocks. Mean tip-age past 30 min flags. */
const BTC_BLOCK_TARGET_SECONDS = 600;
/** LTC: target 2.5-minute blocks. Mean tip-age past 7.5 min flags. */
const LTC_BLOCK_TARGET_SECONDS = 150;
/** Recent-window depth for hash_cliff / empty_block_streak / miner_concentration. */
const RECENT_BLOCKS_WINDOW = 144;
/** Empty-block-streak threshold: ≥ this many consecutive coinbase-only blocks. */
const EMPTY_BLOCK_STREAK_FLAG = 3;
/** Miner-concentration threshold: any single pool > this fraction of recent window. */
const MINER_CONCENTRATION_FLAG = 0.51;
/** Hash-cliff threshold: observed mean block interval > this multiple of target. */
const HASH_CLIFF_FLAG_MULTIPLE = 1.5;
/** Tip-staleness threshold: tip age > this multiple of target block time. */
const TIP_STALENESS_FLAG_MULTIPLE = 3;

/**
 * Tip staleness — the indexer is stuck OR the network has stalled.
 * Compares `tipAgeSeconds` against the chain's expected mean block time.
 */
function evalTipStaleness(
  ageSeconds: number,
  targetSeconds: number,
): ChainHealthSignal {
  const flagged = ageSeconds > targetSeconds * TIP_STALENESS_FLAG_MULTIPLE;
  return {
    name: "tip_staleness",
    available: true,
    flagged,
    detail: {
      ageSeconds,
      expectedMeanSeconds: targetSeconds,
      flagThresholdSeconds: targetSeconds * TIP_STALENESS_FLAG_MULTIPLE,
    },
  };
}

/**
 * Hash cliff — observed mean block interval over recent N blocks is
 * significantly slower than target. Suggests hashrate departed and the
 * chain hasn't retargeted yet (BTC retarget every 2016 blocks ~ 2 weeks;
 * LTC every 2016 blocks ~ 3.5 days). The recent retarget-direction check
 * suggested in the issue (only flag if last retarget reduced difficulty)
 * is deferred — we don't fetch historical retargets in v1.
 */
function evalHashCliff(
  blocks: { timestamp: number }[],
  targetSeconds: number,
): ChainHealthSignal {
  if (blocks.length < 2) {
    return {
      name: "hash_cliff",
      available: false,
      reason: "fewer than 2 blocks in the recent window",
    };
  }
  // Blocks come newest-first; pair adjacent timestamps to get intervals.
  const intervals: number[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const dt = blocks[i].timestamp - blocks[i + 1].timestamp;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) {
    return {
      name: "hash_cliff",
      available: false,
      reason: "no positive block intervals in window",
    };
  }
  const mean =
    intervals.reduce((sum, dt) => sum + dt, 0) / intervals.length;
  const flagged = mean > targetSeconds * HASH_CLIFF_FLAG_MULTIPLE;
  return {
    name: "hash_cliff",
    available: true,
    flagged,
    detail: {
      observedMeanIntervalSeconds: Math.round(mean),
      expectedTargetSeconds: targetSeconds,
      windowBlocks: blocks.length,
      flagThresholdSeconds: targetSeconds * HASH_CLIFF_FLAG_MULTIPLE,
    },
  };
}

/**
 * Empty-block streak — ≥ N consecutive coinbase-only blocks. Classic
 * selfish-mining / withholding tell: an attacker withholding the
 * mempool to keep the chain marginal will mine empty blocks while
 * preparing a private chain.
 */
function evalEmptyBlockStreak(
  blocks: { txCount: number; height: number; hash: string }[],
): ChainHealthSignal {
  let bestStreak = 0;
  let bestStart: number | null = null;
  let curStreak = 0;
  let curStart: number | null = null;
  for (const b of blocks) {
    if (b.txCount <= 1) {
      // Coinbase-only is txCount === 1; some indexers report 0 for empty.
      if (curStreak === 0) curStart = b.height;
      curStreak++;
      if (curStreak > bestStreak) {
        bestStreak = curStreak;
        bestStart = curStart;
      }
    } else {
      curStreak = 0;
      curStart = null;
    }
  }
  return {
    name: "empty_block_streak",
    available: true,
    flagged: bestStreak >= EMPTY_BLOCK_STREAK_FLAG,
    detail: {
      maxConsecutive: bestStreak,
      startHeight: bestStart,
      windowBlocks: blocks.length,
      flagThreshold: EMPTY_BLOCK_STREAK_FLAG,
    },
  };
}

/**
 * Miner concentration — any single pool tag claims > 51% of the recent
 * window. Indexers vary on whether they expose pool tags; mempool.space
 * does (`extras.pool.name` per block), litecoinspace.org may not. When
 * fewer than half the blocks have a `poolName`, surface as
 * `available: false` rather than reporting a misleading concentration
 * computed over a tiny sample.
 */
function evalMinerConcentration(
  blocks: { poolName?: string }[],
): ChainHealthSignal {
  const tagged = blocks.filter((b) => typeof b.poolName === "string");
  // Need at least half the window tagged for the count to be meaningful.
  // A small tagged sample over a 144-block window would give random-noise
  // "concentration" numbers — better to mark unavailable.
  if (tagged.length < blocks.length / 2) {
    return {
      name: "miner_concentration",
      available: false,
      reason: `only ${tagged.length}/${blocks.length} blocks have indexer-reported pool tags; this indexer does not expose pool attribution reliably`,
    };
  }
  const counts = new Map<string, number>();
  for (const b of tagged) {
    const name = b.poolName as string;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let topPool = "";
  let topCount = 0;
  for (const [name, count] of counts.entries()) {
    if (count > topCount) {
      topCount = count;
      topPool = name;
    }
  }
  const fraction = topCount / tagged.length;
  return {
    name: "miner_concentration",
    available: true,
    flagged: fraction > MINER_CONCENTRATION_FLAG,
    detail: {
      topPool,
      topPoolFraction: Number(fraction.toFixed(4)),
      topPoolBlocks: topCount,
      windowBlocks: blocks.length,
      taggedBlocks: tagged.length,
      flagThreshold: MINER_CONCENTRATION_FLAG,
    },
  };
}

/** Three RPC-only signals: surface as unavailable in v1. */
function rpcOnlySignals(): ChainHealthSignal[] {
  return [
    {
      name: "deep_reorg",
      available: false,
      reason:
        "requires bitcoind/litecoind RPC (`getchaintips`); indexer cannot expose forks. See issue #233.",
    },
    {
      name: "indexer_divergence",
      available: false,
      reason:
        "requires a configured BITCOIN_RPC_URL / LITECOIN_RPC_URL second source. See issue #233.",
    },
    {
      name: "mempool_anomaly",
      available: false,
      reason:
        "requires bitcoind/litecoind RPC (`getmempoolinfo`) for baseline + current. See issue #233.",
    },
  ];
}

export async function getBitcoinChainHealthSignals(): Promise<ChainBaseLayerIncidentStatus> {
  const indexer = getBitcoinIndexer();
  const tip: BitcoinBlockTip = await indexer.getBlockTip();
  const blocks: BitcoinBlockSummary[] = await indexer.getRecentBlocks(
    RECENT_BLOCKS_WINDOW,
  );
  const signals: ChainHealthSignal[] = [
    evalTipStaleness(tip.ageSeconds, BTC_BLOCK_TARGET_SECONDS),
    evalHashCliff(blocks, BTC_BLOCK_TARGET_SECONDS),
    evalEmptyBlockStreak(blocks),
    evalMinerConcentration(blocks),
    ...rpcOnlySignals(),
  ];
  return {
    protocol: "bitcoin",
    chain: "bitcoin",
    tipHeight: tip.height,
    tipHash: tip.hash,
    tipTimestamp: tip.timestamp,
    tipAgeSeconds: tip.ageSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}

export async function getLitecoinChainHealthSignals(): Promise<ChainBaseLayerIncidentStatus> {
  const indexer = getLitecoinIndexer();
  const tip: LitecoinBlockTip = await indexer.getBlockTip();
  const blocks: LitecoinBlockSummary[] = await indexer.getRecentBlocks(
    RECENT_BLOCKS_WINDOW,
  );
  const signals: ChainHealthSignal[] = [
    evalTipStaleness(tip.ageSeconds, LTC_BLOCK_TARGET_SECONDS),
    evalHashCliff(blocks, LTC_BLOCK_TARGET_SECONDS),
    evalEmptyBlockStreak(blocks),
    evalMinerConcentration(blocks),
    ...rpcOnlySignals(),
  ];
  return {
    protocol: "litecoin",
    chain: "litecoin",
    tipHeight: tip.height,
    tipHash: tip.hash,
    tipTimestamp: tip.timestamp,
    tipAgeSeconds: tip.ageSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}
