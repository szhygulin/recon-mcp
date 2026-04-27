/**
 * Rate-limit detector + setup-hint generator.
 *
 * Sources call `recordRateLimit(source)` whenever the upstream RPC
 * returned HTTP 429 (or a provider-specific JSON-RPC equivalent like
 * Alchemy's -32005). Once a source crosses the threshold inside the
 * rolling window AND the user is using a default no-key endpoint
 * (PublicNode / public mainnet RPC / no-TronGrid-key), the tracker
 * produces a `SetupHint` exposed via `getActiveHints()`.
 *
 * The hint surfaces in `get_vaultpilot_config_status` (which agents
 * poll for setup state) and in `get_portfolio_summary`'s coverage
 * block (where users are most likely to first hit limits via the
 * cross-chain fan-out). The agent's job is to relay the hint to the
 * user with the dashboard URL and the `vaultpilot-mcp-setup` command
 * to add the API key.
 *
 * Thresholds are deliberately conservative — false-positive nudges
 * are worse than missed-true nudges (a user told to "set up an API
 * key" when they wouldn't have hit limits anyway loses trust). Once
 * a source trips, the hint stays sticky until config changes (the
 * `onRpcConfigChange` hook in src/data/rpc.ts also clears this
 * tracker), so a re-run of the wizard with a new key resets the
 * counter.
 */

/**
 * The three RPC sources the tracker covers in v1. Each maps to a
 * remediation: which provider to set up, where the dashboard lives,
 * which wizard section to run.
 *
 * Etherscan / DefiLlama / 4byte / LiFi / Jupiter etc. are NOT in the
 * source set — they're third-party data services, not RPC providers.
 * Etherscan has a key path but the rest don't, so the unified "set
 * up an API key" framing doesn't fit. Different feature.
 */
export type RateLimitSource =
  | { kind: "evm"; chain: "ethereum" | "arbitrum" | "polygon" | "base" | "optimism" }
  | { kind: "solana" }
  | { kind: "tron" };

/**
 * Public-facing setup hint. The agent reads this and surfaces it to
 * the user (in chat). The shape is deliberately verbose so an LLM
 * doesn't have to rewrite the prose — just relay the message.
 *
 * Two `kind`s today:
 *  - `rate-limit`: a default no-key RPC source has been throttled past
 *    threshold; user should add an API key. Carries `hits`,
 *    `windowMinutes`, `providers`, `setupCommand`.
 *  - `demo-mode`: fresh-install state (no keys / pairings / custom
 *    RPC, demo off) — agent should suggest `VAULTPILOT_DEMO=true` as
 *    the zero-friction try-before-install path (issue #371). The
 *    rate-limit-specific fields are omitted.
 *
 * Default kind is `rate-limit` for backward compatibility with the
 * pre-#371 shape.
 */
export interface SetupHint {
  /** Discriminator for downstream filtering — agents can route on this. */
  kind: "rate-limit" | "demo-mode";
  /** Stable identifier for deduping in the agent's mind / on-disk caches. */
  source: string;
  /** Rate-limit only: how many 429s this source has seen in the rolling window. */
  hits?: number;
  /** Rate-limit only: window length in minutes — context for the hits count. */
  windowMinutes?: number;
  /** One-line headline for chat. */
  message: string;
  /** Longer prose, including the actionable command. */
  recommendation: string;
  /** Rate-limit only: provider name(s) the user can sign up for, with dashboard URL. */
  providers?: Array<{ name: string; dashboardUrl: string }>;
  /** Rate-limit only: wizard subcommand to run (interactive — adds the key to config). */
  setupCommand?: string;
}

/** Threshold + window. ~3 hits in 5 min before nudging — high enough to mean "sustained". */
const THRESHOLD_HITS = 3;
const WINDOW_MS = 5 * 60_000;

/** Per-source ring of recent timestamps. Trimmed on every record + every read. */
const hits = new Map<string, number[]>();

/** Keys for which we've already emitted a hint, so `getActiveHints` is idempotent. */
const tripped = new Set<string>();

function sourceKey(source: RateLimitSource): string {
  if (source.kind === "evm") return `evm:${source.chain}`;
  return source.kind;
}

/**
 * Record a rate-limit observation. Trims the source's window and
 * checks the threshold; once tripped the source is added to the
 * `tripped` set so subsequent calls are cheap.
 *
 * Safe to call from hot paths — O(1) amortized (the window is
 * bounded by THRESHOLD_HITS in steady state because we trim).
 */
export function recordRateLimit(source: RateLimitSource): void {
  const key = sourceKey(source);
  const now = Date.now();
  const arr = hits.get(key) ?? [];
  // Keep only entries within the window. For typical use, this is a
  // tiny array — bounded by THRESHOLD_HITS once tripped.
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  const trimmed = i > 0 ? arr.slice(i) : arr;
  trimmed.push(now);
  hits.set(key, trimmed);
  if (trimmed.length >= THRESHOLD_HITS) {
    tripped.add(key);
  }
}

