import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Host-side BIP-32 child derivation for Bitcoin pairing scans.
 *
 * Background: BIP-32 is deterministic. From a NON-HARDENED parent node
 * (public key + chain code), every non-hardened descendant's public key
 * + address is computable purely with the parent's public material — no
 * private key, no device, no network. The standard wallet path is
 * `m / purpose' / coin_type' / account' / change / address_index`
 * where the first three segments are HARDENED (need the device's
 * private key) and the last two are NOT (host-derivable from the
 * account-level xpub).
 *
 * So once we ask the Ledger for the account-level (publicKey, chainCode)
 * pair ONCE per (purpose, account), we can synthesize every receive
 * (`/0/i`) and change (`/1/i`) leaf for that account locally. That
 * collapses the gap-limit scan from ~160 USB roundtrips per accountIndex
 * (4 types × 2 chains × gapLimit=20) down to 4 — the four account-level
 * calls, one per BIP-44 purpose. Issue #192.
 *
 * --- Privacy / security note (cache description) ---
 *
 * If we ever PERSIST account-level xpubs to disk (e.g. to make rescan
 * extend-past-the-gap-window device-less per #191's `needsExtend`
 * flag — see issue #192 optimization #3), the privacy posture is the
 * same as Sparrow / Specter / Electrum desktop wallets:
 *
 *   - SAFE for funds: an xpub never exposes a private key. There is
 *     no path from a stored xpub to spending the user's BTC.
 *   - LEAKS address enumeration: anyone with the xpub can compute
 *     every address the wallet will ever derive at that account, and
 *     thus correlate the user's full on-chain history under that
 *     account. The on-chain footprint is already public if those
 *     addresses are used; the leak is the *linkage* — the ability to
 *     bind one address to "all the others come from the same wallet".
 *
 * Today we do NOT persist xpubs (this module's caller passes them in-
 * memory only during a `pair_ledger_btc` scan). If a future change
 * adds an xpub field to `PairedBitcoinEntry` / `UserConfig.pairings.
 * bitcoin`, the docstring on that field MUST repeat this trade-off so
 * a future reader doesn't accidentally weaken the linkability posture.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  payments: {
    p2pkh(opts: { pubkey: Uint8Array; network: unknown }): { address?: string };
    p2sh(opts: { redeem: { output: Uint8Array }; network: unknown }): {
      address?: string;
    };
    p2wpkh(opts: { pubkey: Uint8Array; network: unknown }): {
      address?: string;
      output: Uint8Array;
    };
    p2tr(opts: { internalPubkey: Uint8Array; network: unknown }): {
      address?: string;
    };
  };
  networks: { bitcoin: unknown };
  initEccLib(ecc: unknown): void;
};

// bitcoinjs-lib's `payments.p2tr` (taproot) calls into an injected ECC
// library to compute the BIP-341 internal-key tweak. `initEccLib` is a
// one-time global registration; we use `@bitcoinerlab/secp256k1` (pure
// JS shim over `@noble/curves`) to avoid the native build dependency
// `tiny-secp256k1` would otherwise drag in. Legacy / P2SH / P2WPKH
// derivations don't need ECC, but we register unconditionally so the
// taproot path works the moment a user pairs taproot.
const ecc = requireCjs("@bitcoinerlab/secp256k1");
bitcoinjs.initEccLib(ecc);

/** BIP-32 mainnet xpub version bytes (`0488B21E` → "xpub..."). */
const MAINNET_XPUB_VERSION = Uint8Array.of(0x04, 0x88, 0xb2, 0x1e);

const b58check = base58check(sha256);

/**
 * Compress an uncompressed secp256k1 public key. The Ledger BTC app's
 * `getWalletPublicKey` returns the uncompressed form (65 bytes:
 * `0x04 || x32 || y32`); BIP-32 child derivation needs the compressed
 * form (33 bytes: `0x02|0x03 || x32`) where the leading byte encodes
 * the y-coordinate parity (`0x02` for even, `0x03` for odd).
 */
export function compressSecp256k1Pubkey(uncompressedHex: string): Uint8Array {
  const hex = uncompressedHex.startsWith("0x")
    ? uncompressedHex.slice(2)
    : uncompressedHex;
  if (hex.length !== 130) {
    throw new Error(
      `Expected an uncompressed secp256k1 public key (130 hex chars), got ${hex.length}.`,
    );
  }
  const buf = Buffer.from(hex, "hex");
  if (buf[0] !== 0x04) {
    throw new Error(
      `Expected uncompressed-pubkey prefix 0x04, got 0x${buf[0].toString(16).padStart(2, "0")}.`,
    );
  }
  const x = buf.subarray(1, 33);
  const y = buf.subarray(33, 65);
  const yIsEven = (y[31] & 1) === 0;
  const compressed = new Uint8Array(33);
  compressed[0] = yIsEven ? 0x02 : 0x03;
  compressed.set(x, 1);
  return compressed;
}

/**
 * Encode a (publicKey, chainCode) pair into a base58check-encoded BIP-32
 * mainnet xpub string. Used so we can hand a parent node to
 * `@scure/bip32`'s `HDKey.fromExtendedKey` — the library's preferred
 * factory. Other fields (depth, parent fingerprint, child number) are
 * zeroed because we never reconstruct an absolute BIP-32 tree position
 * here; we only need the relative-derivation primitives below the
 * given node.
 */
