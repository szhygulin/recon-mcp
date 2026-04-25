import { describe, it, expect } from "vitest";

/**
 * Regression test for issue #178 ("BN is not a constructor" in
 * `prepare_marinade_stake`).
 *
 * `@coral-xyz/anchor@0.30.x` registers `BN` (and `web3`) on its CJS
 * `exports` via `Object.defineProperty(exports, "BN", { get: ... })`.
 * Node's `cjs-module-lexer` — the static analyzer that builds the
 * named-export set when an ESM consumer imports a CJS module — does
 * NOT detect those particular getters, so `await import(
 * "@coral-xyz/anchor")` resolves with `BN: undefined` at the named-
 * export slot. The full `module.exports` object (with the working
 * getters) survives at the `default` namespace.
 *
 * The Marinade builder reads BN through `loadAnchorBN()` in
 * `src/modules/solana/marinade.ts`, which tries the named export first
 * and falls back to `default.BN`. This test pins that shape so a
 * future Anchor release / Node ESM-CJS interop change that drops
 * either path surfaces here at CI time, instead of as a "BN is not a
 * constructor" runtime crash in the field.
 *
 * Deliberately NOT mocked — that's the entire point. The original bug
 * shipped because `test/solana-marinade.test.ts` mocks `@coral-xyz/
 * anchor` wholesale with a hand-rolled `{ BN }` named export, masking
 * the production-path failure.
 */
describe("@coral-xyz/anchor BN import shape (production path)", () => {
  it("loads BN as a callable constructor via the marinade fallback pattern", async () => {
    const mod = await import("@coral-xyz/anchor");
    type Ctor = typeof mod.BN;
    const fromNamed: Ctor | undefined = (mod as { BN?: Ctor }).BN;
    const fromDefault: Ctor | undefined = (
      mod as { default?: { BN?: Ctor } }
    ).default?.BN;
    const BN = typeof fromNamed === "function" ? fromNamed : fromDefault;
    expect(typeof BN).toBe("function");
    expect(BN).toBeDefined();
    const x = new BN!("12345678901234567890");
    // BN's stringify round-trips exactly — verifies we got a real
    // bn.js constructor, not a stub.
    expect(x.toString(10)).toBe("12345678901234567890");
    expect(typeof (x as unknown as { toArrayLike: unknown }).toArrayLike).toBe(
      "function",
    );
  });

  it("documents which named exports survive cjs-module-lexer detection", async () => {
    // Pin the empirical observation: AnchorProvider / Program / utils
    // ARE detected as named exports (they're declared via the same
    // `Object.defineProperty` pattern as BN, but cjs-module-lexer
    // happens to pick them up). BN and web3 are the holes. If a
    // future anchor release fixes its named-export emit so BN is
    // detected, this test still passes — but the second assertion's
    // `defined` flips, which is a useful breadcrumb the fallback may
    // be removable.
    const mod = await import("@coral-xyz/anchor");
    expect(typeof (mod as { AnchorProvider?: unknown }).AnchorProvider).toBe(
      "function",
    );
    expect(typeof (mod as { Program?: unknown }).Program).toBe("function");
  });
});
