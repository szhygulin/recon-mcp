import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { createHash } from "node:crypto";
import {
  accountNodeFromLedgerResponse,
  compressSecp256k1Pubkey,
  deriveAccountChildAddress,
  encodeAddressForFormat,
  encodeXpub,
} from "../src/signing/btc-bip32-derive.js";

/**
 * Unit tests for the host-side BIP-32 derivation primitives that back
 * `pair_ledger_btc`'s gap-limit scanner (issue #192). The full scan
 * is exercised end-to-end in `btc-pair.test.ts`; here we pin the
 * lower-level pieces — pubkey compression, xpub encoding, address
 * encoding per BIP-44 purpose, child derivation determinism — so a
 * regression in any one of them surfaces independently.
 *
 * The "derived address matches reference" tests use a single
 * deterministic seed (sha256 of a stable label) for repro. Real
 * BIP-84/BIP-86 spec vectors are NOT used here — the goal is
 * self-consistency of our encoder against `@scure/bip32`'s reference
 * derivation, not validation against external test vectors. (Those
 * would belong in a Bitcoin-spec conformance suite, which we don't
 * maintain.)
 */

const TEST_SEED = createHash("sha256")
  .update("vaultpilot-btc-bip32-derive-test-seed")
  .digest();
const TEST_ROOT = HDKey.fromMasterSeed(TEST_SEED);

function uncompressedPubkeyHexAt(path: string): {
  pubkeyHex: string;
  chainCodeHex: string;
} {
  const node = TEST_ROOT.derive(path);
  if (!node.publicKey || !node.chainCode) {
    throw new Error(`derivation produced no pubkey/chainCode at ${path}`);
  }
  const point = secp256k1.ProjectivePoint.fromHex(
    Buffer.from(node.publicKey).toString("hex"),
  );
  return {
    pubkeyHex: Buffer.from(point.toRawBytes(false)).toString("hex"),
    chainCodeHex: Buffer.from(node.chainCode).toString("hex"),
  };
}

describe("compressSecp256k1Pubkey", () => {
  it("converts uncompressed (65 bytes, 0x04 prefix) to compressed (33 bytes, 0x02|0x03)", () => {
    // Generator point G in uncompressed form.
    const G = secp256k1.ProjectivePoint.BASE;
    const uncompressed = Buffer.from(G.toRawBytes(false)).toString("hex");
    const compressed = compressSecp256k1Pubkey(uncompressed);
    expect(compressed.length).toBe(33);
    // The y-coordinate of G is even, so the prefix should be 0x02.
    expect(compressed[0]).toBe(0x02);
    // Compare against @noble's own compression for cross-checking.
    const expected = G.toRawBytes(true);
    expect(Buffer.from(compressed).toString("hex")).toBe(
      Buffer.from(expected).toString("hex"),
    );
  });

  it("rejects invalid input shapes", () => {
    expect(() => compressSecp256k1Pubkey("00")).toThrow(/130 hex chars/);
    expect(() =>
      compressSecp256k1Pubkey("03" + "00".repeat(32)),
    ).toThrow(/130 hex chars/);
    // 130 chars but wrong prefix.
    expect(() => compressSecp256k1Pubkey("00".repeat(65))).toThrow(/0x04/);
  });
});

describe("encodeXpub", () => {
  it("produces an xpub-prefixed base58check string", () => {
    const compressed = secp256k1.ProjectivePoint.BASE.toRawBytes(true);
    const chainCode = new Uint8Array(32);
    const xpub = encodeXpub(compressed, chainCode);
    expect(xpub.startsWith("xpub")).toBe(true);
    // Round-trip through @scure/bip32 to confirm the bytes parse.
    const hd = HDKey.fromExtendedKey(xpub);
    expect(hd.publicKey).toEqual(compressed);
    expect(hd.chainCode).toEqual(chainCode);
  });

  it("rejects mis-sized inputs", () => {
    expect(() =>
      encodeXpub(new Uint8Array(32), new Uint8Array(32)),
    ).toThrow(/33 bytes/);
    expect(() =>
      encodeXpub(new Uint8Array(33), new Uint8Array(31)),
    ).toThrow(/32 bytes/);
  });
});

