import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * BTC USD price via DefiLlama's `coingecko:bitcoin` coin key. Same
 * 30-second cache TTL the EVM/Solana/TRON price service uses, sharing
 * the same in-process `cache` so a single warm read amortizes across
 * `get_portfolio_summary` + `get_btc_balance` + future BTC-aware tools.
 *
 * Modeled on `fetchTrxPrice` in `tron/staking.ts` rather than the EVM
 * `data/prices.ts` because the latter is keyed by `SupportedChain`
 * (EVM-only) and adding "bitcoin" to that enum would propagate
 * `Record<SupportedChain, …>` churn through every viem-client table in
 * the codebase. Bitcoin's price-fetch is a single hardcoded key — the
 * marginal cost of a sibling helper is lower than expanding the EVM
 * enum.
 */

interface LlamaResponse {
  coins: Record<string, { price: number }>;
}

const COIN_KEY = "coingecko:bitcoin";
const CACHE_KEY = `price:${COIN_KEY}`;
const URL = `https://coins.llama.fi/prices/current/${COIN_KEY}`;

export async function fetchBitcoinPrice(): Promise<number | undefined> {
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
    // raw BTC balance still renders without a USD valuation.
  }
  return undefined;
}
