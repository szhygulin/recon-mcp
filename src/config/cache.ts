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
} as const;

export type CacheTTLKey = keyof typeof CACHE_TTL;
