import { cache } from "./cache.js";
import { CACHE_TTL } from "../config/cache.js";
import type { SupportedChain } from "../types/index.js";
import { fetchWithTimeout } from "./http.js";

/**
 * DefiLlama free price API.
 * Docs: https://defillama.com/docs/api  (coins endpoint)
 * Example: GET https://coins.llama.fi/prices/current/ethereum:0xabc...,arbitrum:0xdef...
 */
const DEFILLAMA_BASE = "https://coins.llama.fi";

/** DefiLlama uses these chain identifiers. */
const LLAMA_CHAIN: Record<SupportedChain, string> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  polygon: "polygon",
  base: "base",
  optimism: "optimism",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/**
 * Coingecko ID for each chain's native asset.
 * Ethereum / Arbitrum / Base / Optimism share ETH.
 * Polygon native was renamed MATIC → POL in Sept 2024; CoinGecko renamed the
 * coin from `matic-network` (DefiLlama now returns `{"coins":{}}` for that
 * key) to `polygon-ecosystem-token`. Issue #94 traced missing polygon-native
 * USD valuations on portfolio totals to the stale key. Verified empirically
 * against `coins.llama.fi/prices/current/...` — the new key returns POL at
 * current price; the old key returns empty.
 */
const NATIVE_COINGECKO_ID: Record<SupportedChain, string> = {
  ethereum: "coingecko:ethereum",
  arbitrum: "coingecko:ethereum",
  polygon: "coingecko:polygon-ecosystem-token",
  base: "coingecko:ethereum",
  optimism: "coingecko:ethereum",
};

export interface PriceQuery {
  chain: SupportedChain;
  address: `0x${string}` | "native";
}

interface LlamaResponse {
  coins: Record<string, { price: number; symbol?: string; decimals?: number; timestamp?: number }>;
}

function queryToLlamaKey(q: PriceQuery): string {
  if (q.address === "native" || q.address.toLowerCase() === ZERO_ADDRESS) {
    return NATIVE_COINGECKO_ID[q.chain];
  }
  return `${LLAMA_CHAIN[q.chain]}:${q.address.toLowerCase()}`;
}

function cacheKey(q: PriceQuery): string {
  return `price:${queryToLlamaKey(q)}`;
}

/**
 * Batch fetch USD prices for the given tokens. Results are cached 30s.
 * Missing tokens are simply absent from the returned map.
 */
export async function getTokenPrices(queries: PriceQuery[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const toFetch: PriceQuery[] = [];

  // Satisfy anything we already have in cache.
  for (const q of queries) {
    const hit = cache.get<number>(cacheKey(q));
    if (hit !== undefined) {
      out.set(queryToLlamaKey(q), hit);
    } else {
      toFetch.push(q);
    }
  }

  if (toFetch.length === 0) return out;

  // DefiLlama accepts comma-separated keys. Chunk to avoid URL size limits.
  const CHUNK = 50;
  for (let i = 0; i < toFetch.length; i += CHUNK) {
    const chunk = toFetch.slice(i, i + CHUNK);
    const keys = chunk.map(queryToLlamaKey).join(",");
    const url = `${DEFILLAMA_BASE}/prices/current/${encodeURIComponent(keys)}`;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const body = (await res.json()) as LlamaResponse;
      for (const q of chunk) {
        const key = queryToLlamaKey(q);
        const coin = body.coins[key];
        if (coin && typeof coin.price === "number") {
          out.set(key, coin.price);
          cache.set(cacheKey(q), coin.price, CACHE_TTL.PRICE);
        }
      }
    } catch {
      // Swallow — callers degrade gracefully when a price is missing.
    }
  }

  return out;
}

/** Convenience: look up a single price, return undefined if unknown. */
export async function getTokenPrice(chain: SupportedChain, address: `0x${string}` | "native"): Promise<number | undefined> {
  const map = await getTokenPrices([{ chain, address }]);
  return map.get(queryToLlamaKey({ chain, address }));
}
