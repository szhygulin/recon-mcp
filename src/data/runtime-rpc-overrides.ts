/**
 * Process-local runtime overrides for chain RPC + 3rd-party API endpoints.
 * Shipped originally as Helius-only at PR #383 (issue #371 follow-up); PR
 * (this) generalizes the mechanism to support multiple services with a
 * per-service config map.
 *
 * Two responsibilities:
 *
 *   1. Override store — when an agent calls `set_<service>_api_key`,
 *      the validated key is held in process memory and takes precedence
 *      over env / userConfig / public-fallback resolution. Survives
 *      until the MCP server restarts. To persist, the user runs
 *      `vaultpilot-mcp-setup`.
 *
 *   2. Public-error counter + nudge — every public-fallback failure
 *      increments a per-service counter; when the counter hits 1 (first
 *      error of the session) or any multiple of 10, the next tool
 *      response gets a structured nudge prepended directing the user to
 *      the relevant `set_<service>_api_key` tool. Counter resets when
 *      a key is set.
 *
 * Backward-compat shims (`setHeliusApiKey`, `consumePendingHeliusNudge`,
 * etc.) preserve the surface from PR #383 — call sites in src/index.ts
 * and src/modules/solana/rpc.ts are unchanged.
 */

export type ServiceId = "helius" | "etherscan";

interface ServiceConfig {
  id: ServiceId;
  /** Display name for diagnostic surfaces + nudge prose. */
  displayName: string;
  /** Validation regex for the bare API key. Per-provider — formats differ. */
  keyPattern: RegExp;
  /** Human-readable hint for what the key shape should look like. */
  keyFormatHint: string;
  /**
   * Construct the resolved value from a validated bare API key. Helius
   * wraps the key in a URL (https://mainnet.helius-rpc.com/?api-key=KEY).
   * Etherscan uses the bare key as-is in query params, so identity here.
   */
  buildResolvedValue: (apiKey: string) => string;
  /** Signup URL surfaced in the nudge text. */
  signupUrl: string;
  /** Build the nudge block (markdown) given the current error count. */
  renderNudge: (errorCount: number) => string;
}

/** Helius UUID format: 8-4-4-4-12 hex chars dash-separated. */
const HELIUS_KEY_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Etherscan keys are 34-char strings of mixed upper-case alphanumerics.
 * Example: ZQTKPM98R5N4YT8GMTBI3XR2P4HFZNTAYG. Etherscan accepts lower-case
 * too in practice, so we normalize the regex to `[A-Za-z0-9]{34}` while
 * preserving the user's original casing in the stored value.
 */
const ETHERSCAN_KEY_PATTERN = /^[A-Za-z0-9]{34}$/;

