/**
 * USDT-TRC20 blacklist probe for the `usdt_blacklist_event` incident
 * signal (issue #249).
 *
 * Tether's USDT-TRC20 contract at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
 * carries an `isBlackListed(address) returns (bool)` view method (verified
 * 2026-04-26 via live `triggerconstantcontract`; selector `0xe47d6060`).
 * When Tether flags an address, USDT held there is effectively frozen —
 * the issuer can also `destroyBlackFunds` to burn the balance entirely.
 * For the user, the operationally-relevant questions are:
 *
 *   1. Have I sent USDT to a blacklisted address recently? Funds may be
 *      stuck on the recipient side (issuer freeze) — not directly your
 *      problem, but adjacent if you were expecting a settlement.
 *   2. Has any address that sent me USDT been blacklisted? Tether has
 *      historically extended freezes to downstream balances in some
 *      enforcement actions; potentially-tainted incoming.
 *
 * This module provides a small, cached, batched probe — no chain mutation.
 * The signal layer (`chain-tron.ts`) feeds it counterparty addresses
 * pulled from the user's recent TRON tx history.
 */
import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { fetchWithTimeout } from "../../data/http.js";
import { isTronAddress } from "../../config/tron.js";
import { base58ToHex } from "./address.js";

/** USDT-TRC20 mainnet contract — same constant as `config/tron.ts:TRON_TOKENS.USDT`. */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/**
 * Cache TTL per (address). Blacklisting is rare and a 1h staleness is
 * tolerable for a "did the issuer freeze them" signal — the alternative
 * (every-call probe) would amplify TronGrid load on a fan-out the user
 * runs idiomatically per chat session. Issue #249 design table.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  blacklisted: boolean;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only hook to flush the in-memory cache between cases. */
export function _clearUsdtBlacklistCacheForTests(): void {
  cache.clear();
}

interface TrongridConstantResponse {
  result?: { result?: boolean; message?: string };
  constant_result?: string[];
}

/**
 * Probe `isBlackListed(address)` for one address. Returns `true` /
 * `false` on a clean call; throws on transport / RPC failure so the
 * caller can decide whether to surface `available: false` or treat the
 * address as "not blacklisted" optimistically.
 */
async function probeOne(
  address: string,
  apiKey: string | undefined,
): Promise<boolean> {
  if (!isTronAddress(address)) {
    throw new Error(`"${address}" is not a valid TRON mainnet address.`);
  }
  // ABI-encode the address arg: 32-byte left-padded, 0x41 version byte
  // stripped (TRC-20 ABI uses the EVM 20-byte form).
  const addrHex21 = base58ToHex(address);
  const addrHex20 = addrHex21.slice(2);
  const parameter = addrHex20.padStart(64, "0");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const res = await fetchWithTimeout(
    `${TRONGRID_BASE_URL}/wallet/triggerconstantcontract`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner_address: USDT_TRC20_CONTRACT,
        contract_address: USDT_TRC20_CONTRACT,
        function_selector: "isBlackListed(address)",
        parameter,
        visible: true,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `TronGrid /wallet/triggerconstantcontract returned ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as TrongridConstantResponse;
  if (body.result?.result === false) {
    throw new Error(
      `triggerconstantcontract pre-validation rejected: ${body.result.message ?? "unknown"}`,
    );
  }
  const word = body.constant_result?.[0];
  if (typeof word !== "string" || word.length < 2) {
    throw new Error(
      `triggerconstantcontract returned no constant_result word for isBlackListed(${address}).`,
    );
  }
  // ABI bool: 32 bytes; non-zero = true.
  // Strip leading zeros and check whether anything remains.
  const trimmed = word.replace(/^0+/, "");
  return trimmed.length > 0;
}

/** Result row from `checkUsdtBlacklist`. */
export interface UsdtBlacklistResult {
  address: string;
  /** Whether the contract reported true on `isBlackListed(address)`. */
  blacklisted: boolean;
  /** Whether the value came from the in-memory 1h cache (vs a live probe). */
  fromCache: boolean;
}

/**
 * Batch-probe `isBlackListed` for `addresses`. Returns one row per input
 * address (deduplicated upstream by the caller — this helper does not
 * dedupe so the caller can preserve direction context — `addresses`
 * passed in twice will probe twice).
 *
 * Cache: 1h per address. Misses fan out in parallel against TronGrid.
 * Per-address probe failures throw — the caller wraps the whole call
 * in a try/catch and emits `available: false` on any error so the
 * incident rollup never silently green-lights when we couldn't ask.
 */
export async function checkUsdtBlacklist(
  addresses: ReadonlyArray<string>,
  options: { now?: number } = {},
): Promise<UsdtBlacklistResult[]> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const now = options.now ?? Date.now();

  // Dedupe internally: a blacklist verdict for an address is the same
  // regardless of how many slots in the input array refer to it. Probe
  // each unique uncached address ONCE; emit one result row per input
  // slot so the caller's order/index assumptions hold. The first slot
  // pointing at a uncached address gets fromCache:false; later slots
  // pointing at the same address see the just-warmed cache.
  const uniqueLive = new Map<string, boolean>();
  for (const a of addresses) {
    const hit = cache.get(a);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) continue;
    uniqueLive.set(a, false); // value placeholder; overwritten below
  }

  if (uniqueLive.size > 0) {
    const liveAddrs = [...uniqueLive.keys()];
    const fetched = await Promise.all(
      liveAddrs.map((address) => probeOne(address, apiKey)),
    );
    for (let i = 0; i < liveAddrs.length; i++) {
      cache.set(liveAddrs[i], { blacklisted: fetched[i], fetchedAt: now });
    }
  }

  // Build the output array in input order. By this point every
  // address either had a fresh cache entry to begin with, or we
  // populated one above. So every read here is a guaranteed hit; the
  // `fromCache` bit reflects PRE-CALL state.
  const seenLive = new Set<string>();
  const results: UsdtBlacklistResult[] = [];
  for (const a of addresses) {
    const entry = cache.get(a);
    if (!entry) {
      // Should not happen — uniqueLive populated the cache for every
      // miss. Defensive fallback: treat as live false.
      results.push({ address: a, blacklisted: false, fromCache: false });
      continue;
    }
    if (uniqueLive.has(a) && !seenLive.has(a)) {
      seenLive.add(a);
      results.push({ address: a, blacklisted: entry.blacklisted, fromCache: false });
    } else {
      results.push({ address: a, blacklisted: entry.blacklisted, fromCache: true });
    }
  }
  return results;
}
