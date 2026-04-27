/**
 * Process-local runtime overrides for chain RPC endpoints. Currently
 * Solana-only — purpose-built for the Helius nudge in demo mode (issue
 * #371 follow-up): when a user hits public-fallback Solana RPC errors
 * during demo mode, the agent can call `set_helius_api_key` to inject a
 * Helius URL for the rest of the process lifetime without restarting.
 *
 * Override precedence (Solana resolver checks these in order):
 *   1. Runtime override (this module) — set via `set_helius_api_key`.
 *   2. SOLANA_RPC_URL env var.
 *   3. `userConfig.solanaRpcUrl`.
 *   4. Public fallback (rate-limited).
 *
 * State is module-local and ephemeral — a process restart resets to
 * env/config/public. Mirrors the demo live-mode design: demo state lives
 * only as long as the process. To persist a Helius key, run
 * `vaultpilot-mcp-setup` and pick "Solana RPC URL".
 *
 * Also tracks Solana public-fallback error count for the auto-nudge:
 * every 10th error trips a `pendingHeliusNudge` flag that the
 * registerTool wrapper picks up and prepends to the next tool response.
 * Counter resets when an override is set.
 */

const HELIUS_MAINNET_URL_PREFIX = "https://mainnet.helius-rpc.com/?api-key=";

/**
 * Helius API keys are UUIDs (8-4-4-4-12 hex chars, dash-separated).
 * Validating the format prevents (a) accidental URL pastes, (b) prompt
 * injection where an attacker tries to redirect the Solana RPC to a
 * malicious endpoint by passing a full URL.
 */
const HELIUS_API_KEY_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface SolanaOverride {
  apiKey: string;
  url: string;
  setAt: number;
}

let solanaOverride: SolanaOverride | null = null;
let solanaPublicErrorCount = 0;
let pendingHeliusNudge = false;

/**
 * Validates and stores a Helius API key. Constructs the canonical
 * Helius mainnet URL internally — callers pass the bare key (matches
 * the dashboard copy-paste UX). Throws on malformed keys rather than
 * silently storing garbage.
 */
export function setHeliusApiKey(apiKey: string): { url: string; setAt: number } {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      "[VAULTPILOT] set_helius_api_key: apiKey must be a non-empty string. " +
        "Copy the key from https://dashboard.helius.dev/api-keys (looks like a UUID).",
    );
  }
  if (apiKey.includes("://") || apiKey.startsWith("http")) {
    throw new Error(
      "[VAULTPILOT] set_helius_api_key: pass the bare API key, not a URL. " +
        "The server constructs the canonical Helius mainnet URL internally.",
    );
  }
  if (!HELIUS_API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      "[VAULTPILOT] set_helius_api_key: apiKey doesn't match the Helius UUID format " +
        "(8-4-4-4-12 hex chars, e.g. b7d6f3a1-1234-5678-9abc-def012345678). " +
        "Double-check the value you copied from https://dashboard.helius.dev/api-keys.",
    );
  }
  const url = `${HELIUS_MAINNET_URL_PREFIX}${apiKey}`;
  const setAt = Date.now();
  solanaOverride = { apiKey, url, setAt };
  // Setting an override resets the error counter + clears any pending
  // nudge — the user has acted on the recommendation, no need to nag.
  solanaPublicErrorCount = 0;
  pendingHeliusNudge = false;
  return { url, setAt };
}

/** Returns the override URL if set, else null. */
export function getRuntimeSolanaRpc(): string | null {
  return solanaOverride === null ? null : solanaOverride.url;
}

/**
 * Returns a redacted view of the override for diagnostic surfaces.
 * NEVER returns the raw API key — only the last 4 chars + setAt.
 * Mirrors the strict no-secrets contract on get_vaultpilot_config_status.
 */
export function getRuntimeSolanaRpcStatus(): {
  active: boolean;
  apiKeySuffix?: string;
  setAt?: number;
} {
  if (solanaOverride === null) return { active: false };
  return {
    active: true,
    apiKeySuffix: solanaOverride.apiKey.slice(-4),
    setAt: solanaOverride.setAt,
  };
}

/** Clears the runtime override, returning to env/config/public-fallback. */
export function clearRuntimeSolanaRpc(): void {
  solanaOverride = null;
}

/**
 * Increment the Solana-public-error counter and check the nudge
 * threshold. Called from `fetchWithRateLimitDetect` whenever the public
 * Solana RPC returns 429 (or other non-success). When a runtime override
 * is set, this is a no-op — overrides bypass the public-fallback path
 * entirely, and the counter doesn't increment for keyed traffic.
 *
 * Threshold: every 10th error fires the nudge (i.e., count % 10 === 0).
 * Reset when `setHeliusApiKey` is called.
 */
export function recordSolanaPublicError(): void {
  if (solanaOverride !== null) return;
  solanaPublicErrorCount += 1;
  if (solanaPublicErrorCount % 10 === 0) {
    pendingHeliusNudge = true;
  }
}

/** Read-only counter accessor for tests + diagnostic surfaces. */
export function getSolanaPublicErrorCount(): number {
  return solanaPublicErrorCount;
}

/**
 * Pop-style accessor: if the nudge flag is set, return the canned text
 * and clear the flag (so it appears on exactly one tool response per
 * threshold crossing). The registerTool wrapper calls this after every
 * tool response and prepends the result if non-null.
 */
export function consumePendingHeliusNudge(): string | null {
  if (!pendingHeliusNudge) return null;
  pendingHeliusNudge = false;
  return renderHeliusNudge(solanaPublicErrorCount);
}

/**
 * Build the agent-facing nudge block. Pulled out for testability — same
 * text every time a nudge fires, parameterized only by the error count
 * so the user sees "we've hit 10 errors", "we've hit 20 errors", etc.
 */
function renderHeliusNudge(errorCount: number): string {
  return (
    `[VAULTPILOT_DEMO — Helius setup nudge]\n\n` +
    `Public Solana RPC has hit ${errorCount} rate-limit errors this session. ` +
    `It will only get worse — public Solana endpoints throttle aggressively under any real walkthrough.\n\n` +
    `Free Helius API key takes 60 seconds:\n` +
    `  1. Open [Helius dashboard](https://dashboard.helius.dev/) — sign in with GitHub or email.\n` +
    `  2. Dashboard auto-creates a default API key on first login. Copy it (UUID format: 8-4-4-4-12 hex).\n` +
    `  3. Paste the key into chat. The agent will call \`set_helius_api_key({ apiKey: "<paste>" })\` for you.\n\n` +
    `The key is held in process memory only — survives until the MCP server restarts. ` +
    `To persist across restarts, exit demo mode (unset VAULTPILOT_DEMO + restart) and run ` +
    `\`vaultpilot-mcp-setup\` to save the key to ~/.vaultpilot-mcp/config.json.`
  );
}

/** Test-only: reset all module state between tests. */
export function _resetRuntimeRpcOverridesForTests(): void {
  solanaOverride = null;
  solanaPublicErrorCount = 0;
  pendingHeliusNudge = false;
}
