import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { round } from "../../data/format.js";
import { fetchWithTimeout } from "../../data/http.js";

interface LlamaProtocol {
  name: string;
  // DefiLlama's `/protocol/<slug>` endpoint returns `tvl` as a time-series
  // array of `{ date, totalLiquidityUSD }` snapshots. Older docs / legacy
  // protocols sometimes returned a scalar — accept both.
  tvl?: number | Array<{ date: number; totalLiquidityUSD: number }>;
  chainTvls?: Record<string, number>;
  // Legacy field — no longer present on current responses; kept optional for
  // backwards compat in case it returns for some protocols.
  tvlHistory?: Array<[number, number]>;
  audits?: string;
  audit_links?: string[];
  listedAt?: number;
  parentProtocol?: string;
}

// Hardcoded Immunefi bounty data for MVP-covered protocols.
// Source: Immunefi program pages (https://immunefi.com/explore/).
const IMMUNEFI_BOUNTIES: Record<string, { program: string; maxBountyUsd: number }> = {
  aave: { program: "Aave", maxBountyUsd: 1_000_000 },
  compound: { program: "Compound", maxBountyUsd: 500_000 },
  uniswap: { program: "Uniswap", maxBountyUsd: 15_500_000 }, // Uniswap has a leading program
  lido: { program: "Lido", maxBountyUsd: 2_000_000 },
  eigenlayer: { program: "EigenLayer", maxBountyUsd: 2_000_000 },
};

// DefiLlama protocol slugs are versioned (`aave-v3`, `compound-v3`) but
// Immunefi bounties are program-level — one program covers all versions.
// Map versioned slugs to the canonical bounty key.
const BOUNTY_ALIASES: Record<string, string> = {
  "aave-v2": "aave",
  "aave-v3": "aave",
  "compound-v2": "compound",
  "compound-v3": "compound",
  "uniswap-v2": "uniswap",
  "uniswap-v3": "uniswap",
  "uniswap-v4": "uniswap",
};

/**
 * DefiLlama's `/protocol/<slug>` returns `tvl` as a time-series array of
 * `{ date, totalLiquidityUSD }` for current responses. Older / cached shapes
 * may return a scalar. Pull the latest snapshot when array-shaped.
 */
function extractCurrentTvl(
  tvl: number | Array<{ date: number; totalLiquidityUSD: number }> | undefined,
): number | undefined {
  if (typeof tvl === "number" && Number.isFinite(tvl)) return tvl;
  if (Array.isArray(tvl) && tvl.length > 0) {
    const last = tvl[tvl.length - 1];
    if (last && typeof last.totalLiquidityUSD === "number") {
      return last.totalLiquidityUSD;
    }
  }
  return undefined;
}

/**
 * 30-day TVL trend as a fractional change. Reads from the `tvl` time-series
 * (current API) and falls back to the legacy `tvlHistory` field if `tvl` is
 * scalar. Returns undefined when there isn't enough history.
 */
function compute30dTrend(data: LlamaProtocol): number | undefined {
  if (Array.isArray(data.tvl) && data.tvl.length > 30) {
    const now = data.tvl[data.tvl.length - 1]?.totalLiquidityUSD;
    const then = data.tvl[data.tvl.length - 31]?.totalLiquidityUSD;
    if (typeof now === "number" && typeof then === "number" && then !== 0) {
      return round((now - then) / then, 4);
    }
  }
  if (data.tvlHistory && data.tvlHistory.length > 30) {
    const now = data.tvlHistory[data.tvlHistory.length - 1]?.[1];
    const then = data.tvlHistory[data.tvlHistory.length - 31]?.[1];
    if (typeof now === "number" && typeof then === "number" && then !== 0) {
      return round((now - then) / then, 4);
    }
  }
  return undefined;
}

