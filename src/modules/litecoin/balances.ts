import { assertLitecoinAddress, type LitecoinAddressType } from "./address.js";
import {
  getLitecoinIndexer,
  type LitecoinAddressBalance,
} from "./indexer.js";
import { LTC_DECIMALS, LTC_SYMBOL, LITOSHIS_PER_LTC } from "../../config/litecoin.js";

/**
 * Litecoin balance reader. Mirror of `src/modules/btc/balances.ts` —
 * single + multi-address surface, multi fans out via Promise.allSettled
 * so one failed indexer call doesn't drop the other addresses.
 */

export interface LitecoinBalance {
  address: string;
  addressType: LitecoinAddressType;
  /** Confirmed balance in litoshis (sat-equivalents). */
  confirmedSats: bigint;
  /** Mempool delta in litoshis (can be negative). */
  mempoolSats: bigint;
  /** Confirmed + mempool. */
  totalSats: bigint;
  /** Confirmed-balance LTC as a human-readable decimal string (8 decimals). */
  confirmedLtc: string;
  /** Total (confirmed + mempool) LTC as a human-readable decimal string. */
  totalLtc: string;
  /** Symbol — always "LTC" on mainnet. */
  symbol: typeof LTC_SYMBOL;
  decimals: typeof LTC_DECIMALS;
  /** Number of total tx (confirmed + mempool) the address has been involved in. */
  txCount: number;
}

/**
 * Format litoshis as an LTC decimal string, padding fractional digits to 8.
 */
function litoshisToLtcString(litoshis: bigint): string {
  const negative = litoshis < 0n;
  const abs = negative ? -litoshis : litoshis;
  const whole = abs / LITOSHIS_PER_LTC;
  const frac = abs - whole * LITOSHIS_PER_LTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function projectBalance(
  raw: LitecoinAddressBalance,
  addressType: LitecoinAddressType,
): LitecoinBalance {
  return {
    address: raw.address,
    addressType,
    confirmedSats: raw.confirmedSats,
    mempoolSats: raw.mempoolSats,
    totalSats: raw.totalSats,
    confirmedLtc: litoshisToLtcString(raw.confirmedSats),
    totalLtc: litoshisToLtcString(raw.totalSats),
    symbol: LTC_SYMBOL,
    decimals: LTC_DECIMALS,
    txCount: raw.txCount,
  };
}

export async function getLitecoinBalance(address: string): Promise<LitecoinBalance> {
  const addressType = assertLitecoinAddress(address);
  const raw = await getLitecoinIndexer().getBalance(address);
  return projectBalance(raw, addressType);
}

export type MultiLitecoinBalance =
  | { ok: true; balance: LitecoinBalance }
  | { ok: false; address: string; error: string };

export async function getLitecoinBalances(
  addresses: string[],
): Promise<MultiLitecoinBalance[]> {
  for (const a of addresses) assertLitecoinAddress(a);

  const settled = await Promise.allSettled(addresses.map((a) => getLitecoinBalance(a)));
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return { ok: true as const, balance: r.value };
    return {
      ok: false as const,
      address: addresses[i],
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}
