import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import type { AnyChain } from "../../types/index.js";

/**
 * DefiLlama historical-price client.
 *
 * Shape: GET https://coins.llama.fi/prices/historical/{ts}/{coins}
 * where `coins` is a comma-separated list like `ethereum:0xabc,coingecko:ethereum`.
 * The endpoint takes ONE timestamp per call but any number of coins.
 *
 * Our batching strategy: group all (coinKey, timestamp) tuples by timestamp,
 * make one HTTP call per unique timestamp, cap outstanding calls at CONCURRENCY.
 * Historical prices are immutable, so the cache TTL is 30d (effectively
 * forever for this memory-resident store).
 */

const CONCURRENCY = 10;
const LLAMA_BASE = "https://coins.llama.fi/prices/historical";

const NATIVE_COIN_KEY: Record<AnyChain, string> = {
  ethereum: "coingecko:ethereum",
  arbitrum: "coingecko:ethereum",
  polygon: "coingecko:matic-network",
  base: "coingecko:ethereum",
  optimism: "coingecko:ethereum",
  tron: "coingecko:tron",
};

const LLAMA_CHAIN: Record<AnyChain, string> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  polygon: "polygon",
  base: "base",
  optimism: "optimism",
  tron: "tron",
};

export function nativeCoinKey(chain: AnyChain): string {
  return NATIVE_COIN_KEY[chain];
}

export function tokenCoinKey(chain: AnyChain, tokenAddress: string): string {
  return `${LLAMA_CHAIN[chain]}:${tokenAddress}`;
}

export interface PriceRequest {
  coinKey: string;
  timestamp: number;
}

export interface PriceLookupResult {
  prices: Map<string, number>;
  /** One of the coins didn't come back from DefiLlama. */
  missed: boolean;
}

interface LlamaHistoricalResponse {
  coins: Record<string, { price?: number; timestamp?: number; confidence?: number }>;
}

/** Key for the in-memory cache. */
function cacheKey(coinKey: string, timestamp: number): string {
  return `llama:hist:${timestamp}:${coinKey}`;
}

function priceMapKey(coinKey: string, timestamp: number): string {
  return `${coinKey}@${timestamp}`;
}

/**
 * Look up historical prices for a set of (coin, timestamp) pairs. Pairs with
 * a cache hit short-circuit; the rest are grouped by timestamp and fetched in
 * parallel with a concurrency cap. Missing prices are simply absent from the
 * returned map — callers decide what to do (usually "leave valueUsd undefined
 * and downgrade priceCoverage").
 */
export async function lookupHistoricalPrices(
  requests: PriceRequest[]
): Promise<PriceLookupResult> {
  const prices = new Map<string, number>();
  let missed = false;

  const byTimestamp = new Map<number, Set<string>>();
  for (const req of requests) {
    const hit = cache.get<number>(cacheKey(req.coinKey, req.timestamp));
    if (hit !== undefined) {
      prices.set(priceMapKey(req.coinKey, req.timestamp), hit);
      continue;
    }
    const bucket = byTimestamp.get(req.timestamp) ?? new Set<string>();
    bucket.add(req.coinKey);
    byTimestamp.set(req.timestamp, bucket);
  }

  const tasks: Array<() => Promise<void>> = [];
  for (const [timestamp, coins] of byTimestamp) {
    tasks.push(async () => {
      const coinList = Array.from(coins).join(",");
      const url = `${LLAMA_BASE}/${timestamp}/${encodeURIComponent(coinList)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          missed = true;
          return;
        }
        const body = (await res.json()) as LlamaHistoricalResponse;
        for (const coinKey of coins) {
          const entry = body.coins[coinKey];
          if (entry && typeof entry.price === "number") {
            prices.set(priceMapKey(coinKey, timestamp), entry.price);
            cache.set(
              cacheKey(coinKey, timestamp),
              entry.price,
              CACHE_TTL.HISTORICAL_PRICE
            );
          } else {
            missed = true;
          }
        }
      } catch {
        missed = true;
      }
    });
  }

  await runWithConcurrency(tasks, CONCURRENCY);

  return { prices, missed };
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) await task();
    }
  };
  for (let i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
}

export function getPrice(
  prices: Map<string, number>,
  coinKey: string,
  timestamp: number
): number | undefined {
  return prices.get(priceMapKey(coinKey, timestamp));
}