const SERVICE_CONFIGS: Record<ServiceId, ServiceConfig> = {
  helius: {
    id: "helius",
    displayName: "Helius (Solana RPC)",
    keyPattern: HELIUS_KEY_PATTERN,
    keyFormatHint:
      "UUID format: 8-4-4-4-12 hex chars (e.g. b7d6f3a1-1234-5678-9abc-def012345678)",
    buildResolvedValue: (apiKey) =>
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    signupUrl: "https://dashboard.helius.dev/",
    renderNudge: (errorCount) =>
      `[VAULTPILOT_DEMO — Helius setup nudge]\n\n` +
      `Public Solana RPC has hit ${errorCount} rate-limit error${errorCount === 1 ? "" : "s"} this session. ` +
      `Public Solana endpoints throttle aggressively under any real walkthrough.\n\n` +
      `Free Helius API key takes 60 seconds:\n` +
      `  1. Open [Helius dashboard](https://dashboard.helius.dev/) — sign in with GitHub or email.\n` +
      `  2. Dashboard auto-creates a default API key on first login. Copy it (UUID format: 8-4-4-4-12 hex).\n` +
      `  3. Paste the key into chat. The agent will call \`set_helius_api_key({ apiKey: "<paste>" })\` for you.\n\n` +
      `The key is held in process memory only — survives until the MCP server restarts. ` +
      `To persist across restarts, exit demo mode (unset VAULTPILOT_DEMO + restart) and run ` +
      `\`vaultpilot-mcp-setup\` to save the key to ~/.vaultpilot-mcp/config.json.`,
  },
  etherscan: {
    id: "etherscan",
    displayName: "Etherscan V2 (EVM tx history + allowances)",
    keyPattern: ETHERSCAN_KEY_PATTERN,
    keyFormatHint: "34-char alphanumeric (uppercase + digits, no dashes)",
    // Etherscan uses the key as-is in query params; identity transform.
    buildResolvedValue: (apiKey) => apiKey,
    signupUrl: "https://etherscan.io/myapikey",
    renderNudge: (errorCount) =>
      `[VAULTPILOT_DEMO — Etherscan setup nudge]\n\n` +
      `Etherscan V2 has rejected ${errorCount} call${errorCount === 1 ? "" : "s"} this session. ` +
      `Etherscan refuses unauthed multi-chain V2 calls — every \`get_transaction_history\`, ` +
      `\`get_token_allowances\`, \`explain_tx\`, and address-poisoning scoring call needs a key.\n\n` +
      `Free Etherscan key takes 60 seconds:\n` +
      `  1. Open [Etherscan API dashboard](https://etherscan.io/myapikey) — sign in.\n` +
      `  2. Click "Add" to create a new API key. Copy it (34-char alphanumeric).\n` +
      `  3. Paste into chat. The agent will call \`set_etherscan_api_key({ apiKey: "<paste>" })\` for you.\n\n` +
      `Free tier covers personal-volume use comfortably (5 calls/sec, 100K calls/day). ` +
      `One key works across Ethereum / Arbitrum / Polygon / Base / Optimism via the V2 unified API. ` +
      `The key is held in process memory only — survives until the MCP server restarts. ` +
      `To persist, run \`vaultpilot-mcp-setup\` and save it to ~/.vaultpilot-mcp/config.json.`,
  },
};

interface OverrideState {
  apiKey: string;
  resolvedValue: string;
  setAt: number;
}

const overrides = new Map<ServiceId, OverrideState>();
const errorCounts = new Map<ServiceId, number>();
const pendingNudges = new Set<ServiceId>();

/**
 * Validate + store an API key for the given service. Throws on
 * malformed input rather than storing garbage. Side effects: resets
 * the per-service error counter + clears any pending nudge for this
 * service (the user has acted on the recommendation).
 */
export function setRuntimeOverride(
  service: ServiceId,
  apiKey: string,
): { resolvedValue: string; setAt: number; apiKeySuffix: string } {
  const cfg = SERVICE_CONFIGS[service];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      `[VAULTPILOT] set_${service}_api_key: apiKey must be a non-empty string. ` +
        `Get one at ${cfg.signupUrl}.`,
    );
  }
  if (apiKey.includes("://") || apiKey.startsWith("http")) {
    throw new Error(
      `[VAULTPILOT] set_${service}_api_key: pass the bare API key, not a URL. ` +
        `The server constructs any required URL internally.`,
    );
  }
  if (!cfg.keyPattern.test(apiKey)) {
    throw new Error(
      `[VAULTPILOT] set_${service}_api_key: apiKey doesn't match the expected ` +
        `${cfg.displayName} format (${cfg.keyFormatHint}). Double-check what you ` +
        `copied from ${cfg.signupUrl}.`,
    );
  }
  const resolvedValue = cfg.buildResolvedValue(apiKey);
  const setAt = Date.now();
  overrides.set(service, { apiKey, resolvedValue, setAt });
  errorCounts.set(service, 0);
  pendingNudges.delete(service);
  return { resolvedValue, setAt, apiKeySuffix: apiKey.slice(-4) };
}

/** Returns the resolved value (URL for Helius, bare key for Etherscan) or null. */
export function getRuntimeOverride(service: ServiceId): string | null {
  return overrides.get(service)?.resolvedValue ?? null;
}

/**
 * Redacted status for diagnostic surfaces. Returns last-4 of the API
 * key + setAt; NEVER the raw key. Mirrors the strict no-secrets contract
 * on get_vaultpilot_config_status.
 */
export function getRuntimeOverrideStatus(service: ServiceId): {
  active: boolean;
  apiKeySuffix?: string;
  setAt?: number;
} {
  const o = overrides.get(service);
  if (o === undefined) return { active: false };
  return { active: true, apiKeySuffix: o.apiKey.slice(-4), setAt: o.setAt };
}

