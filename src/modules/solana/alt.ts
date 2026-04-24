import {
  AddressLookupTableAccount,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";

/**
 * Address Lookup Table (ALT) resolver — fetches on-chain ALT accounts and
 * caches them per-process so multiple verifier runs don't re-hit the RPC
 * for stable ALT contents.
 *
 * ALTs are a Solana v0-message feature: a tx can reference a "lookup table"
 * address + an index into that table instead of embedding the full 32-byte
 * pubkey in the message. This is what lets Jupiter routes fit 40+ accounts
 * into a message — legacy transactions cap out around 35. To verify a v0
 * message's accounts (e.g., in the CHECK 1 instruction-decode rendering),
 * you MUST resolve ALT indices via the ALT's on-chain `state.addresses`
 * list; there's no on-message-only way to do it.
 *
 * Cache notes:
 *   - ALT contents are append-only (once an address is written to an ALT,
 *     it never changes at that index) so caching the `AddressLookupTableAccount`
 *     indefinitely is safe for the resolve-indices-to-pubkeys case.
 *   - But ALTs can be EXTENDED: a later ExtendLookupTable ix adds more
 *     addresses. If a tx references an index beyond what our cached state
 *     knows about, we'd miss the resolution. Mitigation: the cache is
 *     keyed by ALT pubkey; we invalidate on any tx whose highest index
 *     exceeds the cached `state.addresses.length` (caller checks + calls
 *     `invalidateAlt`). In practice rare — Jupiter's routing ALTs are
 *     stable, and a cache miss just re-fetches.
 *   - In-process Map (no TTL). Process lifetime matches a single MCP
 *     server session; we want ALT reads to be cheap for back-to-back
 *     verifier runs in the same session.
 */
const altCache = new Map<string, AddressLookupTableAccount>();

/**
 * Resolve ALT pubkeys to on-chain `AddressLookupTableAccount` instances,
 * in the same order as the input. Throws on any ALT that doesn't exist
 * on chain — a tx referencing a missing ALT is unverifiable, and silently
 * dropping it would hide an on-chain correctness problem from the agent's
 * CHECK 1 decode.
 */
export async function resolveAddressLookupTables(
  conn: Connection,
  altPubkeys: PublicKey[],
): Promise<AddressLookupTableAccount[]> {
  if (altPubkeys.length === 0) return [];

  const results = await Promise.all(
    altPubkeys.map(async (key) => {
      const cacheKey = key.toBase58();
      const cached = altCache.get(cacheKey);
      if (cached) return cached;
      const res = await conn.getAddressLookupTable(key);
      if (!res.value) {
        throw new Error(
          `Address lookup table ${cacheKey} does not exist on chain — a v0 tx references ` +
            `it but the account is missing. Cannot verify the tx's ALT-indexed accounts. ` +
            `Refuse to sign until this is resolved (likely an MCP-side reference to a fabricated ALT).`,
        );
      }
      altCache.set(cacheKey, res.value);
      return res.value;
    }),
  );
  return results;
}

/**
 * Drop a cache entry — call this when a tx references an index beyond
 * what the cached ALT knows about (suggests the ALT was extended since
 * last fetch). The next `resolveAddressLookupTables` call will re-fetch.
 */
export function invalidateAlt(altPubkey: PublicKey): void {
  altCache.delete(altPubkey.toBase58());
}

/** Test-only: reset the cache between test suites. */
export function clearAltCache(): void {
  altCache.clear();
}