describe("encodeAddressForFormat", () => {
  it("encodes a known compressed pubkey to all four mainnet address formats", () => {
    // Generator point compressed — a deterministic, well-known input.
    const G_compressed = secp256k1.ProjectivePoint.BASE.toRawBytes(true);
    const legacy = encodeAddressForFormat(G_compressed, "legacy");
    const p2sh = encodeAddressForFormat(G_compressed, "p2sh");
    const segwit = encodeAddressForFormat(G_compressed, "bech32");
    const taproot = encodeAddressForFormat(G_compressed, "bech32m");
    // Type-discriminating prefixes tell us each format produced its own
    // shape (no accidental cross-wiring).
    expect(legacy.startsWith("1")).toBe(true);
    expect(p2sh.startsWith("3")).toBe(true);
    expect(segwit.startsWith("bc1q")).toBe(true);
    expect(taproot.startsWith("bc1p")).toBe(true);
    // Different formats from the same pubkey produce different
    // addresses (sanity check).
    const all = [legacy, p2sh, segwit, taproot];
    expect(new Set(all).size).toBe(4);
  });
});

describe("accountNodeFromLedgerResponse + deriveAccountChildAddress", () => {
  it("derives the same child as @scure/bip32 directly", async () => {
    const accountPath = "m/84'/0'/0'";
    const { pubkeyHex, chainCodeHex } = uncompressedPubkeyHexAt(accountPath);

    const node = accountNodeFromLedgerResponse({
      publicKeyHex: pubkeyHex,
      chainCodeHex,
      addressFormat: "bech32",
    });

    // Reference: walk the same path via @scure/bip32 directly, then
    // address-encode. Production should produce the same bytes.
    const referenceNode = TEST_ROOT.derive(accountPath);
    const referenceChild = referenceNode.derive("m/0/0");
    if (!referenceChild.publicKey)
      throw new Error("reference child no pubkey");
    const expectedAddress = encodeAddressForFormat(
      referenceChild.publicKey,
      "bech32",
    );

    const out = deriveAccountChildAddress(node, 0, 0);
    expect(out.address).toBe(expectedAddress);

    // Different leaves under the same account produce different addresses.
    const out01 = deriveAccountChildAddress(node, 0, 1);
    const out10 = deriveAccountChildAddress(node, 1, 0);
    expect(out.address).not.toBe(out01.address);
    expect(out.address).not.toBe(out10.address);
    expect(out01.address).not.toBe(out10.address);
  });

  it("derives correctly across all four BIP-44 purposes", () => {
    const cases = [
      { purpose: 44, format: "legacy" as const, prefix: "1" },
      { purpose: 49, format: "p2sh" as const, prefix: "3" },
      { purpose: 84, format: "bech32" as const, prefix: "bc1q" },
      { purpose: 86, format: "bech32m" as const, prefix: "bc1p" },
    ];
    for (const c of cases) {
      const { pubkeyHex, chainCodeHex } = uncompressedPubkeyHexAt(
        `m/${c.purpose}'/0'/0'`,
      );
      const node = accountNodeFromLedgerResponse({
        publicKeyHex: pubkeyHex,
        chainCodeHex,
        addressFormat: c.format,
      });
      const out = deriveAccountChildAddress(node, 0, 0);
      expect(out.address.startsWith(c.prefix)).toBe(true);
    }
  });

  it("rejects mis-sized chain code in the Ledger response", () => {
    expect(() =>
      accountNodeFromLedgerResponse({
        publicKeyHex: "04" + "00".repeat(64),
        chainCodeHex: "00".repeat(20), // wrong size
        addressFormat: "bech32",
      }),
    ).toThrow(/32 bytes/);
  });
});
