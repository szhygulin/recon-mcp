import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * LTC USD price via DefiLlama's `coingecko:litecoin` coin key. Same
 * 30-second cache TTL the EVM/Solana/TRON/BTC price service uses,
 * sharing the same in-process `cache` so a single warm read amortizes
 * across `get_portfolio_summary` + LTC balance reads + future
 * Litecoin-aware tools.
 *
 * Mirror of `src/modules/btc/price.ts` — same hardcoded-key pattern.
 */

interface LlamaResponse {
  coins: Record<string, { price: number }>;
}

const COIN_KEY = "coingecko:litecoin";
const CACHE_KEY = `price:${COIN_KEY}`;
const URL = `https://coins.llama.fi/prices/current/${COIN_KEY}`;

export async function fetchLitecoinPrice(): Promise<number | undefined> {
  const hit = cache.get<number>(CACHE_KEY);
  if (hit !== undefined) return hit;
  try {
    const res = await fetchWithTimeout(URL);
    if (!res.ok) return undefined;
    const body = (await res.json()) as LlamaResponse;
    const price = body.coins[COIN_KEY]?.price;
    if (typeof price === "number") {
      cache.set(CACHE_KEY, price, CACHE_TTL.PRICE);
      return price;
    }
  } catch {
    // Best-effort — caller surfaces the slice as `priceMissing` so the
    // raw LTC balance still renders without a USD valuation.
  }
  return undefined;
}
