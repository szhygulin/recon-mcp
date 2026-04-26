import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Host-side BIP-32 child derivation for Litecoin pairing scans.
 *
 * Mirror of `btc-bip32-derive.ts` — same gap-limit-scan optimization
 * (one device round-trip per (purpose, account) instead of one per
 * leaf). Differences:
 *   - bitcoinjs-lib doesn't ship a Litecoin network preset, so we
 *     construct one inline (mainnet).
 *   - BIP-32 xpub version bytes stay 0x0488B21E (Litecoin Core
 *     convention; not Ltub).
 *
 * Same privacy posture as BTC: account-level xpubs are NOT persisted
 * by this module's caller. If a future change adds an xpub field to
 * `PairedLitecoinEntry`, the same address-linkability trade-off
 * applies — see the BTC equivalent for the full discussion.
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
  initEccLib(ecc: unknown): void;
};

// Same one-time global ECC registration as the BTC module — bitcoinjs-lib
// stores the registered library in a module-global, so registering twice
// is idempotent. Both modules call this at import time.
const ecc = requireCjs("@bitcoinerlab/secp256k1");
bitcoinjs.initEccLib(ecc);

/**
 * Litecoin mainnet network params. Same shape as
 * `bitcoinjs.networks.bitcoin` but with LTC-specific version bytes
 * and bech32 HRP.
 */
const LITECOIN_NETWORK = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x30, // L-prefix
  scriptHash: 0x32, // M-prefix (modern P2SH)
  wif: 0xb0,
};

/** BIP-32 mainnet xpub version bytes (`0488B21E` → "xpub..."). */
const MAINNET_XPUB_VERSION = Uint8Array.of(0x04, 0x88, 0xb2, 0x1e);

const b58check = base58check(sha256);

/**
 * Compress an uncompressed secp256k1 public key. Verbatim shared
 * primitive — pubkey compression is chain-agnostic.
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
 * mainnet xpub string. Litecoin Core uses the same `0488B21E` version
 * bytes as Bitcoin (no Ltub remap), so the encoding here is identical
 * to the BTC module's. Done as a separate function for symmetry.
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
 * Encode a child compressed pubkey into a Litecoin mainnet address per
 * the BIP-44 / 49 / 84 / 86 address format conventions. Uses the
 * inline LITECOIN_NETWORK params so bitcoinjs-lib emits L/M/ltc1q/ltc1p
 * forms.
 *
 * Taproot caveat: Litecoin Core has not activated Taproot on mainnet
 * as of this writing. Addresses derive correctly here, the Ledger
 * Litecoin app emits them, but outputs paying ltc1p... are not
 * spendable until activation. This module emits the addresses anyway
 * so the user-facing pairing flow shows all four address types
 * uniformly with BTC.
 */
export function encodeAddressForFormat(
  compressedPubkey: Uint8Array,
  format: AccountAddressFormat,
): string {
  const network = LITECOIN_NETWORK;
  const pubkey = Buffer.from(compressedPubkey);
  switch (format) {
    case "legacy": {
      const out = bitcoinjs.payments.p2pkh({ pubkey, network }).address;
      if (!out) throw new Error("p2pkh: no address derived");
      return out;
    }
    case "p2sh": {
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

export interface AccountNode {
  hd: HDKey;
  addressFormat: AccountAddressFormat;
}

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
