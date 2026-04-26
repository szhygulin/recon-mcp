/**
 * Litecoin mainnet configuration.
 *
 * Litecoin is a Bitcoin fork (UTXO-based, base58/bech32 addresses, no
 * smart contracts on L1). The server treats Litecoin as strictly
 * additive — existing modules never see Litecoin, and the Litecoin
 * code lives in `src/modules/litecoin/`.
 */

/**
 * Default indexer endpoint — litecoinspace.org is mempool.space's
 * Litecoin sister deployment, exposing the same Esplora-compatible REST
 * surface as mempool.space does for BTC. No API key needed for
 * personal-volume usage. Override via `LITECOIN_INDEXER_URL` env var
 * or `userConfig.litecoinIndexerUrl`.
 *
 * For self-hosted Esplora / Electrs the URL just needs to expose the
 * same REST surface — the indexer abstraction is modeled on
 * Blockstream Esplora's API, which both mempool.space and litecoinspace.org
 * fork.
 */
export const LITECOIN_DEFAULT_INDEXER_URL = "https://litecoinspace.org/api";

/** Native asset metadata. */
export const LTC_DECIMALS = 8; // 1 LTC = 100_000_000 litoshis (sats in code)
export const LTC_SYMBOL = "LTC";
export const LITOSHIS_PER_LTC = 100_000_000n;

/**
 * Default concurrency cap for indexer fan-out. litecoinspace.org has
 * the same throttling characteristics as mempool.space (forked from
 * the same project), so we use the same defaults BTC does. Self-
 * hosted Esplora users with no rate concerns can override via
 * `LITECOIN_INDEXER_PARALLELISM`.
 */
export const LITECOIN_INDEXER_DEFAULT_PARALLELISM = 8;
export const LITECOIN_INDEXER_MAX_PARALLELISM = 32;

/**
 * Resolve the configured indexer fan-out parallelism. Respects the
 * env var when present (clamped to [1, MAX]); otherwise the default.
 */
export function resolveLitecoinIndexerParallelism(): number {
  const raw = process.env.LITECOIN_INDEXER_PARALLELISM;
  if (raw === undefined || raw.trim() === "") {
    return LITECOIN_INDEXER_DEFAULT_PARALLELISM;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return LITECOIN_INDEXER_DEFAULT_PARALLELISM;
  }
  return Math.min(LITECOIN_INDEXER_MAX_PARALLELISM, parsed);
}

/**
 * Resolve the optional Litecoin Core JSON-RPC client config — mirror of
 * `resolveBitcoinRpcConfig`. Issue #248. Same env-var family with the
 * `LITECOIN_` prefix. See the BTC counterpart for the auth-mode
 * priority order.
 *
 * Self-hosted Litecoin Core is very cheap relative to Bitcoin Core: a
 * pruned `litecoind -prune=5000` is ~5GB on disk and ~6h to IBD on a
 * residential connection (vs ~10GB / ~2 days for BTC). For users who
 * want a second indexer-independent opinion on LTC, self-hosting is
 * the most accessible route. Documented in INSTALL.md alongside the
 * provider list.
 */
import { resolveAuthFromEnv } from "./btc.js";
import type { JsonRpcClientConfig } from "../data/jsonrpc.js";

export function resolveLitecoinRpcConfig(): JsonRpcClientConfig | null {
  const url = process.env.LITECOIN_RPC_URL;
  if (!url || url.trim() === "") return null;
  return { url: url.trim(), auth: resolveAuthFromEnv("LITECOIN") };
}
