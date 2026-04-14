/**
 * TRON mainnet configuration.
 *
 * TRON is not EVM: addresses are base58 (prefix `T`, 34 chars), the RPC is a
 * REST API (TronGrid) rather than JSON-RPC, and transaction signing uses a
 * different wire format. The server treats TRON as strictly additive via
 * `AnyChain = SupportedChain | SupportedNonEvmChain` — existing EVM modules
 * never see TRON, and the TRON reader lives in src/modules/tron/.
 */

/** TronGrid REST endpoint. Anonymous requests are rate-limited to ~15 req/min. */
export const TRONGRID_BASE_URL = "https://api.trongrid.io";

/**
 * Canonical TRC-20 tokens we enumerate in the portfolio summary. Keys are the
 * displayed symbol; values are the TRC-20 contract addresses in base58.
 *
 * TRON is dominated by USDT (Tether issues more on TRON than on any other
 * chain by volume), so the wallet balance fan-out is small on purpose —
 * USDT, USDC, and the few stablecoins that matter cover >95% of balances in
 * practice. TronScan top-holders data confirms the long tail is negligible
 * compared to the Ethereum equivalent.
 */
export const TRON_TOKENS = {
  USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  USDC: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
  USDD: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR",
  TUSD: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4",
} as const;

/** Native TRX symbol + decimals. TRX uses 6 decimals (1 TRX = 1_000_000 sun). */
export const TRX_DECIMALS = 6;
export const TRX_SYMBOL = "TRX";

/**
 * Validate a TRON mainnet base58 address. Mainnet addresses are 34 chars and
 * start with `T` (the mainnet prefix byte 0x41 encodes to `T...` in base58check).
 *
 * This is a cheap shape check, not a full base58check-with-payload-checksum
 * validation — callers that round-trip an address through TronGrid get a
 * stronger guarantee (TronGrid itself rejects malformed addresses).
 */
export function isTronAddress(s: string): boolean {
  return typeof s === "string" && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s);
}
