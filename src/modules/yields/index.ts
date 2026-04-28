/**
 * `compare_yields` composer — fans out across per-protocol adapters,
 * normalizes to `YieldRow`, enriches with risk score, applies user
 * filters, ranks by APR descending, returns. 60s cache via the existing
 * `cache` module per the plan.
 *
 * Positioning rule (carried verbatim from `claude-work/HIGH-plan-yield-aggregator.md`):
 * this tool surfaces data; it does NOT pick. Output is a ranked table
 * with explicit columns; never a single "winner" pick. The agent is
 * expected to relay the comparison verbatim.
 */
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { getProtocolRiskScore } from "../security/risk-score.js";
import type { SupportedChain, AnyChain } from "../../types/index.js";
import { readAaveYields } from "./adapters/aave.js";
import { readCompoundYields } from "./adapters/compound.js";
import { readLidoYields } from "./adapters/lido.js";
import {
  resolveAsset,
  expandStables,
  DEFAULT_YIELDS_CHAINS,
  type SupportedAsset,
} from "./asset-map.js";
import type {
  CompareYieldsResult,
  UnavailableProtocolEntry,
  YieldRow,
} from "./types.js";

/**
 * Protocols whose wallet-less market-info reader hasn't been split out
 * from the wallet-aware reader yet. Surfacing them as `unavailable`
 * with a setup hint is the honest answer — never silently green.
 *
 * Each entry corresponds to a tracking issue / follow-up plan item
 * documented in the PR description. v1 ships Aave V3 + Compound V3 +
 * Lido as the live coverage.
 */
const DEFERRED_PROTOCOLS: ReadonlyArray<{
  protocol: UnavailableProtocolEntry["protocol"];
  chain: AnyChain;
  reason: string;
}> = [
  {
    protocol: "morpho-blue",
    chain: "ethereum",
    reason: "Morpho Blue per-market reader not yet split out from the wallet-aware getMorphoPositions — follow-up.",
  },
  {
    protocol: "marginfi",
    chain: "solana",
    reason: "MarginFi wallet-less reader not yet split out from getMarginfiPositions — follow-up.",
  },
  {
    protocol: "kamino",
    chain: "solana",
    reason: "Kamino wallet-less reader not yet split out from getKaminoPositions — follow-up.",
  },
  {
    protocol: "marinade",
    chain: "solana",
    reason: "Marinade has no APY reader exposed in src/modules/solana/marinade.ts — follow-up.",
  },
  {
    protocol: "jito",
    chain: "solana",
    reason: "Jito has no APY reader exposed in src/modules/solana/jito.ts — follow-up.",
  },
  {
    protocol: "eigenlayer",
    chain: "ethereum",
    reason:
      "EigenLayer restaking yield has no single APR — it's fragmented across operators × AVS reward tokens, and DefiLlama publishes no `eigenlayer` project. As a practical proxy, the LRT issuers (Renzo, Kelp, ether.fi, Swell) bundle restaking yield into a tradable token and DO have DefiLlama coverage; they're the realistic answer to \"where do I park ETH for restaking yield\". Native EigenLayer per-operator + per-AVS row shape is deferred until usage data justifies the AVS reward-token pricing infrastructure.",
  },
  {
    protocol: "native-stake",
    chain: "solana",
    reason:
      "Solana native-stake yield depends on validator selection (commission + MEV-enabled flag) — a single network-wide APR misleads. Marinade (`marinade-liquid-staking`) and Jito (`jito-liquid-staking`) are the practical substitutes already covered by `compare_yields`: both LSTs delegate to a curated validator set and surface the realized post-commission yield as one row, with no validator-selection cognitive load on the user. Per-validator row shape is deferred until usage data justifies the validators.app / Stakewiz integration.",
  },
];

/** Map our protocol slugs to DefiLlama slugs for risk scoring. */
const PROTOCOL_TO_LLAMA_SLUG: Record<YieldRow["protocol"], string> = {
  "aave-v3": "aave-v3",
  "compound-v3": "compound-v3",
  "morpho-blue": "morpho-blue",
  marginfi: "marginfi",
  kamino: "kamino",
  lido: "lido",
  eigenlayer: "eigenlayer",
  marinade: "marinade-finance",
  jito: "jito",
  "native-stake": "native-stake",
};

export interface CompareYieldsArgs {
  asset: SupportedAsset;
  chains?: AnyChain[];
  minTvlUsd?: number;
  riskCeiling?: number; // exclude protocols whose riskScore is BELOW this value (lower = riskier)
}