export function encodeXpub(
  publicKeyCompressed: Uint8Array,
  chainCode: Uint8Array,
): string {
  if (publicKeyCompressed.length !== 33) {
    throw new Error(
      `Compressed public key must be 33 bytes, got ${publicKeyCompressed.length}.`,
    );
  }
  if (chainCode.length !== 32) {
    throw new Error(`Chain code must be 32 bytes, got ${chainCode.length}.`);
  }
  // 4 + 1 + 4 + 4 + 32 + 33 = 78 bytes serialized; base58check appends
  // the 4-byte sha256d checksum.
  const buf = new Uint8Array(78);
  buf.set(MAINNET_XPUB_VERSION, 0);
  buf[4] = 0; // depth
  buf.set([0, 0, 0, 0], 5); // parent fingerprint
  buf.set([0, 0, 0, 0], 9); // child number
  buf.set(chainCode, 13);
  buf.set(publicKeyCompressed, 45);
  return b58check.encode(buf);
}

export type AccountAddressFormat = "legacy" | "p2sh" | "bech32" | "bech32m";

/**
 * Encode a child compressed pubkey into a Bitcoin mainnet address per
 * the BIP-44 / 49 / 84 / 86 address format conventions. Centralized so
 * the scanner doesn't have to know each payment shape's quirks.
 *
 * P2TR uses the x-only form (32-byte X coordinate) per BIP-340; the
 * other three formats use the full 33-byte compressed pubkey.
 */
export function encodeAddressForFormat(
  compressedPubkey: Uint8Array,
  format: AccountAddressFormat,
): string {
  const network = bitcoinjs.networks.bitcoin;
  const pubkey = Buffer.from(compressedPubkey);
  switch (format) {
    case "legacy": {
      const out = bitcoinjs.payments.p2pkh({ pubkey, network }).address;
      if (!out) throw new Error("p2pkh: no address derived");
      return out;
    }
    case "p2sh": {
      // P2SH-wrapped segwit: redeem script is P2WPKH.
      const inner = bitcoinjs.payments.p2wpkh({ pubkey, network });
      const out = bitcoinjs.payments.p2sh({
        redeem: { output: inner.output },
        network,
      }).address;
      if (!out) throw new Error("p2sh-segwit: no address derived");
      return out;
    }
    case "bech32": {
      const out = bitcoinjs.payments.p2wpkh({ pubkey, network }).address;
      if (!out) throw new Error("p2wpkh: no address derived");
      return out;
    }
    case "bech32m": {
      // Taproot key-path: x-only internal pubkey (drop the parity byte).
      const xOnly = pubkey.subarray(1);
      const out = bitcoinjs.payments.p2tr({
        internalPubkey: xOnly,
        network,
      }).address;
      if (!out) throw new Error("p2tr: no address derived");
      return out;
    }
  }
}

/**
 * Container for an account-level node. Built once per (accountIndex,
 * addressType) from the Ledger's response; reused for every host-side
 * child derivation under it.
 */
export interface AccountNode {
  /** `@scure/bip32` HDKey at the account-level path. */
  hd: HDKey;
  /** Address format used to encode every child (matches the BIP-44 purpose). */
  addressFormat: AccountAddressFormat;
}

/**
 * Build an `AccountNode` from the Ledger's account-level xpub material.
 * The Ledger's `getWalletPublicKey(accountPath, ...)` returns:
 *
 *   - `publicKey`: uncompressed (130 hex chars, `04 || x || y`)
 *   - `chainCode`: 64 hex chars (32 bytes)
 *   - `bitcoinAddress`: irrelevant at the account level, ignored
 *
 * We compress the pubkey, pack it into an xpub, and let `@scure/bip32`
 * parse it back into an HDKey for child derivation.
 */
export function accountNodeFromLedgerResponse(args: {
  publicKeyHex: string;
  chainCodeHex: string;
  addressFormat: AccountAddressFormat;
}): AccountNode {
  const compressed = compressSecp256k1Pubkey(args.publicKeyHex);
  const chainCodeHex = args.chainCodeHex.startsWith("0x")
    ? args.chainCodeHex.slice(2)
    : args.chainCodeHex;
  if (chainCodeHex.length !== 64) {
    throw new Error(
      `Chain code must be 32 bytes (64 hex chars), got ${chainCodeHex.length}.`,
    );
  }
  const xpub = encodeXpub(compressed, Buffer.from(chainCodeHex, "hex"));
  const hd = HDKey.fromExtendedKey(xpub);
  return { hd, addressFormat: args.addressFormat };
}

/**
 * Derive the leaf address at `m/<chain>/<addressIndex>` under an
 * account-level node, host-side. No device, no network. Same code path
 * regardless of how deep we walk the gap-limit window.
 */
export function deriveAccountChildAddress(
  node: AccountNode,
  chain: 0 | 1,
  addressIndex: number,
): { address: string; publicKey: Uint8Array } {
  const child = node.hd.derive(`m/${chain}/${addressIndex}`);
  if (!child.publicKey) {
    throw new Error(
      `BIP-32 child at m/${chain}/${addressIndex} produced no public key.`,
    );
  }
  return {
    address: encodeAddressForFormat(child.publicKey, node.addressFormat),
    publicKey: child.publicKey,
  };
}
