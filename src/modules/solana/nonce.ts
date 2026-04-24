/**
 * Solana durable-nonce helpers.
 *
 * A durable nonce is a per-wallet on-chain account that stores a 32-byte
 * nonce value in place of a regular `recentBlockhash`. Transactions whose
 * first instruction is `SystemProgram.nonceAdvance(noncePubkey, authority)`
 * and whose `recentBlockhash` field carries the current nonce value stay
 * valid indefinitely — until the nonce is advanced (which happens when
 * THIS tx lands, or any other nonce-advancing tx against the same account
 * lands, or the authority manually advances it).
 *
 * We use this to eliminate the ~90s `recentBlockhash` expiry window that
 * was biting on Ledger blind-sign SPL transfers: the user can spend as long
 * as they want auditing the inline verifier and reading the Message Hash
 * on-device, and the tx stays valid the whole time.
 *
 * Validity requirements for Agave (confirmed in source — memory note
 * `project_solana_durable_nonce_viability.md`):
 *   - `ix[0]` MUST be `SystemProgram.nonceAdvance`. That's the signal Agave
 *     uses to detect "this is a durable-nonce tx; skip the blockhash
 *     validity window check and instead validate the nonce value against
 *     the nonce account's on-chain state".
 *   - `recentBlockhash` field holds the current nonce value (NOT a real
 *     network blockhash). On broadcast, Agave replays `nonceAdvance` which
 *     rotates the nonce value, so each tx is single-use.
 *   - Everything else composes normally: ComputeBudget, SPL ix, CreateATA,
 *     SystemProgram.transfer all stack after ix[0]. Multi-sig, v0+ALT also
 *     work, provided the nonce account key stays static in the account
 *     list.
 *
 * The nonce account itself:
 *   - Is a per-wallet PDA derived deterministically via
 *     `PublicKey.createWithSeed(userPubkey, NONCE_SEED, SystemProgram.programId)`.
 *     Versioned seed lets future migration rotate without changing callers.
 *   - Holds ~0.00144 SOL rent-exempt minimum + tiny tx-fee buffer.
 *   - Authority = the user's paired Ledger wallet. One signature covers
 *     both `nonceAdvance` and the payload ix(s), so on-device signing UX
 *     stays identical.
 *   - Fully recoverable: `buildCloseNonceIxs` drains the balance back to
 *     the user's main wallet, implicitly closing the account.
 */
import {
  PublicKey,
  SystemProgram,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * Versioned seed string used to derive the nonce-account PDA. Versioning is
 * cheap insurance: if we ever need to change the nonce layout or rekey, a
 * new seed `vaultpilot-nonce-v2` gives us a clean on-chain account without
 * touching the old one.
 */
export const NONCE_SEED = "vaultpilot-nonce-v1";

/**
 * Derive the deterministic nonce-account address for a user's base wallet.
 * Same seed + same base pubkey → same nonce pubkey, always. No persistent
 * server state needed: the pubkey is fully rederivable from the sending
 * address, and existence is checked via `getAccountInfo` at prepare time.
 */
export async function deriveNonceAccountAddress(
  userPubkey: PublicKey,
): Promise<PublicKey> {
  return PublicKey.createWithSeed(
    userPubkey,
    NONCE_SEED,
    SystemProgram.programId,
  );
}

/**
 * Fetch the current state of a nonce account. Returns null if the account
 * doesn't exist (uninitialized user). Otherwise parses the on-chain data
 * into `{ nonce, authority }`:
 *
 *   - `nonce`: the 32-byte value (base58) that goes into the tx's
 *     `recentBlockhash` field and gets rotated when `nonceAdvance` runs.
 *   - `authority`: the pubkey that must sign `nonceAdvance`. For our
 *     scheme this is always the same as the sending wallet, so the agent
 *     can sanity-check that authority === tx.from before presenting the
 *     decoded checks to the user.
 */
export async function getNonceAccountValue(
  conn: Connection,
  noncePubkey: PublicKey,
): Promise<{ nonce: string; authority: PublicKey } | null> {
  const info = await conn.getAccountInfo(noncePubkey, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(SystemProgram.programId)) {
    throw new Error(
      `Account ${noncePubkey.toBase58()} exists but is owned by ${info.owner.toBase58()}, ` +
        `not SystemProgram. Refusing to treat it as a nonce account.`,
    );
  }
  const nonceAccount = NonceAccount.fromAccountData(info.data);
  return {
    nonce: nonceAccount.nonce,
    authority: nonceAccount.authorizedPubkey,
  };
}

/**
 * Build the `SystemProgram.nonceAdvance` instruction that MUST be `ix[0]`
 * of every send tx using this nonce. Agave's nonce-tx detection looks
 * exclusively at `ix[0]` — if this isn't there, the tx is rejected as
 * having a stale blockhash.
 *
 * Accounts: `[nonce_account, SYSVAR_RECENT_BLOCKHASHES, authority]`.
 * Instruction data: 4-byte u32 LE tag `0x04 0x00 0x00 0x00` (SystemInstruction
 * discriminator for AdvanceNonceAccount). The agent's INSTRUCTION DECODE
 * check verifies this shape.
 */
export function buildAdvanceNonceIx(
  noncePubkey: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  return SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey: authority,
  });
}

