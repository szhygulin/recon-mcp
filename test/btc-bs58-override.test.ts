import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * Regression test for issue #181 ("`base58.decode is not a function`"
 * during `pair_ledger_btc`).
 *
 * The root `package.json` overrides block forces `bs58: ^6.0.0` for
 * every nested dep so the Solana / Anchor side gets the modern shape.
 * `bs58@6` is ESM-default-export; loading it from a CJS consumer
 * yields `{ default: { decode, encode, ... } }`, with the decode/encode
 * methods NOT present on the module root.
 *
 * `@ledgerhq/hw-app-btc@10.21.1` transitively pulls `bs58check@2.1.2`,
 * a CJS package that does `require('bs58').decode(...)`. Under bs58@6
 * that throws synchronously, breaking `pair_ledger_btc` before the
 * Ledger device is ever reached.
 *
 * Fix: a scoped `@ledgerhq/hw-app-btc → bs58: ^5.0.0` override (mirrors
 * the existing Marinade carve-out) keeps the BTC subtree on bs58@5
 * (CJS named exports) while the rest of the tree stays on bs58@6.
 *
 * This test reaches into the hw-app-btc subtree's resolved bs58check
 * and confirms `decode` is callable. If the scoped override is ever
 * dropped or bs58check@2 disappears from the tree (e.g. hw-app-btc
 * upgrades to bitcoinjs-lib@7+), this test surfaces the change at CI
 * time so we can re-evaluate before users hit a runtime crash.
 */
describe("@ledgerhq/hw-app-btc bs58 subtree (issue #181)", () => {
  it("loads bs58check.decode as a callable function from the BTC subtree", () => {
    // Resolve bs58check the same way hw-app-btc's CJS code does at
    // runtime — anchored at hw-app-btc's package.json so the require
    // walks the BTC subtree, not the top-level node_modules.
    const r = createRequire(import.meta.url);
    const btcRequire = createRequire(r.resolve("@ledgerhq/hw-app-btc/package.json"));
    const bs58check = btcRequire("bs58check") as {
      encode: (b: Uint8Array) => string;
      decode: (s: string) => Uint8Array;
    };

    expect(typeof bs58check.decode).toBe("function");
    expect(typeof bs58check.encode).toBe("function");

    // Round-trip a known mainnet P2PKH address so we know decode is
    // not just present but functional. Genesis-block address.
    const decoded = bs58check.decode("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    // 1-byte version + 20-byte hash160 = 21 bytes (no checksum — bs58check strips it).
    expect(decoded.length).toBe(21);
  });
});
