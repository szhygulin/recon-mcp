import { Connection } from "@solana/web3.js";
import { resolveSolanaRpcUrl } from "../../config/chains.js";
import { readUserConfig } from "../../config/user-config.js";
import { recordRateLimit } from "../../data/rate-limit-tracker.js";
import {
  getRuntimeSolanaRpc,
  recordSolanaPublicError,
} from "../../data/runtime-rpc-overrides.js";

/**
 * Cached `Connection` for Solana mainnet. Lazy-initialized on first use.
 * Mirrors the EVM `getClient(chain)` pattern in src/data/rpc.ts — one client
 * per process, reused across calls. Reset on config change (future hook
 * alongside the EVM `resetClients` listener).
 */
let cachedConnection: Connection | undefined;
/** URL the cached connection was constructed against — when the runtime
 * override flips this changes, and `getSolanaConnection` rebuilds. */
let cachedConnectionUrl: string | undefined;

/**
 * fetch shim handed to web3.js's `Connection({ fetch })`. Forwards
 * to the platform `fetch`, then peeks at the response status for 429
 * before returning. We touch the response WITHOUT consuming the body
 * so the caller still gets the full Response intact — `Response.status`
 * is on the wire-headers side and is safe to read repeatedly.
 *
 * Done at the Connection-fetch layer (rather than wrapping every
 * `connection.getXxx()` call) because web3.js has dozens of methods
 * and a centralized hook is the only sustainable choice. Same pattern
 * the EVM transport-wrapper uses in src/data/rpc.ts.
 */
async function fetchWithRateLimitDetect(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 429) {
    recordRateLimit({ kind: "solana" });
    // Increment the demo-mode Helius nudge counter — only counts when no
    // runtime override is set, so the nudge doesn't fire after the user
    // adds a key. Every 10th error trips a `pendingHeliusNudge` flag the
    // registerTool wrapper picks up on the next response.
    recordSolanaPublicError();
  }
  return res;
}

export function getSolanaConnection(): Connection {
  const url = resolveSolanaRpcUrl(readUserConfig());
  // Issue #371 follow-up: when `set_helius_api_key` flips the runtime
  // override, the resolved URL changes mid-process. Rebuild the cached
  // Connection if the URL no longer matches what we built it against —
  // otherwise the override has no effect until restart.
  if (cachedConnection && cachedConnectionUrl === url) {
    return cachedConnection;
  }
  // `confirmed` is the sweet spot for read-only portfolio/history queries —
  // `processed` is racy (may return state rolled back a slot later) and
  // `finalized` adds ~13s of latency for no meaningful safety win on reads.
  cachedConnection = new Connection(url, {
    commitment: "confirmed",
    fetch: fetchWithRateLimitDetect as never,
  });
  cachedConnectionUrl = url;
  return cachedConnection;
}

/** Test-only: drop the cached connection so a mocked `@solana/web3.js` is picked up on next call. */
export function resetSolanaConnection(): void {
  cachedConnection = undefined;
  cachedConnectionUrl = undefined;
}

// Suppress unused-import linter on getRuntimeSolanaRpc — kept imported so
// future Solana paths that don't go through the cached `Connection` (e.g.
// a `@solana/kit` createSolanaRpc call) can also pick up the override
// without re-deriving the precedence chain. Removing this unused import
// would force re-add work later.
void getRuntimeSolanaRpc;

/**
 * Resolve the mainnet RPC URL string. Same source-of-truth as
 * `getSolanaConnection`, but exposes the URL to callers that need to
 * construct a non-web3.js RPC client (e.g. `@solana/kit`'s `createSolanaRpc`
 * for the Kamino SDK).
 */
export function getSolanaRpcUrl(): string {
  return resolveSolanaRpcUrl(readUserConfig());
}
