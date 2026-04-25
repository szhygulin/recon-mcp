/**
 * Bitcoin mainnet address validation. Local format checks (regex + base58/
 * bech32 charset constraints) — does NOT verify on-chain existence or
 * checksum-validate the address (a fully-correct base58check or bech32m
 * checksum verifier would pull `bitcoinjs-lib` into the read-only PR1
 * surface, which we don't need yet).
 *
 * What we DO catch:
 *   - Wrong network (testnet `tb1…`, signet `sb1…`, regtest `bcrt1…`) →
 *     refused since this server is mainnet-only in Phase 1.
 *   - Wrong character set (e.g. `0`, `O`, `I`, `l` in base58 — those are
 *     ambiguous and not used).
 *   - Wrong length (legacy/P2SH must be 26-35 chars; bech32 is 42-62).
 *
 * What we DON'T catch (deferred to bitcoinjs-lib in PR3 when we build
 * PSBTs):
 *   - Bad base58check checksum (typo flips the address — would still
 *     parse here but would fail at PSBT-build time).
 *   - Bad bech32m checksum (taproot addresses).
 *
 * For PR1 this is good enough: an indexer query against a typo'd address
 * just returns an empty balance, which is recoverable. PSBT signing has
 * stricter validation when it matters.
 */

/**
 * Discriminated union of mainnet address types we recognize. `unknown`
 * never returns from the validator — the validator throws — but the
 * type is useful for downstream switches.
 */
export type BitcoinAddressType =
  | "p2pkh" // Legacy `1...`
  | "p2sh" // P2SH-wrapped `3...`
  | "p2wpkh" // Native segwit, 20-byte program (`bc1q…`, 42 chars)
  | "p2wsh" // Native segwit, 32-byte program (`bc1q…`, 62 chars — typically multisig)
  | "p2tr"; // Taproot `bc1p…`

// Legacy P2PKH: starts with `1`, 26-34 chars, base58 charset.
const P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,33}$/;
// P2SH (incl. P2SH-wrapped segwit): starts with `3`, 26-34 chars, base58.
const P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,33}$/;
// Bech32 native segwit (witness version 0). BIP-141 disambiguates
// solely by witness-program length:
//   - 20-byte program → P2WPKH (`bc1q…`, 42 chars total = `bc1q` + 38)
//   - 32-byte program → P2WSH  (`bc1q…`, 62 chars total = `bc1q` + 58)
// Other lengths are invalid v0 scripts. Splitting these into two
// regexes both gives the correct addressType label AND rejects the
// previously-accepted impossible lengths in (38..58) (issue #182).
const BECH32_P2WPKH_RE = /^bc1q[02-9ac-hj-np-z]{38}$/;
const BECH32_P2WSH_RE = /^bc1q[02-9ac-hj-np-z]{58}$/;
// Bech32m taproot (witness version 1). v1 SegWit is always a 32-byte
// program → exactly 62 chars total. Tightened from the prior `{38,58}`
// loose range that accepted impossible lengths (issue #182).
const BECH32_TAPROOT_RE = /^bc1p[02-9ac-hj-np-z]{58}$/;

export function detectBitcoinAddressType(addr: string): BitcoinAddressType | null {
  if (P2PKH_RE.test(addr)) return "p2pkh";
  if (P2SH_RE.test(addr)) return "p2sh";
  if (BECH32_P2WPKH_RE.test(addr)) return "p2wpkh";
  if (BECH32_P2WSH_RE.test(addr)) return "p2wsh";
  if (BECH32_TAPROOT_RE.test(addr)) return "p2tr";
  return null;
}

export function isBitcoinAddress(addr: string): boolean {
  return detectBitcoinAddressType(addr) !== null;
}

export function assertBitcoinAddress(addr: string): BitcoinAddressType {
  const type = detectBitcoinAddressType(addr);
  if (!type) {
    throw new Error(
      `"${addr}" is not a valid Bitcoin mainnet address. Expected one of: ` +
        `legacy (1...), P2SH (3...), native segwit (bc1q...), or taproot (bc1p...). ` +
        `Testnet/signet addresses (tb1.../sb1...) are not supported in Phase 1.`,
    );
  }
  return type;
}
