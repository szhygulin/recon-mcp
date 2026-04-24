import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setConfigDirForTesting,
  readUserConfig,
  getConfigPath,
} from "../src/config/user-config.js";
import {
  setPairedSolanaAddress,
  getPairedSolanaAddresses,
  clearPairedSolanaAddresses,
} from "../src/signing/solana-usb-signer.js";
import {
  setPairedTronAddress,
  getPairedTronAddresses,
  clearPairedTronAddresses,
} from "../src/signing/tron-usb-signer.js";

/**
 * End-to-end tests for `~/.vaultpilot-mcp/config.json` persistence of
 * Ledger pairings (Solana + TRON). What we're proving:
 *
 *   1. Pair → snapshot to disk; the JSON has the entry.
 *   2. Cross-chain isolation: pairing a Solana address does NOT clobber
 *      existing TRON entries (and vice versa). This was the failure mode
 *      `patchUserConfig` originally hit before the per-chain merge fix.
 *   3. Hydrate-on-restart: clear in-memory + reload (fresh module state)
 *      → entry comes back, sourced from disk.
 *   4. `clearPaired*Addresses()` zeroes both the in-memory Map AND the
 *      on-disk slice (but leaves other slices alone).
 *
 * Each test uses a fresh tmp dir as the config root so we never touch
 * the developer's real `~/.vaultpilot-mcp/`. Critical: vitest's
 * `vi.resetModules()` reloads `user-config.ts` with default state, so
 * the override is implemented as an env var (`VAULTPILOT_CONFIG_DIR`)
 * which survives module reloads — see `setConfigDirForTesting`.
 */

const SOLANA_ADDR_0 = "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf";
const SOLANA_ADDR_1 = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const TRON_ADDR_0 = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const TRON_ADDR_1 = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-pairing-persistence-"));
  setConfigDirForTesting(tmpHome);
  // Make sure both module-level Maps start empty for THIS test.
  clearPairedSolanaAddresses();
  clearPairedTronAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("Solana pairing — disk round-trip", () => {
  it("setPairedSolanaAddress writes the entry to ~/.vaultpilot-mcp/config.json", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(cfg.pairings.solana).toHaveLength(1);
    expect(cfg.pairings.solana[0]).toMatchObject({
      address: SOLANA_ADDR_0,
      path: "44'/501'/0'",
      accountIndex: 0,
    });
  });

  it("re-pairing the same path overwrites the old entry (no duplicates)", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    // Pretend the user reflashes the device at a newer app version.
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.11.0",
    });
    const cfg = readUserConfig();
    expect(cfg?.pairings?.solana).toHaveLength(1);
    expect(cfg?.pairings?.solana?.[0].appVersion).toBe("1.11.0");
  });

  it("hydrates from disk on first read after a fresh in-memory cache", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    // Simulate a server restart: blow away the in-memory Map. The disk
    // file still has the entry; the next read must repopulate from it.
    // (clearPairedSolanaAddresses ALSO writes [] to disk, so we can't use
    // it here — we want to keep the disk entry. Instead we resetModules
    // to get a fresh module instance with an empty Map but the same env
    // var pointing at our tmpHome.)
    return import("vitest").then(async ({ vi }) => {
      vi.resetModules();
      const fresh = await import("../src/signing/solana-usb-signer.js");
      const entries = fresh.getPairedSolanaAddresses();
      expect(entries).toHaveLength(1);
      expect(entries[0].address).toBe(SOLANA_ADDR_0);
      expect(entries[0].appVersion).toBe("1.10.0");
    });
  });

  it("clearPairedSolanaAddresses wipes both in-memory AND on-disk", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    expect(readUserConfig()?.pairings?.solana).toHaveLength(1);
    clearPairedSolanaAddresses();
    expect(getPairedSolanaAddresses()).toHaveLength(0);
    expect(readUserConfig()?.pairings?.solana).toEqual([]);
  });
});

