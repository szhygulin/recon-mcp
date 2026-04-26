/**
 * Bitcoin mainnet configuration.
 *
 * Bitcoin is UTXO-based (not account-based), addresses are base58/bech32
 * (no `0x` prefix), no smart contracts on L1. The server treats Bitcoin
 * as strictly additive — existing EVM modules never see Bitcoin, and the
 * Bitcoin code lives in `src/modules/btc/`.
 */

/**
 * Default indexer endpoint — mempool.space's free public API. No API key
 * needed for personal-volume usage. Per-IP soft rate limit, generous in
 * practice. Override via `BITCOIN_INDEXER_URL` env var or
 * `userConfig.bitcoinIndexerUrl` (set up in PR1; the env var is read at
 * indexer construction time).
 *
 * For self-hosted Esplora / Electrs the URL just needs to expose the same
 * REST surface — mempool.space's API is a fork of Blockstream Esplora's,
 * which is what the indexer abstraction is modeled on.
 */
export const BITCOIN_DEFAULT_INDEXER_URL = "https://mempool.space/api";

/** Native asset metadata. */
export const BTC_DECIMALS = 8; // 1 BTC = 100_000_000 satoshis
export const BTC_SYMBOL = "BTC";
export const SATS_PER_BTC = 100_000_000n;

/**
 * Default concurrency cap for indexer fan-out (e.g. `rescan_btc_account`,
 * `get_btc_account_balance`). Mempool.space's free public API rate-
 * limits bursts; sending the full BIP-44 cache (often 100+ addresses)
 * in parallel previously dropped ~40% of probes (issue #199). A cap
 * of 8 keeps us comfortably under their published limits while still
 * being substantially faster than serial. Self-hosted Esplora users
 * with no rate concerns can override via `BITCOIN_INDEXER_PARALLELISM`.
 */
export const BITCOIN_INDEXER_DEFAULT_PARALLELISM = 8;
export const BITCOIN_INDEXER_MAX_PARALLELISM = 32;

/**
 * Resolve the configured indexer fan-out parallelism. Respects the
 * env var when present (clamped to [1, MAX]); otherwise the default.
 */
export function resolveBitcoinIndexerParallelism(): number {
  const raw = process.env.BITCOIN_INDEXER_PARALLELISM;
  if (raw === undefined || raw.trim() === "") {
    return BITCOIN_INDEXER_DEFAULT_PARALLELISM;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return BITCOIN_INDEXER_DEFAULT_PARALLELISM;
  }
  return Math.min(BITCOIN_INDEXER_MAX_PARALLELISM, parsed);
}

/**
 * Resolve the optional Bitcoin Core JSON-RPC client config. Issue #248
 * adds forensic-tier tools that require a bitcoind RPC endpoint —
 * Esplora indexers cannot expose `getchaintips` (fork detection) or
 * `getrawmempool` (mempool census) at all. When this returns `null`,
 * the RPC tools surface `available: false, reason: "BITCOIN_RPC_URL not set"`.
 *
 * Auth-mode resolution (env vars override user config):
 *   - `BITCOIN_RPC_URL`        — endpoint (required to enable RPC at all)
 *   - `BITCOIN_RPC_COOKIE`     — path to cookie file (preferred for
 *                                self-hosted bitcoind; daemon writes
 *                                ~/.bitcoin/.cookie by default)
 *   - `BITCOIN_RPC_USER` + `BITCOIN_RPC_PASSWORD` — basic auth fallback
 *                                (when the daemon was started with
 *                                rpcuser/rpcpassword in bitcoin.conf
 *                                rather than cookie auth)
 *   - `BITCOIN_RPC_AUTH_HEADER_NAME` + `BITCOIN_RPC_AUTH_HEADER_VALUE`
 *                              — for hosted providers (Quicknode,
 *                                NOWNodes, Helius, etc.) that auth via
 *                                a custom header instead of HTTP basic
 *
 * Cookie takes precedence over basic, which takes precedence over header.
 * When URL is set but no auth is configured, returns kind="none" — the
 * daemon will reject with HTTP 401 unless it's set to allow unauth'd
 * RPC, which is rare.
 */
import type { JsonRpcAuth, JsonRpcClientConfig } from "../data/jsonrpc.js";

export function resolveBitcoinRpcConfig(): JsonRpcClientConfig | null {
  const url = process.env.BITCOIN_RPC_URL;
  if (!url || url.trim() === "") return null;
  const auth: JsonRpcAuth = resolveAuthFromEnv("BITCOIN");
  return { url: url.trim(), auth };
}

/**
 * Internal helper — picks the first configured auth flavor from env
 * vars. Exported for testing the priority order; the real resolvers
 * invoke this via their per-chain prefix.
 */
export function resolveAuthFromEnv(prefix: "BITCOIN" | "LITECOIN"): JsonRpcAuth {
  const cookie = process.env[`${prefix}_RPC_COOKIE`];
  if (cookie && cookie.trim() !== "") {
    return { kind: "cookie", cookiePath: cookie.trim() };
  }
  const user = process.env[`${prefix}_RPC_USER`];
  const password = process.env[`${prefix}_RPC_PASSWORD`];
  if (user && password) {
    return { kind: "basic", user, password };
  }
  const headerName = process.env[`${prefix}_RPC_AUTH_HEADER_NAME`];
  const headerValue = process.env[`${prefix}_RPC_AUTH_HEADER_VALUE`];
  if (headerName && headerValue) {
    return { kind: "header", headerName, headerValue };
  }
  return { kind: "none" };
}
