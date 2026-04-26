import { assertBitcoinAddress, type BitcoinAddressType } from "./address.js";
import {
  getBitcoinIndexer,
  type BitcoinAddressBalance,
} from "./indexer.js";
import { BTC_DECIMALS, BTC_SYMBOL, SATS_PER_BTC } from "../../config/btc.js";
import { fetchBitcoinPrice } from "./price.js";

/**
 * Bitcoin balance reader. Single + multi-address surface; multi fans out
 * via Promise.allSettled so one failed indexer call doesn't drop the
 * other addresses. The portfolio aggregator and the standalone
 * `get_btc_balance` tool both call into this module.
 *
 * Pricing is intentionally NOT done here — same separation as the EVM /
 * TRON / Solana balance readers: this module returns sat-denominated
 * raw + formatted-BTC strings, and the caller layers USD on top via
 * the price service. Keeps the module pure (no network besides the
 * indexer call) and lets higher-level callers reuse the price cache.
 */

/**
 * Per-address balance projection. Carries the indexer's confirmed +
 * mempool split, the address-type tag (so callers can hint UX about
 * legacy vs taproot), and human-readable BTC amounts derived from sats.
 */
export interface BitcoinBalance {
  address: string;
  addressType: BitcoinAddressType;
  /** Confirmed balance in sats. */
  confirmedSats: bigint;
  /** Mempool delta in sats (can be negative). */
  mempoolSats: bigint;
  /** Confirmed + mempool. */
  totalSats: bigint;
  /** Confirmed-balance BTC as a human-readable decimal string (8 decimals). */
  confirmedBtc: string;
  /** Total (confirmed + mempool) BTC as a human-readable decimal string. */
  totalBtc: string;
  /** Symbol — always "BTC" on mainnet. Surfaced for UX symmetry with the EVM TokenAmount shape. */
  symbol: typeof BTC_SYMBOL;
  decimals: typeof BTC_DECIMALS;
  /** Number of total tx (confirmed + mempool) the address has been involved in. */
  txCount: number;
  /**
   * USD price per 1 BTC at lookup time (DefiLlama). Issue #274 — folds
   * pricing into the read so callers don't need to compose `get_btc_balance`
   * + `get_coin_price` themselves. Absent when DefiLlama was unreachable.
   */
  priceUsd?: number;
  /**
   * Confirmed balance × `priceUsd`. Absent when `priceUsd` is absent.
   * Computed from the confirmed amount only — mempool deltas can flip
   * sign and aren't load-bearing for "what's this wallet worth".
   */
  valueUsd?: number;
  /** True iff DefiLlama returned no price; set so callers can flag it without checking undefined. */
  priceMissing?: boolean;
}

/**
 * Format sats as a BTC decimal string, padding fractional digits to 8.
 * Avoids floating-point — the integer is split into whole/frac parts and
 * recombined as a string.
 */
function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = abs - whole * SATS_PER_BTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function projectBalance(
  raw: BitcoinAddressBalance,
  addressType: BitcoinAddressType,
  priceUsd: number | undefined,
): BitcoinBalance {
  const base: BitcoinBalance = {
    address: raw.address,
    addressType,
    confirmedSats: raw.confirmedSats,
    mempoolSats: raw.mempoolSats,
    totalSats: raw.totalSats,
    confirmedBtc: satsToBtcString(raw.confirmedSats),
    totalBtc: satsToBtcString(raw.totalSats),
    symbol: BTC_SYMBOL,
    decimals: BTC_DECIMALS,
    txCount: raw.txCount,
  };
  if (priceUsd === undefined) {
    base.priceMissing = true;
    return base;
  }
  base.priceUsd = priceUsd;
  // Confirmed-only valuation (mempool can be negative). 8 decimals.
  const confirmedBtcNum = Number(satsToBtcString(raw.confirmedSats));
  if (Number.isFinite(confirmedBtcNum)) {
    base.valueUsd = Math.round(confirmedBtcNum * priceUsd * 100) / 100;
  }
  return base;
}

export async function getBitcoinBalance(address: string): Promise<BitcoinBalance> {
  const addressType = assertBitcoinAddress(address);
  const [raw, priceUsd] = await Promise.all([
    getBitcoinIndexer().getBalance(address),
    fetchBitcoinPrice(),
  ]);
  return projectBalance(raw, addressType, priceUsd);
}

/**
 * Multi-address fan-out. Errors per-address are surfaced as `errored`
 * entries rather than failing the whole call — mirrors how EVM
 * portfolio enumeration handles flaky RPCs (one bad chain doesn't
 * tank the whole summary).
 */
export type MultiBitcoinBalance =
  | { ok: true; balance: BitcoinBalance }
  | { ok: false; address: string; error: string };

export async function getBitcoinBalances(
  addresses: string[],
): Promise<MultiBitcoinBalance[]> {
  // Validate all addresses up-front; bail on the first malformed entry
  // because mixing valid + invalid addresses in a single call is almost
  // always a typo, not a deliberate query.
  for (const a of addresses) assertBitcoinAddress(a);

  const settled = await Promise.allSettled(addresses.map((a) => getBitcoinBalance(a)));
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return { ok: true as const, balance: r.value };
    return {
      ok: false as const,
      address: addresses[i],
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}
