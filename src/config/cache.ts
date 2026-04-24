/** TTLs (milliseconds) for the in-memory cache, keyed by data category. */
export const CACHE_TTL = {
  PRICE: 30_000,
  POSITION: 60_000,
  STAKING: 120_000,
  YIELD: 600_000,
  SECURITY_VERIFICATION: 86_400_000,
  SECURITY_PERMISSIONS: 3_600_000,
  PROTOCOL_RISK: 3_600_000,
  IMMUNEFI: 86_400_000,
  HISTORY: 60_000,
  HISTORICAL_PRICE: 2_592_000_000,
  /**
   * Morpho Blue market-id discovery. A full event-log scan on mainnet walks
   * ~millions of blocks in 10k-block chunks via `eth_getLogs` — the dominant
   * source of Infura 429s in #88. A new Morpho position lands in the scan
   * immediately on the next cache miss, so the cache window is a tradeoff
   * between "RPC pressure" and "how quickly a just-opened position shows
   * up". 180s = 3 min covers the dominant "user runs 3 portfolio summaries
   * back-to-back" pattern without noticeably stale discovery.
   */
  MORPHO_DISCOVERY: 180_000,
} as const;

export type CacheTTLKey = keyof typeof CACHE_TTL;
