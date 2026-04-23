import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * Standard rent-exempt balance for an SPL Token account (165 bytes of data
 * at current rent rates). Matches what Phantom / Solflare disclose for ATA
 * creation. Hardcoded because it's a protocol constant — changing it would
 * require a Solana runtime update. As of 2026-04, 165 bytes rent-exempt =
 * 2,039,280 lamports ≈ 0.00204 SOL.
 */
export const SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

export interface AtaResolution {
  /** The derived ATA address for `(owner, mint)`. Base58. */
  ataAddress: PublicKey;
  /** True iff the ATA already holds lamports on chain. False → tx must create it. */
  exists: boolean;
  /**
   * True when the caller should prepend a `createAssociatedTokenAccountInstruction`
   * to the tx. Equal to `!exists`.
   */
  needsCreation: boolean;
}

/**
 * Derive the Associated Token Account address for `(owner, mint)` and check
 * whether it exists on chain. The derivation is deterministic (PDA from
 * fixed seeds), so a null `getAccountInfo` result is unambiguous — it means
 * nobody has ever created the ATA, so a transfer to this owner + mint pair
 * MUST include an `createAssociatedTokenAccount` instruction (and the
 * sender pays ~0.00204 SOL rent to fund the 165-byte account).
 *
 * Default Token program (not Token-2022) — the vast majority of mints
 * (USDC, USDT, JUP, BONK, JTO, mSOL, jitoSOL) are plain SPL Token. If we
 * ever need to support Token-2022 mints, the builder will need to detect
 * the mint's owning program and use the matching ATA derivation.
 */
export async function resolveRecipientAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<AtaResolution> {
  const ataAddress = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ataAddress, "confirmed");
  const exists = info !== null;
  return { ataAddress, exists, needsCreation: !exists };
}
