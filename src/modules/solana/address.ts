import { PublicKey } from "@solana/web3.js";
import { isSolanaAddress } from "../../config/solana.js";

export { isSolanaAddress };

/**
 * Strict validator — confirms `s` round-trips through `@solana/web3.js`
 * `PublicKey`, which enforces base58 decoding and the 32-byte length.
 * Shape checks like `isSolanaAddress` accept base58-looking garbage; this
 * call fails loudly on anything the runtime wouldn't accept as a pubkey.
 *
 * We deliberately do NOT call `PublicKey.isOnCurve()`. Wallets are required
 * to be on-curve (derived from a keypair), but many things we read (ATAs,
 * PDAs for stake pool withdraw authorities, etc.) are off-curve. Restricting
 * *input* addresses to on-curve only would over-reject for some legitimate
 * power-user cases (e.g., reading balances of a multisig authority).
 */
export function assertSolanaAddress(s: string): PublicKey {
  if (!isSolanaAddress(s)) {
    throw new Error(
      `"${s}" is not a valid Solana mainnet address (expected base58, 43 or 44 chars).`,
    );
  }
  try {
    return new PublicKey(s);
  } catch (e) {
    throw new Error(
      `"${s}" passed the shape check but isn't a 32-byte base58 pubkey: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