/**
 * Build the two instructions that together create + initialize a nonce
 * account for the user:
 *
 *   ix[0] = SystemProgram.createAccountWithSeed — creates the PDA at the
 *           derived address, funds it with `rentLamports` (the rent-exempt
 *           minimum for NONCE_ACCOUNT_LENGTH bytes), assigns it to
 *           SystemProgram. `basePubkey === userPubkey === fromPubkey`
 *           means the tx signed by the user creates the account at the
 *           deterministic PDA without needing a separate keypair signer.
 *
 *   ix[1] = SystemProgram.nonceInitialize — writes the initial nonce value
 *           and sets the authority. Must run in the SAME tx as the create
 *           (a created-but-uninitialized nonce account is an invalid state).
 *
 * This tx itself runs in legacy recent-blockhash mode (no nonce to use
 * yet — we're creating it). First send, and only send, without durable
 * protection.
 */
export function buildInitNonceIxs(
  userPubkey: PublicKey,
  noncePubkey: PublicKey,
  rentLamports: number,
): TransactionInstruction[] {
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: userPubkey,
      newAccountPubkey: noncePubkey,
      basePubkey: userPubkey,
      seed: NONCE_SEED,
      lamports: rentLamports,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey,
      authorizedPubkey: userPubkey,
    }),
  ];
}

/**
 * Build the two instructions that close the nonce account, returning the
 * full balance to the user's main wallet:
 *
 *   ix[0] = SystemProgram.nonceAdvance — same self-protecting pattern as
 *           any other send using this nonce. The close tx itself is
 *           durable-nonce-protected, so the user can take as long as they
 *           want to review + sign it.
 *
 *   ix[1] = SystemProgram.nonceWithdraw — transfers the FULL balance
 *           (rent-exempt minimum + whatever was over-deposited) to the
 *           destination. After this, the nonce account has zero balance
 *           and is garbage-collected by the validator at the next rent
 *           sweep.
 *
 * `balanceLamports` should be the exact on-chain balance fetched at
 * prepare time. Using anything else leaves lamports stranded or causes
 * the withdraw to fail.
 */
export function buildCloseNonceIxs(
  noncePubkey: PublicKey,
  authority: PublicKey,
  destination: PublicKey,
  balanceLamports: number,
): TransactionInstruction[] {
  return [
    buildAdvanceNonceIx(noncePubkey, authority),
    SystemProgram.nonceWithdraw({
      noncePubkey,
      authorizedPubkey: authority,
      toPubkey: destination,
      lamports: balanceLamports,
    }),
  ];
}

/**
 * Re-export of the web3.js constant so callers don't have to import it
 * directly — keeps `src/modules/solana/actions.ts` dependency-flat on
 * the nonce module.
 */
export { NONCE_ACCOUNT_LENGTH };
