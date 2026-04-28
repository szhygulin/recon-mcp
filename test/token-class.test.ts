/**
 * Token-class registry + receipt-rendering tests (issue #441).
 *
 * Two layers:
 *   1. Pure registry — `lookupTokenClass` returns the right entry
 *      for case-different addresses, returns null for unknown
 *      tokens, and the seed entries each have at least one
 *      warning so empty-warning rows can't silently ship.
 *   2. Renderer integration — `renderVerificationBlock` appends
 *      `tokenClass.warnings` as `⚠ <warning>` lines (the same
 *      shape as recipient warnings) so the user reads them at
 *      the same scan position before signing.
 */
import { describe, it, expect } from "vitest";
import {
  lookupTokenClass,
  _registrySnapshotForTests,
  type TokenClassFlag,
} from "../src/modules/execution/token-class.js";
import { CONTRACTS } from "../src/config/contracts.js";

describe("lookupTokenClass — curated registry (issue #441)", () => {
  it("returns null for plain ERC-20 (USDC) — no noise on standard transfers", () => {
    expect(
      lookupTokenClass("ethereum", CONTRACTS.ethereum.tokens.USDC),
    ).toBeNull();
  });

  it("returns rebasing flag + share-rounding warning for stETH on ethereum", () => {
    const r = lookupTokenClass("ethereum", CONTRACTS.ethereum.lido.stETH);
    expect(r).not.toBeNull();
    expect(r!.flags).toEqual<TokenClassFlag[]>(["rebasing"]);
    expect(r!.warnings).toHaveLength(1);
    expect(r!.warnings[0]).toMatch(/rebasing/);
    expect(r!.warnings[0]).toMatch(/share-rounding/);
    expect(r!.warnings[0]).toMatch(/wstETH/);
  });

  it("returns rebasing flag for AMPL on ethereum with rebase-window guidance", () => {
    const r = lookupTokenClass(
      "ethereum",
      "0xD46bA6D942050d489DBd938a2C909A5d5039A161",
    );
    expect(r).not.toBeNull();
    expect(r!.flags).toEqual<TokenClassFlag[]>(["rebasing"]);
    expect(r!.warnings[0]).toMatch(/elastic-supply|rebase/);
  });

  it("address lookup is case-insensitive (lowercase + checksum + uppercase)", () => {
    const checksummed = CONTRACTS.ethereum.lido.stETH;
    const lower = checksummed.toLowerCase();
    const upper = checksummed.toUpperCase();
    expect(lookupTokenClass("ethereum", checksummed)).not.toBeNull();
    expect(lookupTokenClass("ethereum", lower)).not.toBeNull();
    expect(lookupTokenClass("ethereum", upper)).not.toBeNull();
  });

  it("returns null when the same token address is queried on the wrong chain", () => {
    // Ethereum stETH address has no entry on arbitrum (no Lido stETH there).
    expect(
      lookupTokenClass("arbitrum", CONTRACTS.ethereum.lido.stETH),
    ).toBeNull();
  });

  it("registry invariant: every seeded entry has at least one warning matching its flags", () => {
    const snap = _registrySnapshotForTests();
    expect(snap.size).toBeGreaterThan(0);
    for (const [k, v] of snap.entries()) {
      expect(v.flags.length, `${k} must have ≥1 flag`).toBeGreaterThan(0);
      expect(v.warnings.length, `${k} must have ≥1 warning`).toBeGreaterThan(0);
      // Cheap shape check: every flag is mentioned in at least one
      // warning, modulo light tense/wording flexibility. Catches
      // copy-paste errors where a tag added to flags has no
      // corresponding user-facing warning text.
      const text = v.warnings.join(" ").toLowerCase();
      for (const f of v.flags) {
        if (f === "standard") continue;
        const stem = f.replace(/_/g, " ");
        // "rebasing" or "rebase", "fee on transfer" or "fee", etc.
        const matches =
          text.includes(stem) ||
          (f === "rebasing" && text.includes("rebase")) ||
          (f === "fee_on_transfer" && text.includes("fee")) ||
          (f === "blocklisted" && text.includes("blocklist")) ||
          (f === "pausable" && text.includes("pause")) ||
          (f === "upgradeable_admin" && text.includes("upgrade"));
        expect(matches, `${k} flag "${f}" not reflected in warnings`).toBe(
          true,
        );
      }
    }
  });
});

describe("renderVerificationBlock — token-class warning surfaces in receipt", () => {
  it("appends tokenClass.warnings as ⚠ lines below the hash", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderVerificationBlock({
      chain: "ethereum",
      to: CONTRACTS.ethereum.lido.stETH,
      value: "0",
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042b1d8d3a3f0000",
      verification: {
        payloadHash: "0xdeadbeef",
        payloadHashShort: "deadbeef",
        comparisonString: "ignored",
        humanDecode: { functionName: "transfer", args: [], source: "none" },
      },
      tokenClass: {
        flags: ["rebasing"],
        warnings: [
          "stETH is rebasing — the recipient may receive 1-2 wei less than requested.",
        ],
      },
    });
    expect(block).toMatch(/⚠ stETH is rebasing/);
    // The warning should appear AFTER the hash line, so users see
    // it at the bottom of the verify block where their attention
    // lands before clicking "send".
    const hashIdx = block.indexOf("Hash:");
    const warnIdx = block.indexOf("⚠ stETH");
    expect(warnIdx).toBeGreaterThan(hashIdx);
  });

  it("omits the warning section when tokenClass is absent (plain ERC-20)", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderVerificationBlock({
      chain: "ethereum",
      to: CONTRACTS.ethereum.tokens.USDC,
      value: "0",
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042b1d8d3a3f0000",
      verification: {
        payloadHash: "0xdeadbeef",
        payloadHashShort: "deadbeef",
        comparisonString: "ignored",
        humanDecode: { functionName: "transfer", args: [], source: "none" },
      },
    });
    expect(block).not.toMatch(/⚠/);
  });
});