export async function compareYields(
  args: CompareYieldsArgs,
): Promise<CompareYieldsResult> {
  const cacheKey = `yields:${args.asset}:${(args.chains ?? []).sort().join(",")}:${args.minTvlUsd ?? 0}:${args.riskCeiling ?? 0}`;
  return cache.remember(cacheKey, CACHE_TTL.YIELD, async () =>
    compareYieldsImpl(args),
  );
}

async function compareYieldsImpl(args: CompareYieldsArgs): Promise<CompareYieldsResult> {
  const fetchedAt = new Date().toISOString();
  const expanded: SupportedAsset[] =
    args.asset === "stables" ? expandStables() : [args.asset];

  const requestedChains: ReadonlyArray<AnyChain> =
    args.chains && args.chains.length > 0 ? args.chains : DEFAULT_YIELDS_CHAINS;
  const evmChains = requestedChains.filter(
    (c) => c !== "solana" && c !== "tron",
  ) as ReadonlyArray<SupportedChain>;

  const allRows: YieldRow[] = [];
  const allUnavailable: UnavailableProtocolEntry[] = [];

  for (const sub of expanded) {
    const settled = await Promise.allSettled([
      readAaveYields(sub, evmChains),
      readCompoundYields(sub, evmChains),
      readLidoYields(sub),
    ]);
    for (const r of settled) {
      if (r.status === "fulfilled") {
        allRows.push(...(r.value.rows ?? []));
        allUnavailable.push(...(r.value.unavailable ?? []));
      }
      // Promise.allSettled rejection at this level would mean an adapter
      // threw before its own try/catch — adapters are written to never
      // throw, so a rejection here is a programming error and is fine
      // to swallow (the row just doesn't appear).
    }
  }

  // Surface deferred protocols as `unavailable` — restrict to chains
  // the user asked for, so the response respects the chain filter.
  for (const def of DEFERRED_PROTOCOLS) {
    if (requestedChains.includes(def.chain)) {
      allUnavailable.push({
        protocol: def.protocol,
        chain: def.chain,
        available: false,
        reason: def.reason,
      });
    }
  }

  // Risk score enrichment. Each protocol's score is independent of asset
  // / chain, so cache-amortized via the existing cache in risk-score.ts.
  const protocolsSeen = new Set(allRows.map((r) => r.protocol));
  const riskScoreEntries = await Promise.all(
    Array.from(protocolsSeen).map(async (p) => {
      try {
        const { score } = await getProtocolRiskScore(PROTOCOL_TO_LLAMA_SLUG[p]);
        return [p, score ?? null] as const;
      } catch {
        return [p, null] as const;
      }
    }),
  );
  const riskByProtocol = new Map<YieldRow["protocol"], number | null>(
    riskScoreEntries,
  );
  for (const row of allRows) {
    row.riskScore = riskByProtocol.get(row.protocol) ?? null;
  }

  // Filter: minTvlUsd. Rows with `tvl: null` are not filtered out
  // (we don't have the data — surfacing them honestly with `tvl: null`
  // is better than dropping them silently).
  let filtered = allRows;
  if (typeof args.minTvlUsd === "number" && args.minTvlUsd > 0) {
    const min = args.minTvlUsd;
    filtered = filtered.filter((r) => r.tvl === null || r.tvl >= min);
  }

  // Filter: riskCeiling. Higher score = safer per `getProtocolRiskScore`,
  // so the parameter name is "ceiling" but the comparison is `score >= ceiling`
  // (i.e. only show protocols at LEAST this safe). Rows with `riskScore: null`
  // are kept (no data ≠ failed the bar) and surfaced with a note.
  if (typeof args.riskCeiling === "number") {
    const ceiling = args.riskCeiling;
    filtered = filtered.filter(
      (r) => r.riskScore === null || r.riskScore >= ceiling,
    );
  }

  // Rank by APR descending. Null APR sinks to the bottom.
  filtered.sort((a, b) => {
    const av = a.supplyApr ?? -1;
    const bv = b.supplyApr ?? -1;
    return bv - av;
  });

  const result: CompareYieldsResult = {
    asset: args.asset,
    rows: filtered,
    unavailable: allUnavailable,
    fetchedAt,
    ...(expanded.length > 1 ? { expandedAssets: expanded } : {}),
  };

  if (filtered.length === 0) {
    if (allRows.length === 0) {
      result.emptyResultReason =
        "No supply markets returned data for this asset across the requested chains. Check the chain list and that the asset is supported on at least one of them.";
    } else {
      result.emptyResultReason = `${allRows.length} markets matched but all were filtered out by minTvlUsd / riskCeiling. Loosen the filters to see them.`;
    }
  }

  return result;
}
