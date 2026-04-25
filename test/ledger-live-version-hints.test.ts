/**
 * Unit tests for the Ledger Live version hint + pairing-instructions
 * helpers in `src/signing/session.ts`. Pure functions — no WC, no FS, no
 * network. The live-session integration (session-status exposes
 * `peerVersion`) is covered indirectly wherever callers mock a session
 * struct.
 */
import { describe, it, expect } from "vitest";
import {
  parseLedgerLiveVersion,
  ledgerLivePairingInstructions,
} from "../src/signing/session.js";

describe("parseLedgerLiveVersion", () => {
  it("returns undefined when metadata is missing", () => {
    expect(parseLedgerLiveVersion(undefined)).toBeUndefined();
  });

  it("returns undefined when metadata has no version-shaped token", () => {
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live",
        description: "Ledger's self-custody app",
        url: "https://ledger.com",
      }),
    ).toBeUndefined();
  });

  it("extracts a three-part semver embedded in `name`", () => {
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live 2.80.0",
        description: "",
        url: "https://ledger.com",
      }),
    ).toBe("2.80.0");
  });

  it("extracts a two-part version when that's all the peer reports", () => {
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live",
        description: "v2.78",
        url: "",
      }),
    ).toBe("2.78");
  });

  it("falls through to description / url when name has no version", () => {
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live",
        description: "self-custody wallet",
        url: "https://apps.ledger.com/v2.90.1/walletconnect",
      }),
    ).toBe("2.90.1");
  });

  it("returns the FIRST version it sees (predictable + cheap)", () => {
    // A peer reporting multiple semver tokens shouldn't confuse the caller.
    // First-match is fine; the hint is advisory.
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live 2.80.0 (build 3.0.1)",
        description: "",
        url: "",
      }),
    ).toBe("2.80.0");
  });

  it("ignores non-versiony numbers (single integers)", () => {
    expect(
      parseLedgerLiveVersion({
        name: "Ledger Live 5",
        description: "",
        url: "",
      }),
    ).toBeUndefined();
  });
});

describe("ledgerLivePairingInstructions", () => {
  it("emits both UI paths when no version is known (generic fallback)", () => {
    const out = ledgerLivePairingInstructions(undefined);
    expect(out).toMatch(/Discover.*WalletConnect/);
    expect(out).toMatch(/Settings.*Connected Apps.*WalletConnect/);
    expect(out).not.toMatch(/Detected Ledger Live/);
  });

  it("leads with a 'Detected' hint when a version is known", () => {
    const out = ledgerLivePairingInstructions("2.80.0");
    expect(out).toMatch(/^Detected Ledger Live 2\.80\.0/);
    // But STILL lists both paths — the version string alone isn't
    // authoritative enough to drop one, since the actual cutover point
    // between the two menus varies.
    expect(out).toMatch(/Discover/);
    expect(out).toMatch(/Settings.*Connected Apps/);
  });

  it("mentions the search-bar fallback so the user always has a way to find it", () => {
    expect(ledgerLivePairingInstructions(undefined)).toMatch(/search.*"WalletConnect"/);
    expect(ledgerLivePairingInstructions("2.99.0")).toMatch(/search.*"WalletConnect"/);
  });

  it("tells the user the session persists after pairing", () => {
    expect(ledgerLivePairingInstructions(undefined)).toMatch(
      /session is persisted/,
    );
  });
});