describe("TRON pairing — disk round-trip", () => {
  it("setPairedTronAddress writes the entry", () => {
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    const cfg = readUserConfig();
    expect(cfg?.pairings?.tron).toHaveLength(1);
    expect(cfg?.pairings?.tron?.[0].address).toBe(TRON_ADDR_0);
    expect(cfg?.pairings?.tron?.[0].accountIndex).toBe(0);
  });

  it("clearPairedTronAddresses wipes both in-memory AND on-disk", () => {
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    clearPairedTronAddresses();
    expect(getPairedTronAddresses()).toHaveLength(0);
    expect(readUserConfig()?.pairings?.tron).toEqual([]);
  });
});

describe("cross-chain isolation", () => {
  it("pairing Solana does NOT clobber an existing TRON pairing", () => {
    // First: pair TRON.
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    // Then: pair Solana. This goes through patchUserConfig with only
    // `pairings.solana` in the patch — without the per-chain merge, the
    // tron entry would be wiped.
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    const cfg = readUserConfig();
    expect(cfg?.pairings?.tron).toHaveLength(1);
    expect(cfg?.pairings?.tron?.[0].address).toBe(TRON_ADDR_0);
    expect(cfg?.pairings?.solana).toHaveLength(1);
    expect(cfg?.pairings?.solana?.[0].address).toBe(SOLANA_ADDR_0);
  });

  it("pairing TRON does NOT clobber an existing Solana pairing", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    const cfg = readUserConfig();
    expect(cfg?.pairings?.solana).toHaveLength(1);
    expect(cfg?.pairings?.tron).toHaveLength(1);
  });

  it("clearPairedSolanaAddresses leaves TRON pairings on disk untouched", () => {
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    clearPairedSolanaAddresses();
    const cfg = readUserConfig();
    expect(cfg?.pairings?.solana).toEqual([]);
    expect(cfg?.pairings?.tron).toHaveLength(1);
    expect(cfg?.pairings?.tron?.[0].address).toBe(TRON_ADDR_0);
  });

  it("clearPairedTronAddresses leaves Solana pairings on disk untouched", () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    clearPairedTronAddresses();
    const cfg = readUserConfig();
    expect(cfg?.pairings?.tron).toEqual([]);
    expect(cfg?.pairings?.solana).toHaveLength(1);
  });
});

describe("multiple accounts per chain", () => {
  it("two Solana pairings coexist on disk and survive a hydrate cycle", async () => {
    setPairedSolanaAddress({
      address: SOLANA_ADDR_0,
      publicKey: "01" + "00".repeat(31),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });
    setPairedSolanaAddress({
      address: SOLANA_ADDR_1,
      publicKey: "02" + "00".repeat(31),
      path: "44'/501'/1'",
      appVersion: "1.10.0",
    });
    const cfg = readUserConfig();
    expect(cfg?.pairings?.solana).toHaveLength(2);

    // Hydrate cycle.
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("../src/signing/solana-usb-signer.js");
    const entries = fresh.getPairedSolanaAddresses();
    expect(entries).toHaveLength(2);
    // Sorted by accountIndex.
    expect(entries[0].accountIndex).toBe(0);
    expect(entries[1].accountIndex).toBe(1);
  });

  it("two TRON pairings coexist on disk and survive a hydrate cycle", async () => {
    setPairedTronAddress({
      address: TRON_ADDR_0,
      publicKey: "04" + "ab".repeat(32),
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    setPairedTronAddress({
      address: TRON_ADDR_1,
      publicKey: "04" + "cd".repeat(32),
      path: "44'/195'/1'/0/0",
      appVersion: "0.5.0",
    });
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("../src/signing/tron-usb-signer.js");
    const entries = fresh.getPairedTronAddresses();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.address).sort()).toEqual(
      [TRON_ADDR_0, TRON_ADDR_1].sort(),
    );
  });
});

describe("safety: doesn't touch the real config", () => {
  it("clearPairedSolanaAddresses on a fresh tmp dir does NOT create the config file", () => {
    // The clear function only writes if a config already exists — avoids
    // creating ~/.vaultpilot-mcp on a fresh install just to record "no
    // pairings".
    expect(existsSync(getConfigPath())).toBe(false);
    clearPairedSolanaAddresses();
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("clearPairedTronAddresses on a fresh tmp dir does NOT create the config file", () => {
    expect(existsSync(getConfigPath())).toBe(false);
    clearPairedTronAddresses();
    expect(existsSync(getConfigPath())).toBe(false);
  });
});
