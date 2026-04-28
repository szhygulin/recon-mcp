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
import { TRON_ADDRESS } from "../shared/address-patterns.js";

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
 * SunSwap V2 router on TRON mainnet — the canonical Uniswap-V2-fork DEX
 * for same-chain TRX↔TRC20 swaps. Address per the SunSwap team's own
 * deployment record at github.com/sunswapteam/sunswap2.0-contracts (verified
 * 2026-04-28). Pinned as a constant rather than fetched from a registry
 * because (a) router addresses are immutable on V2 and (b) a swap to the
 * wrong contract loses funds — we want the address-correctness boundary
 * checked against the source code, not an external lookup.
 *
 * Smart Router (which aggregates V1/V2/V3/PSM/SunCurve) is intentionally
 * NOT used here — its only published address (TCFNp179...) is testnet-only
 * per the sun-protocol/smart-exchange-router README, and its ABI is a
 * different shape (multi-version path encoding, SwapData struct). Sticking
 * to V2-router-only keeps the calldata encoding simple and the trust
 * surface small. See issue #432.
 */
export const SUNSWAP_V2_ROUTER_TRON = "TNJVzGqKBWkJxJB5XYSqGAwUTV15U24pPq";

/**
 * Wrapped TRX (WTRX) on TRON mainnet. Used as the WETH-equivalent in
 * SunSwap V2 paths — TRX → TRC20 routes have path = [WTRX, toToken];
 * TRC20 → TRC20 routes use [fromToken, WTRX, toToken] when there's no
 * direct pool. Verified via Bitquery on-chain explorer 2026-04-28.
 */
export const WTRX_TRON = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

/**
 * Validate a TRON mainnet base58 address. Mainnet addresses are 34 chars and
 * start with `T` (the mainnet prefix byte 0x41 encodes to `T...` in base58check).
 *
 * This is a cheap shape check, not a full base58check-with-payload-checksum
 * validation — callers that round-trip an address through TronGrid get a
 * stronger guarantee (TronGrid itself rejects malformed addresses).
 */
export function isTronAddress(s: string): boolean {
  return typeof s === "string" && TRON_ADDRESS.test(s);
}
