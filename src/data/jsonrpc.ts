/**
 * Minimal JSON-RPC v1.0 client for bitcoind / litecoind. Issue #248.
 *
 * Both Bitcoin Core and Litecoin Core speak JSON-RPC v1.0 (NOT v2.0 —
 * the `params` field is a positional array, the response carries
 * `error` and `result` at top level, no `jsonrpc: "2.0"` envelope).
 * This client targets that dialect; if we ever add a different
 * JSON-RPC backend (Solana, Ethereum), build a separate v2 client.
 *
 * Auth modes — three flavors covering self-hosted, self-hosted-with-
 * config, and provider scenarios:
 *   - basic auth via `user` + `password` (typical bitcoind config-file setup)
 *   - cookie path (default bitcoind / litecoind: `~/.bitcoin/.cookie`)
 *   - header-based (Quicknode, Helius, NOWNodes, etc.)
 *
 * Implementation note: kept hand-rolled per the same tight-dep policy
 * documented in `pLimitMap`. Pulling `bitcoin-core` or `node-bitcoin-rpc`
 * for ~100 lines of request shaping + auth selection isn't worth the
 * supply-chain surface, especially against code that runs in a
 * self-custody context.
 */
import { readFileSync } from "node:fs";
import { fetchWithTimeout } from "./http.js";

export interface JsonRpcCookieAuth {
  kind: "cookie";
  /** Path to bitcoind / litecoind cookie file. Read on every call so
   * we don't cache a stale value across daemon restarts. */
  cookiePath: string;
}

export interface JsonRpcBasicAuth {
  kind: "basic";
  user: string;
  password: string;
}

export interface JsonRpcHeaderAuth {
  kind: "header";
  /** Full header value, e.g. "Bearer <token>" or "<provider-token>". */
  headerName: string;
  headerValue: string;
}

export type JsonRpcAuth =
  | JsonRpcCookieAuth
  | JsonRpcBasicAuth
  | JsonRpcHeaderAuth
  | { kind: "none" };

export interface JsonRpcClientConfig {
  /** Endpoint URL — typically `http://127.0.0.1:8332` for bitcoind. */
  url: string;
  auth: JsonRpcAuth;
  /** Per-call wall-clock cap. 30s default — comfortable for slow RPCs
   * like getrawmempool on a busy node, fast enough that a dead node
   * fails before the agent times out. */
  timeoutMs?: number;
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    public code: number,
    public data: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcTransportError";
  }
}

interface JsonRpcResponse<T> {
  result: T | null;
  error: { code: number; message: string; data?: unknown } | null;
  /** Echoed back from request; v1.0 may also use a string or null. */
  id: string | number | null;
}

function buildAuthHeaders(auth: JsonRpcAuth): Record<string, string> {
  switch (auth.kind) {
    case "cookie": {
      // Read on every call so daemon restart (which rotates the cookie)
      // is picked up without process restart. Cookie file format is
      // `__cookie__:<password>` in plaintext.
      const raw = readFileSync(auth.cookiePath, "utf8").trim();
      return {
        Authorization: `Basic ${Buffer.from(raw).toString("base64")}`,
      };
    }
    case "basic":
      return {
        Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`,
      };
    case "header":
      return { [auth.headerName]: auth.headerValue };
    case "none":
      return {};
  }
}

/**
 * Single-method JSON-RPC call. Throws `JsonRpcError` for protocol-level
 * errors (the daemon returned `error: {code, message}`) and
 * `JsonRpcTransportError` for network / HTTP / parse failures. Callers
 * can branch on the constructor name to give different UX for "the
 * node said no" vs "we couldn't reach the node."
 */
export async function jsonRpcCall<T>(
  config: JsonRpcClientConfig,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(config.auth),
  };
  const body = JSON.stringify({
    jsonrpc: "1.0",
    id: method,
    method,
    params,
  });
  let res: Response;
  try {
    res = await fetchWithTimeout(
      config.url,
      { method: "POST", headers, body },
      config.timeoutMs ?? 30_000,
    );
  } catch (err) {
    throw new JsonRpcTransportError(
      `${method} transport error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // bitcoind returns 401/403 on bad auth, 500 on RPC method errors. The
  // 500 still has a JSON body with `error.code` / `error.message`, so
  // we read it before deciding to throw at the HTTP layer.
  let parsed: JsonRpcResponse<T>;
  try {
    parsed = (await res.json()) as JsonRpcResponse<T>;
  } catch (err) {
    throw new JsonRpcTransportError(
      `${method} returned non-JSON body (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.error !== null) {
    throw new JsonRpcError(
      `${method}: ${parsed.error.message}`,
      parsed.error.code,
      parsed.error.data,
    );
  }
  if (!res.ok) {
    // No structured error but non-2xx status — surface the HTTP code so
    // the agent can distinguish auth (401) from rate-limit (429) etc.
    throw new JsonRpcTransportError(
      `${method} returned HTTP ${res.status} ${res.statusText} with no JSON-RPC error envelope`,
    );
  }
  if (parsed.result === null) {
    // Some methods (`getmempoolinfo` doesn't, but null-result-on-success
    // happens for stop / setban / etc.) legitimately return null; for the
    // read-only methods we use, null is unexpected. Surface as transport
    // error so the agent can check the daemon is on the expected version.
    throw new JsonRpcTransportError(
      `${method} returned null result with no error — likely a daemon-version mismatch`,
    );
  }
  return parsed.result;
}
