import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * Regression tests for the `pair_ledger_btc` bs58/base-x resolution
 * chain under `@ledgerhq/hw-app-btc`. Two related bugs gated by this:
 *
 *   1. Issue #181 — `base58.decode is not a function`. Root cause:
 *      bs58@6 is ESM-default-export, breaking bs58check@2.1.2's CJS
 *      `require('bs58').decode(...)`. Fix: scoped override pinning
 *      `@ledgerhq/hw-app-btc → bs58: ^5.0.0` (CJS named exports).
 *
 *   2. Sibling regression — `xpubBuf.readUInt32BE is not a function`
 *      inside hw-app-btc's `bip32.js`. Root cause: bs58@5 transitively
 *      resolves `base-x@4`, which returns plain `Uint8Array` instead
 *      of Node `Buffer`; `Uint8Array` has `.subarray` (so chaincode /
 *      pubkey slicing succeeds and masks the issue) but no
 *      `.readUInt32BE`. Fix: extend the scoped override with
 *      `base-x: ^3.0.0` so the BTC subtree picks up base-x@3, which
 *      uses `safe-buffer` Buffer and keeps the Buffer-only methods.
 *
 * Both faults trip BEFORE the Ledger device is ever queried, so users
 * see a synchronous TypeError on `pair_ledger_btc` rather than any
 * pairing prompt. The tests below reach into the hw-app-btc subtree
 * exactly the way its CJS code resolves dependencies at runtime, so
 * if either override is ever dropped (or hw-app-btc upgrades and
 * shifts its transitive shape) we catch it in CI before it ships.
 * bump
 */
describe("@ledgerhq/hw-app-btc bs58/base-x subtree (issue #181 + sibling)", () => {
  // Resolve bs58check the same way hw-app-btc's CJS code does at
  // runtime — anchored at hw-app-btc's package.json so the require
  // walks the BTC subtree, not the top-level node_modules.
  const r = createRequire(import.meta.url);
  const btcRequire = createRequire(r.resolve("@ledgerhq/hw-app-btc/package.json"));
  const bs58check = btcRequire("bs58check") as {
    encode: (b: Uint8Array) => string;
    decode: (s: string) => Buffer;
  };

  it("loads bs58check.decode as a callable function from the BTC subtree", () => {
    expect(typeof bs58check.decode).toBe("function");
    expect(typeof bs58check.encode).toBe("function");

    // Round-trip a known mainnet P2PKH address so we know decode is
    // not just present but functional. Genesis-block address.
    const decoded = bs58check.decode("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    // 1-byte version + 20-byte hash160 = 21 bytes (no checksum — bs58check strips it).
    expect(decoded.length).toBe(21);
  });

  it("returns a Buffer (not bare Uint8Array) so xpub readUInt32BE works", () => {
    // hw-app-btc's `bip32.js#getXpubComponents` calls
    // `bs58check.decode(xpub).readUInt32BE(0)` to read the BIP32
    // version bytes. `readUInt32BE` is a Buffer-only method — base-x@4
    // returns Uint8Array, which would crash here.
    //
    // Use any well-formed xpub. Mainnet BIP32 version = 0x0488B21E.
    const xpub =
      "xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB";
    const decoded = bs58check.decode(xpub);

    // 4-byte version + 1-byte depth + 4-byte parentFP + 4-byte childIdx
    //   + 32-byte chaincode + 33-byte pubkey = 78 bytes.
    expect(decoded.length).toBe(78);

    // The actual fault we're guarding against. If this throws with
    // "readUInt32BE is not a function", base-x@4 has slipped back into
    // the tree — re-pin the override.
    expect(typeof decoded.readUInt32BE).toBe("function");
    expect(decoded.readUInt32BE(0)).toBe(0x0488b21e);
  });
});