/**
 * Inputs needed to render a hint. The caller (diagnostics layer)
 * passes its view of which sources are using a no-key default — only
 * those can surface hints (a tripped source that's already on a paid
 * key has nothing actionable to suggest).
 */
export interface HintRenderContext {
  evmUsingDefault: Record<
    "ethereum" | "arbitrum" | "polygon" | "base" | "optimism",
    boolean
  >;
  solanaUsingDefault: boolean;
  tronUsingDefault: boolean;
}

/**
 * Build the hint envelope for a tripped source. Pulled out so tests
 * can assert the prose without going through the full call flow.
 */
function renderHint(source: RateLimitSource): SetupHint {
  const key = sourceKey(source);
  const arr = hits.get(key) ?? [];
  const base: Pick<SetupHint, "kind" | "source" | "hits" | "windowMinutes"> = {
    kind: "rate-limit",
    source: key,
    hits: arr.length,
    windowMinutes: Math.floor(WINDOW_MS / 60_000),
  };
  if (source.kind === "evm") {
    return {
      ...base,
      message: `${source.chain} RPC is hitting rate limits on the default public endpoint.`,
      recommendation:
        `You're using the free public RPC fallback (PublicNode) for ${source.chain}. ` +
        `It's rate-limited; for sustained use, sign up for a free API key with Infura or Alchemy ` +
        `(both have free tiers covering personal-volume use). Then run \`vaultpilot-mcp-setup\` ` +
        `interactively and pick the "RPC provider" section to add the key.`,
      providers: [
        { name: "Infura", dashboardUrl: "https://app.infura.io/" },
        { name: "Alchemy", dashboardUrl: "https://dashboard.alchemy.com/" },
      ],
      setupCommand: "vaultpilot-mcp-setup",
    };
  }
  if (source.kind === "solana") {
    return {
      ...base,
      message:
        "Solana RPC is hitting rate limits on the default public endpoint.",
      recommendation:
        `You're using the public Solana mainnet RPC, which is rate-limited. For real use, ` +
        `sign up for a free Helius API key (covers personal-volume reads + writes), then run ` +
        `\`vaultpilot-mcp-setup\` interactively and pick the "Solana RPC URL" section to add the key.`,
      providers: [
        { name: "Helius", dashboardUrl: "https://dashboard.helius.dev/api-keys" },
      ],
      setupCommand: "vaultpilot-mcp-setup",
    };
  }
  // tron
  return {
    ...base,
    message: "TronGrid is hitting rate limits on the unauthenticated tier.",
    recommendation:
      `You're calling TronGrid without an API key, which throttles to ~15 req/min. Sign up for ` +
      `a free TronGrid API key (their free tier covers personal-volume use), then run ` +
      `\`vaultpilot-mcp-setup\` interactively and pick the "TronGrid API key" section to add it.`,
    providers: [
      { name: "TronGrid", dashboardUrl: "https://www.trongrid.io/dashboard/apikeys" },
    ],
    setupCommand: "vaultpilot-mcp-setup",
  };
}

/**
 * Return the currently-active hints. A source qualifies if it (a)
 * tripped the threshold and (b) is still using a no-key default per
 * the caller's `ctx`. Once the user adds a key, the next config-
 * status read sees `usingDefault=false` for that source and the hint
 * disappears even if the tracker hasn't been reset yet.
 */
export function getActiveHints(ctx: HintRenderContext): SetupHint[] {
  const out: SetupHint[] = [];
  // EVM — one hint per chain that's both tripped and on default RPC.
  for (const chain of ["ethereum", "arbitrum", "polygon", "base", "optimism"] as const) {
    if (!tripped.has(`evm:${chain}`)) continue;
    if (!ctx.evmUsingDefault[chain]) continue;
    out.push(renderHint({ kind: "evm", chain }));
  }
  if (tripped.has("solana") && ctx.solanaUsingDefault) {
    out.push(renderHint({ kind: "solana" }));
  }
  if (tripped.has("tron") && ctx.tronUsingDefault) {
    out.push(renderHint({ kind: "tron" }));
  }
  return out;
}

/**
 * Reset the entire tracker. Called from `onRpcConfigChange` (so the
 * wizard adding a key clears stale hints) and from tests between
 * cases.
 */
export function resetRateLimitTracker(): void {
  hits.clear();
  tripped.clear();
}

/** Test-only — current internal state, for assertions. */
export function _trackerState(): {
  hits: Record<string, number[]>;
  tripped: string[];
} {
  return {
    hits: Object.fromEntries(hits),
    tripped: Array.from(tripped),
  };
}
