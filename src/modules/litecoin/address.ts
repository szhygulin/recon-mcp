/**
 * Litecoin mainnet address validation. Local format checks (regex +
 * base58/bech32 charset constraints) — does NOT verify on-chain
 * existence or checksum-validate the address.
 *
 * Litecoin address types and version bytes:
 *   - P2PKH: version `0x30` → addresses start with `L` (capital L).
 *   - P2SH-modern: version `0x32` → addresses start with `M`. The
 *     Litecoin community migrated from version `0x05` (3-prefix, same
 *     as BTC P2SH) to `0x32` for disambiguation, but a long tail of
 *     wallets / exchanges still emit/accept the legacy `0x05` (3-prefix)
 *     form. We accept BOTH.
 *   - Native segwit (P2WPKH/P2WSH): bech32 with HRP `ltc` →
 *     addresses start with `ltc1q…`.
 *   - Taproot (P2TR): bech32m with HRP `ltc` → `ltc1p…`. Note:
 *     Litecoin Core has NOT activated Taproot on mainnet as of 2026.
 *     The address format is still well-defined and the Ledger LTC
 *     app derives the correct keys; outputs to `ltc1p…` won't be
 *     spendable until mainnet activation.
 *
 * MWEB (Mimblewimble Extension Block) addresses (`ltcmweb1…`) are NOT
 * supported here — the Ledger Litecoin app cannot sign for MWEB
 * outputs. Sends to MWEB addresses must go through Litecoin Core
 * directly.
 *
 * Testnet/regtest addresses (`tltc1…`, `mltc1…`) are refused — this
 * server is mainnet-only.
 */

/**
 * Discriminated union of mainnet address types we recognize.
 */
export type LitecoinAddressType =
  | "p2pkh" // Legacy `L...`
  | "p2sh" // P2SH-wrapped — `M...` (modern, version 0x32) OR `3...` (legacy, version 0x05)
  | "p2wpkh" // Native segwit, 20-byte program (`ltc1q…`, 43 chars)
  | "p2wsh" // Native segwit, 32-byte program (`ltc1q…`, 63 chars — typically multisig)
  | "p2tr"; // Taproot `ltc1p…` (not yet activated on mainnet)

// Legacy P2PKH: starts with `L`, 26-34 chars, base58 charset.
const P2PKH_RE = /^L[1-9A-HJ-NP-Za-km-z]{25,33}$/;
// P2SH modern (version 0x32): starts with `M`, 26-34 chars, base58.
const P2SH_M_RE = /^M[1-9A-HJ-NP-Za-km-z]{25,33}$/;
// P2SH legacy (version 0x05, BTC-shape, still emitted by some exchanges
// and older Litecoin wallets): starts with `3`, 26-34 chars, base58.
const P2SH_3_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,33}$/;
// Bech32 native segwit (witness version 0). Same BIP-141 length
// disambiguation as BTC, with HRP `ltc` instead of `bc`:
//   - 20-byte program → P2WPKH (`ltc1q…`, 43 chars total = `ltc1q` + 38)
//   - 32-byte program → P2WSH  (`ltc1q…`, 63 chars total = `ltc1q` + 58)
const BECH32_P2WPKH_RE = /^ltc1q[02-9ac-hj-np-z]{38}$/;
const BECH32_P2WSH_RE = /^ltc1q[02-9ac-hj-np-z]{58}$/;
// Bech32m taproot (witness version 1). v1 SegWit is always a 32-byte
// program → exactly 63 chars total.
const BECH32_TAPROOT_RE = /^ltc1p[02-9ac-hj-np-z]{58}$/;

export function detectLitecoinAddressType(addr: string): LitecoinAddressType | null {
  if (P2PKH_RE.test(addr)) return "p2pkh";
  if (P2SH_M_RE.test(addr)) return "p2sh";
  if (P2SH_3_RE.test(addr)) return "p2sh";
  if (BECH32_P2WPKH_RE.test(addr)) return "p2wpkh";
  if (BECH32_P2WSH_RE.test(addr)) return "p2wsh";
  if (BECH32_TAPROOT_RE.test(addr)) return "p2tr";
  return null;
}

export function isLitecoinAddress(addr: string): boolean {
  return detectLitecoinAddressType(addr) !== null;
}

export function assertLitecoinAddress(addr: string): LitecoinAddressType {
  const type = detectLitecoinAddressType(addr);
  if (!type) {
    throw new Error(
      `"${addr}" is not a valid Litecoin mainnet address. Expected one of: ` +
        `legacy (L...), P2SH (M.../3...), native segwit (ltc1q...), or taproot (ltc1p...). ` +
        `Testnet (tltc1...) and MWEB (ltcmweb1...) addresses are not supported.`,
    );
  }
  return type;
}
