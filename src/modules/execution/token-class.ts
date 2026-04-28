/**
 * Curated registry of tokens with non-standard ERC-20 transfer
 * semantics (issue #441). Looked up at `prepare_token_send` time so
 * the receipt carries `tokenClass.flags` + a user-facing warning
 * before the user signs. The smoke-test trigger was script 019:
 * a 0.3 stETH transfer where the calldata lands ~1-2 wei short of
 * the requested amount due to share-rounding drift, with no warning.
 *
 * Scope cut for v1 (per issue #441 implementation plan): seed only
 * the `rebasing` class. The other enum values are defined here so
 * the type surface is forward-stable, but populating them needs a
 * concrete failing case + curated address list for each — deferred
 * to follow-up issues to avoid noisy warnings on common tokens
 * (e.g. every USDC transfer would fire `upgradeable_admin`) and
 * registry maintenance for tokens nobody actually transfers
 * (long-tail FoT memecoins).
 */

import { CONTRACTS } from "../../config/contracts.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * The full enum surface. Adding a new class is just data — no schema
 * change. The warning string is what the user actually reads, so it
 * should be one or two sentences with a concrete next step (wrap, swap,
 * verify recipient is not on the issuer's blocklist, etc.).
 */
export type TokenClassFlag =
  | "standard"
  | "rebasing"
  | "fee_on_transfer"
  | "pausable"
  | "blocklisted"
  | "upgradeable_admin";

export interface TokenClassResult {
  flags: TokenClassFlag[];
  warnings: string[];
}

/**
 * Internal registry shape — one entry per (chain, lowercase-address).
 * Lowercase indexing avoids the ERC-55 checksum mismatch that would
 * otherwise fall through to "no match" on case-different inputs.
 */
type RegistryKey = `${SupportedChain}:0x${string}`;
type RegistryEntry = TokenClassResult;

const registry = new Map<RegistryKey, RegistryEntry>();

function key(chain: SupportedChain, address: string): RegistryKey {
  return `${chain}:${address.toLowerCase() as `0x${string}`}` as RegistryKey;
}

function register(
  chain: SupportedChain,
  address: string,
  entry: RegistryEntry,
): void {
  registry.set(key(chain, address), entry);
}

// --- Seed data: rebasing tokens ---------------------------------------

// stETH on Ethereum — Lido's staked-ETH token. balanceOf grows as
// rewards accrue; transfer() converts amount → shares at the current
// index and back at the recipient's index. The two-step rounding
// drops 1-2 wei on the recipient side. For frequent transfers, wrap
// to wstETH first via prepare_lido_wrap (wstETH is non-rebasing —
// balance is in shares, not stETH-equivalent).
register(
  "ethereum",
  CONTRACTS.ethereum.lido.stETH,
  {
    flags: ["rebasing"],
    warnings: [
      "stETH is rebasing — the recipient may receive 1-2 wei less than the " +
        "requested amount due to share-rounding drift. For frequent transfers " +
        "wrap to wstETH first via `prepare_lido_wrap` (wstETH balance is in " +
        "shares, not rebased), or use a DEX swap if the recipient prefers " +
        "wstETH.",
    ],
  },
);

// AMPL on Ethereum — Ampleforth, the original elastic-supply rebasing
// token. Whole-balance rebases happen daily based on price; transfer()
// at any moment is correct, but a tx that sits in the mempool across a
// rebase boundary lands a different fraction of the user's holdings
// than they intended.
register("ethereum", "0xD46bA6D942050d489DBd938a2C909A5d5039A161", {
  flags: ["rebasing"],
  warnings: [
    "AMPL is an elastic-supply rebasing token — daily supply rebases mean " +
      "a transfer that sits in the mempool across the rebase boundary " +
      "(20:00 UTC) lands a different fraction of your holdings than you " +
      "intended. Send during stable periods, or convert to a non-rebasing " +
      "wrapper if your destination supports one.",
  ],
});

// --- Lookup ----------------------------------------------------------

/**
 * Look up the token in the curated registry. Returns null when the
 * token is not classified — caller should treat as "standard ERC-20"
 * and not surface a tokenClass field on the receipt at all (vs.
 * surfacing `flags: ["standard"]`, which would add visual noise to
 * every plain transfer).
 */
export function lookupTokenClass(
  chain: SupportedChain,
  address: string,
): TokenClassResult | null {
  return registry.get(key(chain, address)) ?? null;
}

/**
 * Test-only helper for asserting registry coverage shape (e.g. "every
 * registered entry has at least one warning matching its flags"). NOT
 * part of the public API — exported under an underscore prefix to
 * make the test-only intent obvious to readers.
 */
export function _registrySnapshotForTests(): ReadonlyMap<
  RegistryKey,
  RegistryEntry
> {
  return registry;
}
