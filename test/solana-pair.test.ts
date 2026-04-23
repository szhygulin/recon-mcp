import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * Tests for Solana USB HID pairing (issue: Phase 2). Mocks the Ledger
 * transport via `vi.mock("../src/signing/solana-usb-loader.js")` so the
 * test never touches real USB.
 */

const WALLET = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";

const getAddressMock = vi.fn();
const getAppConfigurationMock = vi.fn();
const signTransactionMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/solana-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getAddress: getAddressMock,
      getAppConfiguration: getAppConfigurationMock,
      signTransaction: signTransactionMock,
    },
    transport: {
      close: transportCloseMock,
    },
  }),
}));

beforeEach(async () => {
  getAddressMock.mockReset();
  getAppConfigurationMock.mockReset();
  signTransactionMock.mockReset();
  transportCloseMock.mockClear();
  const { clearPairedSolanaAddresses } = await import(
    "../src/signing/solana-usb-signer.js"
  );
  clearPairedSolanaAddresses();
});

describe("solanaPathForAccountIndex", () => {
  it("produces the 3-segment Ledger Live Solana path", async () => {
    const { solanaPathForAccountIndex } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    expect(solanaPathForAccountIndex(0)).toBe("44'/501'/0'");
    expect(solanaPathForAccountIndex(1)).toBe("44'/501'/1'");
    expect(solanaPathForAccountIndex(42)).toBe("44'/501'/42'");
  });

  it("rejects invalid account indices", async () => {
    const { solanaPathForAccountIndex } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    expect(() => solanaPathForAccountIndex(-1)).toThrow();
    expect(() => solanaPathForAccountIndex(1000)).toThrow();
    expect(() => solanaPathForAccountIndex(1.5)).toThrow();
  });
});

describe("parseSolanaAccountIndex", () => {
  it("parses the standard path format", async () => {
    const { parseSolanaAccountIndex } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    expect(parseSolanaAccountIndex("44'/501'/0'")).toBe(0);
    expect(parseSolanaAccountIndex("44'/501'/7'")).toBe(7);
  });

  it("returns null for non-matching paths", async () => {
    const { parseSolanaAccountIndex } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    expect(parseSolanaAccountIndex("44'/501'/0'/0'")).toBe(null); // 4-segment
    expect(parseSolanaAccountIndex("44'/195'/0'/0/0")).toBe(null); // TRON
    expect(parseSolanaAccountIndex("garbage")).toBe(null);
  });
});

describe("getSolanaLedgerAddress (probe)", () => {
  it("returns base58 address derived from the 32-byte pubkey buffer", async () => {
    // Use a known fixed pubkey so the base58 derivation is deterministic.
    const pubkey = new PublicKey(WALLET);
    getAddressMock.mockResolvedValueOnce({ address: pubkey.toBuffer() });
    getAppConfigurationMock.mockResolvedValueOnce({ version: "1.10.0" });

    const { getSolanaLedgerAddress } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    const res = await getSolanaLedgerAddress("44'/501'/0'");
    expect(res.address).toBe(WALLET);
    expect(res.path).toBe("44'/501'/0'");
    expect(res.appVersion).toBe("1.10.0");
    expect(res.publicKey).toBe(pubkey.toBuffer().toString("hex"));
    // Transport must be closed even on success path.
    expect(transportCloseMock).toHaveBeenCalled();
  });

  it("rejects if Ledger returns a non-32-byte buffer", async () => {
    getAddressMock.mockResolvedValueOnce({ address: Buffer.alloc(16) });
    getAppConfigurationMock.mockResolvedValueOnce({ version: "1.10.0" });
    const { getSolanaLedgerAddress } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    await expect(getSolanaLedgerAddress("44'/501'/0'")).rejects.toThrow(
      /unexpected Solana address buffer/,
    );
    // Transport still closed even on error.
    expect(transportCloseMock).toHaveBeenCalled();
  });

  it("maps the 'app not open' status word to a clear message", async () => {
    getAppConfigurationMock.mockRejectedValueOnce({
      statusCode: 0x6511,
      message: "CLA_NOT_SUPPORTED",
    });
    const { getSolanaLedgerAddress } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    await expect(getSolanaLedgerAddress("44'/501'/0'")).rejects.toThrow(
      /Solana app isn't open/,
    );
  });
});

describe("paired-address cache", () => {
  it("setPairedSolanaAddress stores + sorts entries", async () => {
    const pubkey0 = Buffer.alloc(32, 1); // arbitrary but valid
    const pubkey1 = Buffer.alloc(32, 2);
    const addr0 = new PublicKey(pubkey0).toBase58();
    const addr1 = new PublicKey(pubkey1).toBase58();

    const {
      setPairedSolanaAddress,
      getPairedSolanaAddresses,
      getPairedSolanaByAddress,
    } = await import("../src/signing/solana-usb-signer.js");

    setPairedSolanaAddress({
      address: addr1,
      publicKey: pubkey1.toString("hex"),
      path: "44'/501'/1'",
      appVersion: "1.10.0",
    });
    setPairedSolanaAddress({
      address: addr0,
      publicKey: pubkey0.toString("hex"),
      path: "44'/501'/0'",
      appVersion: "1.10.0",
    });

    const paired = getPairedSolanaAddresses();
    expect(paired.length).toBe(2);
    // Sorted by accountIndex asc — index 0 before index 1 regardless of insertion order.
    expect(paired[0].accountIndex).toBe(0);
    expect(paired[1].accountIndex).toBe(1);

    const hit = getPairedSolanaByAddress(addr1);
    expect(hit?.path).toBe("44'/501'/1'");
    expect(hit?.accountIndex).toBe(1);
  });

  it("getPairedSolanaByAddress returns null for unpaired addresses", async () => {
    const { getPairedSolanaByAddress } = await import(
      "../src/signing/solana-usb-signer.js"
    );
    expect(getPairedSolanaByAddress(WALLET)).toBe(null);
  });
});