/** Clears the runtime override for one service. */
export function clearRuntimeOverride(service: ServiceId): void {
  overrides.delete(service);
}

/**
 * Increment the per-service error counter and check the nudge threshold.
 * Cadence: nudge fires on the FIRST error (count 1) and every multiple
 * of 10 thereafter (10, 20, 30, ...). First-error nudge gives immediate
 * feedback for services that fail 100% of the time without a key
 * (Etherscan); the every-10 cadence handles services that throttle
 * gracefully (Helius/Solana — most calls succeed but slowly).
 *
 * No-op when an override is set — overrides bypass the public-fallback
 * path entirely, and keyed traffic shouldn't trigger the nudge.
 */
export function recordPublicError(service: ServiceId): void {
  if (overrides.has(service)) return;
  const next = (errorCounts.get(service) ?? 0) + 1;
  errorCounts.set(service, next);
  if (next === 1 || next % 10 === 0) {
    pendingNudges.add(service);
  }
}

/** Read-only counter accessor for tests + diagnostic surfaces. */
export function getPublicErrorCount(service: ServiceId): number {
  return errorCounts.get(service) ?? 0;
}

/**
 * Pop-style accessor: if a nudge is pending for this service, return
 * the rendered text and clear the flag. Used directly by tests + the
 * Helius backward-compat shim.
 */
export function consumePendingNudge(service: ServiceId): string | null {
  if (!pendingNudges.has(service)) return null;
  pendingNudges.delete(service);
  const cfg = SERVICE_CONFIGS[service];
  const count = errorCounts.get(service) ?? 0;
  return cfg.renderNudge(count);
}

/**
 * Consume ALL pending nudges across services, in registration order.
 * The registerTool wrapper calls this once per tool response (instead
 * of per-service consumePendingNudge calls), so a session that has
 * tripped both Helius and Etherscan thresholds gets both nudges on
 * the next response.
 */
export function consumeAllPendingNudges(): { service: ServiceId; nudge: string }[] {
  const out: { service: ServiceId; nudge: string }[] = [];
  for (const service of Object.keys(SERVICE_CONFIGS) as ServiceId[]) {
    const nudge = consumePendingNudge(service);
    if (nudge !== null) out.push({ service, nudge });
  }
  return out;
}

// ============================================================================
// Backward-compat shims for the Helius/Solana surface from PR #383.
// Existing call sites in src/index.ts + src/modules/solana/rpc.ts +
// src/config/chains.ts + src/modules/diagnostics/index.ts are unchanged.
// ============================================================================

/** @deprecated Use `setRuntimeOverride("helius", apiKey)`. Retained for the existing tool-call surface. */
export function setHeliusApiKey(apiKey: string): { url: string; setAt: number } {
  const r = setRuntimeOverride("helius", apiKey);
  return { url: r.resolvedValue, setAt: r.setAt };
}

/** @deprecated Use `getRuntimeOverride("helius")`. */
export function getRuntimeSolanaRpc(): string | null {
  return getRuntimeOverride("helius");
}

/** @deprecated Use `getRuntimeOverrideStatus("helius")`. */
export function getRuntimeSolanaRpcStatus(): {
  active: boolean;
  apiKeySuffix?: string;
  setAt?: number;
} {
  return getRuntimeOverrideStatus("helius");
}

/** @deprecated Use `clearRuntimeOverride("helius")`. */
export function clearRuntimeSolanaRpc(): void {
  clearRuntimeOverride("helius");
}

/** @deprecated Use `recordPublicError("helius")`. */
export function recordSolanaPublicError(): void {
  recordPublicError("helius");
}

/** @deprecated Use `getPublicErrorCount("helius")`. */
export function getSolanaPublicErrorCount(): number {
  return getPublicErrorCount("helius");
}

/** @deprecated Use `consumePendingNudge("helius")`. */
export function consumePendingHeliusNudge(): string | null {
  return consumePendingNudge("helius");
}

/** Test-only: reset all module state between tests. */
export function _resetRuntimeRpcOverridesForTests(): void {
  overrides.clear();
  errorCounts.clear();
  pendingNudges.clear();
}
