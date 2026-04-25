import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Bitcoin USB-HID pairing tests (Phase 1 PR2). Mocks the Ledger BTC SDK
 * via `vi.mock("../src/signing/btc-usb-loader.js")` so the test never
 * touches real USB. Pairing entries persist to ~/.vaultpilot-mcp/config.json,
 * so each test redirects the config dir to a fresh tmp dir.
 */

const LEGACY_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const P2SH_ADDR = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
const FAKE_PUBKEY = "0".repeat(66);
const FAKE_CHAIN_CODE = "0".repeat(64);

const getWalletPublicKeyMock = vi.fn();
const signMessageMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signMessage: signMessageMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-pair-"));
  setConfigDirForTesting(tmpHome);
  getWalletPublicKeyMock.mockReset();
  signMessageMock.mockReset();
  transportCloseMock.mockClear();
  getAppAndVersionMock.mockReset();
  const { clearPairedBtcAddresses } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("btcPathForAccountIndex", () => {
  it("produces the standard 5-segment BIP-44/49/84/86 paths", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(btcPathForAccountIndex(0, "legacy")).toBe("44'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "p2sh-segwit")).toBe("49'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "segwit")).toBe("84'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "taproot")).toBe("86'/0'/0'/0/0");
    expect(btcPathForAccountIndex(7, "taproot")).toBe("86'/0'/7'/0/0");
  });

  it("rejects invalid account indices", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(() => btcPathForAccountIndex(-1, "taproot")).toThrow(/Invalid Bitcoin accountIndex/);
    expect(() => btcPathForAccountIndex(101, "taproot")).toThrow();
    expect(() => btcPathForAccountIndex(1.5, "taproot")).toThrow();
  });
});

describe("parseBtcPath", () => {
  it("decodes standard paths back into address-type + accountIndex", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(parseBtcPath("44'/0'/0'/0/0")).toEqual({
      addressType: "legacy",
      accountIndex: 0,
    });
    expect(parseBtcPath("49'/0'/3'/0/0")).toEqual({
      addressType: "p2sh-segwit",
      accountIndex: 3,
    });
    expect(parseBtcPath("84'/0'/7'/0/0")).toEqual({
      addressType: "segwit",
      accountIndex: 7,
    });
    expect(parseBtcPath("86'/0'/12'/0/0")).toEqual({
      addressType: "taproot",
      accountIndex: 12,
    });
  });

  it("returns null on non-standard paths", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Wrong purpose (mainnet only — no testnet purpose=1).
    expect(parseBtcPath("44'/1'/0'/0/0")).toBeNull();
    // Wrong segment count (account-level xpub path, not leaf).
    expect(parseBtcPath("84'/0'/0'")).toBeNull();
    // Garbage.
    expect(parseBtcPath("not-a-path")).toBeNull();
  });
});