async function fetchLlamaProtocol(slug: string): Promise<LlamaProtocol | null> {
  const key = `risk:llama:${slug.toLowerCase()}`;
  return cache.remember(key, CACHE_TTL.PROTOCOL_RISK, async () => {
    try {
      const res = await fetchWithTimeout(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`);
      if (!res.ok) return null;
      return (await res.json()) as LlamaProtocol;
    } catch {
      return null;
    }
  });
}

/** Compute a 0-100 risk score. Higher = safer. Returns undefined if we have no data. */
export async function getProtocolRiskScore(protocol: string): Promise<{
  protocol: string;
  score?: number;
  breakdown: Record<string, { value: number; weight: number; note: string }>;
  raw: {
    tvlUsd?: number;
    tvlTrend30d?: number;
    contractAgeDays?: number;
    hasBugBounty: boolean;
    bountyMaxUsd?: number;
    auditsReported?: number;
  };
}> {
  const slug = protocol.toLowerCase();
  const data = await fetchLlamaProtocol(slug);

  const raw: {
    tvlUsd?: number;
    tvlTrend30d?: number;
    contractAgeDays?: number;
    hasBugBounty: boolean;
    bountyMaxUsd?: number;
    auditsReported?: number;
  } = { hasBugBounty: false };

  if (data) {
    raw.tvlUsd = extractCurrentTvl(data.tvl);
    raw.tvlTrend30d = compute30dTrend(data);
    if (data.listedAt) {
      raw.contractAgeDays = Math.floor((Date.now() / 1000 - data.listedAt) / 86400);
    }
    if (data.audit_links) raw.auditsReported = data.audit_links.length;
  }

  const bountyKey = BOUNTY_ALIASES[slug] ?? slug;
  const bounty = IMMUNEFI_BOUNTIES[bountyKey];
  if (bounty) {
    raw.hasBugBounty = true;
    raw.bountyMaxUsd = bounty.maxBountyUsd;
  }

  // Scoring:
  //   TVL size      : up to 30 points (log scale, 30 @ $10B+)
  //   TVL trend     : 10 points (positive or stable), penalty if -30%+
  //   Contract age  : 20 points (10 @ 1 year, 20 @ 3 years)
  //   Bug bounty    : 20 points if active
  //   Audits        : 20 points (2 @ each, cap 20)
  const breakdown: Record<string, { value: number; weight: number; note: string }> = {};

  let tvlPoints = 0;
  if (raw.tvlUsd) {
    tvlPoints = Math.min(30, Math.max(0, Math.log10(raw.tvlUsd / 1e6) * 10));
  }
  breakdown.tvl = {
    value: round(tvlPoints, 2),
    weight: 30,
    note: raw.tvlUsd ? `TVL $${(raw.tvlUsd / 1e6).toFixed(1)}M` : "no TVL data",
  };

  let trendPoints = 0;
  if (raw.tvlTrend30d !== undefined) {
    if (raw.tvlTrend30d >= 0) trendPoints = 10;
    else if (raw.tvlTrend30d >= -0.3) trendPoints = 5;
    else trendPoints = 0;
  }
  breakdown.tvlTrend = {
    value: trendPoints,
    weight: 10,
    note: raw.tvlTrend30d !== undefined ? `30d change ${(raw.tvlTrend30d * 100).toFixed(1)}%` : "no trend data",
  };

  let agePoints = 0;
  if (raw.contractAgeDays !== undefined) {
    if (raw.contractAgeDays >= 1095) agePoints = 20;
    else if (raw.contractAgeDays >= 365) agePoints = 10;
    else agePoints = 5;
  }
  breakdown.age = {
    value: agePoints,
    weight: 20,
    note: raw.contractAgeDays !== undefined ? `listed ${raw.contractAgeDays}d ago` : "no listing date",
  };

  breakdown.bounty = {
    value: raw.hasBugBounty ? 20 : 0,
    weight: 20,
    note: raw.hasBugBounty ? `Immunefi bounty up to $${(raw.bountyMaxUsd ?? 0).toLocaleString()}` : "no Immunefi bounty registered",
  };

  let auditPoints = 0;
  if (raw.auditsReported !== undefined) auditPoints = Math.min(20, raw.auditsReported * 2);
  breakdown.audits = {
    value: auditPoints,
    weight: 20,
    note: raw.auditsReported !== undefined ? `${raw.auditsReported} audits linked on DefiLlama` : "no audit links",
  };

  const haveAnyData = data !== null || bounty !== undefined;
  const total =
    tvlPoints + trendPoints + agePoints + breakdown.bounty.value + auditPoints;

  return {
    protocol,
    score: haveAnyData ? Math.round(total) : undefined,
    breakdown,
    raw,
  };
}
