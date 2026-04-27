/**
 * Compress a SEC1 public key to its 33-byte form. Ledger's
 * `getWalletPublicKey` returns the uncompressed encoding (`0x04 || X
 * || Y`, 65 bytes), but PSBT consumers downstream of
 * `signPsbtBuffer.knownAddressDerivations` expect the compressed
 * encoding (`0x02 || X` if Y is even, `0x03 || X` if odd, 33 bytes) —
 * the SDK then strips the prefix byte for taproot's x-only key. Issue
 * #211: a 65-byte buffer threaded straight through threw "Invalid
 * pubkey length: 65" before any device prompt. Idempotent on inputs
 * already in compressed form.
 */
export function compressPubkey(pubkey: Buffer): Buffer {
  if (
    pubkey.length === 33 &&
    (pubkey[0] === 0x02 || pubkey[0] === 0x03)
  ) {
    return pubkey;
  }
  if (pubkey.length !== 65 || pubkey[0] !== 0x04) {
    throw new Error(
      `Unexpected SEC1 pubkey shape (length=${pubkey.length}, ` +
        `prefix=0x${pubkey[0]?.toString(16) ?? "??"}). Expected 65-byte ` +
        `uncompressed (0x04 || X || Y) or 33-byte compressed (0x02/0x03 || X).`,
    );
  }
  const x = pubkey.subarray(1, 33);
  const yLast = pubkey[64];
  const prefix = (yLast & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}