describe("pairLedgerBitcoin", () => {
  it("derives all four address types in one call and persists each entry", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    // Ledger BTC app returns one address per format. Map by format string.
    getWalletPublicKeyMock.mockImplementation(
      async (_path: string, opts: { format: string }) => {
        const addr =
          opts.format === "legacy"
            ? LEGACY_ADDR
            : opts.format === "p2sh"
              ? P2SH_ADDR
              : opts.format === "bech32"
                ? SEGWIT_ADDR
                : TAPROOT_ADDR;
        return { publicKey: FAKE_PUBKEY, bitcoinAddress: addr, chainCode: FAKE_CHAIN_CODE };
      },
    );

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await pairLedgerBitcoin({ accountIndex: 0 });

    expect(out.accountIndex).toBe(0);
    expect(out.appVersion).toBe("2.2.3");
    expect(out.addresses).toHaveLength(4);
    const byType = Object.fromEntries(out.addresses.map((a) => [a.addressType, a]));
    expect(byType.legacy.address).toBe(LEGACY_ADDR);
    expect(byType.legacy.path).toBe("44'/0'/0'/0/0");
    expect(byType["p2sh-segwit"].address).toBe(P2SH_ADDR);
    expect(byType["p2sh-segwit"].path).toBe("49'/0'/0'/0/0");
    expect(byType.segwit.address).toBe(SEGWIT_ADDR);
    expect(byType.segwit.path).toBe("84'/0'/0'/0/0");
    expect(byType.taproot.address).toBe(TAPROOT_ADDR);
    expect(byType.taproot.path).toBe("86'/0'/0'/0/0");

    // Cached + persisted: get_ledger_status's btc section should now
    // surface all four entries.
    const { getPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const cached = getPairedBtcAddresses();
    expect(cached).toHaveLength(4);
    expect(cached.map((e) => e.addressType)).toEqual([
      "legacy",
      "p2sh-segwit",
      "segwit",
      "taproot",
    ]);
    expect(cached.every((e) => e.accountIndex === 0)).toBe(true);
    expect(cached.every((e) => e.appVersion === "2.2.3")).toBe(true);

    // Single transport open + close (deriveBtcLedgerAccount reuses it).
    expect(transportCloseMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when the wrong app is open on-device", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Ethereum", version: "1.10.4" });
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(pairLedgerBitcoin({ accountIndex: 0 })).rejects.toThrow(
      /open app as "Ethereum".*Bitcoin is required/,
    );
  });

  it("survives multiple pairings at different account indices", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    let callCount = 0;
    getWalletPublicKeyMock.mockImplementation(async (path: string) => {
      callCount++;
      // Synthesize a unique-looking address per call. Real validation
      // happens in the regex; we just need the bench32m prefix for the
      // taproot case below to round-trip.
      const idx = callCount.toString().padStart(2, "0");
      return {
        publicKey: FAKE_PUBKEY,
        bitcoinAddress: path.startsWith("44'")
          ? `1FakeAddr${idx}vH1nADuVeoUaqcJBZ1Yp`
          : path.startsWith("49'")
            ? `3FakeAddr${idx}vH1nADuVeoUaqcJBZ1Yp`
            : path.startsWith("84'")
              ? `bc1qfakeaddr${idx}vh1naduveoaqcjbz1ypqsxz3yrm`
              : `bc1pfakeaddr${idx}vh1naduveoaqcjbz1ypqsxz3yrm`,
        chainCode: FAKE_CHAIN_CODE,
      };
    });

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await pairLedgerBitcoin({ accountIndex: 0 });
    await pairLedgerBitcoin({ accountIndex: 1 });

    const { getPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const cached = getPairedBtcAddresses();
    expect(cached).toHaveLength(8); // 2 accounts × 4 types
    // Sorted by accountIndex first, then by purpose order.
    expect(cached.map((e) => e.accountIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(cached.slice(0, 4).map((e) => e.addressType)).toEqual([
      "legacy",
      "p2sh-segwit",
      "segwit",
      "taproot",
    ]);
  });
});

describe("get_ledger_status — btc section", () => {
  it("surfaces paired BTC entries when at least one is cached", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    getWalletPublicKeyMock.mockImplementation(
      async (_path: string, opts: { format: string }) => ({
        publicKey: FAKE_PUBKEY,
        bitcoinAddress:
          opts.format === "legacy"
            ? LEGACY_ADDR
            : opts.format === "p2sh"
              ? P2SH_ADDR
              : opts.format === "bech32"
                ? SEGWIT_ADDR
                : TAPROOT_ADDR,
        chainCode: FAKE_CHAIN_CODE,
      }),
    );

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await pairLedgerBitcoin({ accountIndex: 0 });

    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeDefined();
    expect(status.bitcoin?.length).toBe(4);
    const byType = Object.fromEntries(
      (status.bitcoin ?? []).map((e) => [e.addressType, e]),
    );
    expect(byType.taproot.address).toBe(TAPROOT_ADDR);
    expect(byType.segwit.path).toBe("84'/0'/0'/0/0");
  });

  it("omits the btc section when no Bitcoin pairings are cached", async () => {
    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeUndefined();
  });
});
