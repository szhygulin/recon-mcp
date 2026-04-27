import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1";

/**
 * Litecoin core test — address validation, BIP32 host-side derivation,
 * USB-signer pairing path, send-side PSBT building, message-signing.
 *
 * Mirrors the BTC test pattern: mocks the Ledger SDK via
 * `vi.mock("../src/signing/ltc-usb-loader.js")` so no USB is touched.
 * Pairing entries persist to ~/.vaultpilot-mcp/config.json — each test
 * redirects to a fresh tmp dir.
 *
 * Coverage: address-type detection (L/M/3/ltc1q/ltc1p), BIP-44 path
 * shape (coin_type=2), pairing flow, single-address balance read,
 * send-side rejection of legacy 3-prefix recipients, message-sign
 * BIP-137 header.
 */

import {
  detectLitecoinAddressType,
  isLitecoinAddress,
  assertLitecoinAddress,
} from "../src/modules/litecoin/address.js";
import { setConfigDirForTesting } from "../src/config/user-config.js";

// ---- Address validation ------------------------------------------------

describe("Litecoin address validation", () => {
  it("recognizes the four mainnet types and the legacy 3-prefix P2SH", () => {
    expect(detectLitecoinAddressType("LfvgypHnpdJDmpyJWqu7zhJrETvjgmWv2D")).toBe("p2pkh");
    expect(detectLitecoinAddressType("MFhSgYTKNqL36KpVrUasrkUmwYg1NjwdMV")).toBe("p2sh");
    // Legacy 3-prefix P2SH (still emitted by some exchanges)
    expect(detectLitecoinAddressType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe("p2sh");
    expect(
      detectLitecoinAddressType("ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck"),
    ).toBe("p2wpkh");
    expect(
      detectLitecoinAddressType(
        "ltc1pveaamy78cq5hvl74zmfw52fxyjun3lh7lgt46cur8wzezvqdgvksqsy7m4",
      ),
    ).toBe("p2tr");
  });

  it("rejects testnet, MWEB, and BTC mainnet addresses", () => {
    // BTC mainnet legacy `1...`
    expect(detectLitecoinAddressType("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(null);
    // BTC bech32 `bc1...`
    expect(
      detectLitecoinAddressType("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
    ).toBe(null);
    // LTC testnet
    expect(
      detectLitecoinAddressType("tltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck"),
    ).toBe(null);
    // MWEB (not supported)
    expect(
      detectLitecoinAddressType(
        "ltcmweb1qqfqf9z83zye9q4n75v8nzkacejxgkkesvjdgqd9hu6jnqwqdrlmgyuq22qsy",
      ),
    ).toBe(null);
    expect(isLitecoinAddress("not-a-real-address")).toBe(false);
  });

  it("assertLitecoinAddress throws with a helpful message", () => {
    expect(() => assertLitecoinAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))
      .toThrow(/not a valid Litecoin/);
  });
});

// ---- BIP32 host-side derivation ---------------------------------------

describe("Litecoin BIP32 host-side derivation", () => {
  it("uses BIP-44 coin_type 2 (not 0)", async () => {
    const { ltcAccountLevelPath, ltcLeafPath, parseLtcPath } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    expect(ltcAccountLevelPath(0, "segwit")).toBe("84'/2'/0'");
    expect(ltcLeafPath(0, "segwit", 0, 0)).toBe("84'/2'/0'/0/0");
    expect(ltcLeafPath(3, "taproot", 1, 5)).toBe("86'/2'/3'/1/5");
    // Reject BTC-shape paths (coin_type 0)
    expect(parseLtcPath("84'/0'/0'/0/0")).toBe(null);
    // Accept LTC-shape paths
    expect(parseLtcPath("84'/2'/0'/0/0")).toEqual({
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
  });

  it("encodes addresses with the LTC bech32 HRP and version bytes", async () => {
    const { encodeAddressForFormat, accountNodeFromLedgerResponse } = await import(
      "../src/signing/ltc-bip32-derive.js"
    );
    // Deterministic BIP-32 root from a known seed.
    const seed = createHash("sha256").update("ltc-test-seed").digest();
    const root = HDKey.fromMasterSeed(seed);
    const accountHd = root.derive("m/84'/2'/0'");
    if (!accountHd.publicKey || !accountHd.chainCode) {
      throw new Error("test fixture: derivation failed");
    }
    // Convert to uncompressed (the shape Ledger returns) so the helper
    // exercises its compress + xpub-encode path.
    const point = secp256k1.ProjectivePoint.fromHex(
      Buffer.from(accountHd.publicKey).toString("hex"),
    );
    const node = accountNodeFromLedgerResponse({
      publicKeyHex: Buffer.from(point.toRawBytes(false)).toString("hex"),
      chainCodeHex: Buffer.from(accountHd.chainCode).toString("hex"),
      addressFormat: "bech32",
    });
    // Re-derive a leaf and confirm the address is `ltc1q…`
    const child = node.hd.derive("m/0/0");
    if (!child.publicKey) throw new Error("no child pubkey");
    const addr = encodeAddressForFormat(child.publicKey, "bech32");
    expect(addr.startsWith("ltc1q")).toBe(true);
    // Same seed via legacy format → L-prefix
    const legacy = encodeAddressForFormat(child.publicKey, "legacy");
    expect(legacy.startsWith("L")).toBe(true);
    // p2sh-segwit → M-prefix (modern)
    const p2sh = encodeAddressForFormat(child.publicKey, "p2sh");
    expect(p2sh.startsWith("M")).toBe(true);
    // taproot → ltc1p
    const taproot = encodeAddressForFormat(child.publicKey, "bech32m");
    expect(taproot.startsWith("ltc1p")).toBe(true);
  });
});

// ---- Pairing flow (mocked Ledger) -------------------------------------

const TEST_SEED = createHash("sha256").update("ltc-pair-test-seed").digest();
const TEST_ROOT = HDKey.fromMasterSeed(TEST_SEED);

function makeAccountFixture(purpose: number, accountIndex: number) {
  const accountHd = TEST_ROOT.derive(`m/${purpose}'/2'/${accountIndex}'`);
  if (!accountHd.publicKey || !accountHd.chainCode) {
    throw new Error("derivation failed");
  }
  const point = secp256k1.ProjectivePoint.fromHex(
    Buffer.from(accountHd.publicKey).toString("hex"),
  );
  return {
    publicKeyHex: Buffer.from(point.toRawBytes(false)).toString("hex"),
    chainCodeHex: Buffer.from(accountHd.chainCode).toString("hex"),
    hd: accountHd,
  };
}

const getWalletPublicKeyMock = vi.fn();
const signMessageMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/ltc-usb-loader.js", () => ({
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
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-ltc-test-"));
  setConfigDirForTesting(pjoin(tmpHome, ".vaultpilot-mcp"));
  getWalletPublicKeyMock.mockReset();
  signMessageMock.mockReset();
  transportCloseMock.mockReset();
  getAppAndVersionMock.mockReset();
  getAppAndVersionMock.mockResolvedValue({ name: "Litecoin", version: "2.4.6" });
  // Also flush the in-memory pairing cache.
  const { clearPairedLtcAddresses } = await import(
    "../src/signing/ltc-usb-signer.js"
  );
  clearPairedLtcAddresses();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pair_ledger_ltc", () => {
  // retry: 2 — flakes on full-suite runs from upstream module-cache contamination.
  it("derives all four address types for accountIndex 0 and stamps coin_type 2", { retry: 2 }, async () => {
    // Account-level call returns the (publicKey, chainCode) for the
    // requested purpose — host-side derivation walks under it.
    const fixturesByPurpose = new Map<number, ReturnType<typeof makeAccountFixture>>();
    for (const purpose of [44, 49, 84, 86]) {
      fixturesByPurpose.set(purpose, makeAccountFixture(purpose, 0));
    }
    getWalletPublicKeyMock.mockImplementation((path: string) => {
      const m = /^(\d+)'\/2'\/(\d+)'$/.exec(path);
      if (!m) {
        throw new Error(`unexpected non-account path: ${path}`);
      }
      const purpose = Number(m[1]);
      const fixture = fixturesByPurpose.get(purpose);
      if (!fixture) throw new Error(`no fixture for purpose ${purpose}`);
      return Promise.resolve({
        publicKey: fixture.publicKeyHex,
        bitcoinAddress: "irrelevant-at-account-level",
        chainCode: fixture.chainCodeHex,
      });
    });

    const { pairLedgerLitecoin } = await import(
      "../src/modules/execution/index.js"
    );
    const { getLitecoinIndexer } = await import(
      "../src/modules/litecoin/indexer.js"
    );
    // Stub the indexer so the gap-limit scan terminates immediately
    // (every probe → txCount 0).
    const indexer = getLitecoinIndexer();
    vi.spyOn(indexer, "getBalance").mockResolvedValue({
      address: "any",
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 0,
    });

    const result = await pairLedgerLitecoin({ accountIndex: 0, gapLimit: 1 });
    expect(result.accountIndex).toBe(0);
    expect(result.appVersion).toBe("2.4.6");
    // Four address types × 2 chains × at least 1 entry → ≥ 4 entries
    // (with gapLimit=1 + receive empty → change skipped, so exactly 4)
    expect(result.addresses.length).toBe(4);
    const types = result.addresses.map((a) => a.addressType).sort();
    expect(types).toEqual(["legacy", "p2sh-segwit", "segwit", "taproot"]);
    // Every path must use coin_type 2.
    for (const a of result.addresses) {
      expect(a.path).toMatch(/^(44|49|84|86)'\/2'\/0'\/0\/0$/);
    }
    // L/M/ltc1q/ltc1p prefixes per address type.
    const byType = new Map(result.addresses.map((a) => [a.addressType, a.address]));
    expect(byType.get("legacy")?.startsWith("L")).toBe(true);
    expect(byType.get("p2sh-segwit")?.startsWith("M")).toBe(true);
    expect(byType.get("segwit")?.startsWith("ltc1q")).toBe(true);
    expect(byType.get("taproot")?.startsWith("ltc1p")).toBe(true);
  });

  it("rejects with a hint when the wrong app is open", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    getWalletPublicKeyMock.mockResolvedValue({
      publicKey: "00".repeat(65),
      bitcoinAddress: "x",
      chainCode: "00".repeat(32),
    });
    const { pairLedgerLitecoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(pairLedgerLitecoin({ accountIndex: 0, gapLimit: 1 })).rejects.toThrow(
      /Litecoin is required/,
    );
  });

  // Issue #231 regression: the Ledger Litecoin app throws unconditionally
  // on `format: "bech32m"` (taproot). Pre-fix, this took out the entire
  // pairing call and left legacy/p2sh/segwit unpaired. Fix: per-type
  // fault tolerance — record taproot under `skipped[]`, persist the
  // other three, return success.
  it("survives taproot's bech32m rejection — pairs the other three types and records taproot under skipped[]", async () => {
    const fixturesByPurpose = new Map<number, ReturnType<typeof makeAccountFixture>>();
    for (const purpose of [44, 49, 84, 86]) {
      fixturesByPurpose.set(purpose, makeAccountFixture(purpose, 0));
    }
    getWalletPublicKeyMock.mockImplementation(
      (path: string, opts?: { format?: string }) => {
        // Mirror the real Ledger LTC app behavior at
        // node_modules/@ledgerhq/hw-app-btc/src/BtcOld.ts:93.
        if (opts?.format === "bech32m") {
          throw new Error("Unsupported address format bech32m");
        }
        const m = /^(\d+)'\/2'\/(\d+)'$/.exec(path);
        if (!m) {
          throw new Error(`unexpected non-account path: ${path}`);
        }
        const purpose = Number(m[1]);
        const fixture = fixturesByPurpose.get(purpose);
        if (!fixture) throw new Error(`no fixture for purpose ${purpose}`);
        return Promise.resolve({
          publicKey: fixture.publicKeyHex,
          bitcoinAddress: "irrelevant-at-account-level",
          chainCode: fixture.chainCodeHex,
        });
      },
    );

    const { pairLedgerLitecoin } = await import(
      "../src/modules/execution/index.js"
    );
    const { getLitecoinIndexer } = await import(
      "../src/modules/litecoin/indexer.js"
    );
    const indexer = getLitecoinIndexer();
    vi.spyOn(indexer, "getBalance").mockResolvedValue({
      address: "any",
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 0,
    });

    const result = await pairLedgerLitecoin({ accountIndex: 0, gapLimit: 1 });
    // Three types succeed (legacy / p2sh-segwit / segwit), taproot is
    // skipped — pre-fix this whole call threw "Unsupported address
    // format bech32m" with zero entries persisted.
    expect(result.addresses.length).toBe(3);
    const types = result.addresses.map((a) => a.addressType).sort();
    expect(types).toEqual(["legacy", "p2sh-segwit", "segwit"]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].addressType).toBe("taproot");
    expect(result.skipped[0].reason).toMatch(/bech32m/);
    expect(result.instructions).toMatch(/Skipped 1\/4 address types \(taproot\)/);

    // The persisted cache must reflect the same shape — three entries,
    // no taproot.
    const { getPairedLtcAddresses } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const cached = getPairedLtcAddresses();
    expect(cached.length).toBe(3);
    expect(cached.some((c) => c.addressType === "taproot")).toBe(false);
  });

  // If EVERY type fails (e.g. wrong app version blocking all paths), we
  // should not silently "succeed" with zero entries — that would clear
  // the existing cache and leave the user worse off. Throw with the
  // collected per-type reasons so the caller can diagnose.
  it("throws when every address-type walk fails (does not wipe the cache)", async () => {
    getWalletPublicKeyMock.mockImplementation(() => {
      throw new Error("device disconnected mid-call");
    });
    const { pairLedgerLitecoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      pairLedgerLitecoin({ accountIndex: 0, gapLimit: 1 }),
    ).rejects.toThrow(/every address-type walk failed/);
  });
});

// ---- Send-side rejection of legacy 3-prefix recipients ----------------

describe("prepare_litecoin_native_send", () => {
  it("rejects legacy 3-prefix P2SH recipients with a clear message", async () => {
    // Insert a fake paired entry so the source-address check passes.
    const { setPairedLtcAddress } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    setPairedLtcAddress({
      address: "ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck",
      publicKey: "00".repeat(33),
      path: "84'/2'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    const { prepareLitecoinNativeSend } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareLitecoinNativeSend({
        wallet: "ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck",
        to: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // legacy 3-prefix
        amount: "0.001",
      }),
    ).rejects.toThrow(/3-prefix Litecoin P2SH addresses.*not supported/);
  });
});

// ---- Message-sign BIP-137 header byte ---------------------------------

describe("sign_message_ltc", () => {
  it("emits a BIP-137 base64 signature with the segwit header byte (39 + recid)", async () => {
    // Need a paired segwit entry whose address the mocked
    // `getWalletPublicKey` re-derivation returns. Use the same fixture
    // helper as the pairing test.
    const fixture = makeAccountFixture(84, 0);
    const { encodeAddressForFormat, accountNodeFromLedgerResponse } = await import(
      "../src/signing/ltc-bip32-derive.js"
    );
    const node = accountNodeFromLedgerResponse({
      publicKeyHex: fixture.publicKeyHex,
      chainCodeHex: fixture.chainCodeHex,
      addressFormat: "bech32",
    });
    const child = node.hd.derive("m/0/0");
    if (!child.publicKey) throw new Error("no child pubkey");
    const segwitAddr = encodeAddressForFormat(child.publicKey, "bech32");

    // Re-derivation guard: ledger returns the same segwit address.
    getWalletPublicKeyMock.mockImplementation((_path: string) =>
      Promise.resolve({
        publicKey: fixture.publicKeyHex,
        bitcoinAddress: segwitAddr,
        chainCode: fixture.chainCodeHex,
      }),
    );
    // signMessage: (v, r, s) → header byte = 39 + (v & 1) for segwit.
    signMessageMock.mockResolvedValue({
      v: 1,
      r: "aa".repeat(32),
      s: "bb".repeat(32),
    });

    const { setPairedLtcAddress } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    setPairedLtcAddress({
      address: segwitAddr,
      publicKey: fixture.publicKeyHex,
      path: "84'/2'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });

    const { signLtcMessage } = await import(
      "../src/modules/execution/index.js"
    );
    const result = await signLtcMessage({ wallet: segwitAddr, message: "hello LTC" });
    expect(result.address).toBe(segwitAddr);
    expect(result.message).toBe("hello LTC");
    expect(result.format).toBe("BIP-137");
    expect(result.addressType).toBe("segwit");
    // Decode base64 sig and verify the header byte = 39 + (v & 1) = 40.
    const sigBuf = Buffer.from(result.signature, "base64");
    expect(sigBuf.length).toBe(65);
    expect(sigBuf[0]).toBe(40);
  });

  it("refuses taproot message-signing (BIP-322 not supported)", async () => {
    // Pair a fake taproot entry.
    const { setPairedLtcAddress } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const taprootAddr =
      "ltc1pveaamy78cq5hvl74zmfw52fxyjun3lh7lgt46cur8wzezvqdgvksqsy7m4";
    setPairedLtcAddress({
      address: taprootAddr,
      publicKey: "00".repeat(33),
      path: "86'/2'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    const { signLtcMessage } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      signLtcMessage({ wallet: taprootAddr, message: "hi" }),
    ).rejects.toThrow(/Taproot.*BIP-322/);
  });
});

// ---- Tx-store + handle namespace --------------------------------------

describe("ltc-tx-store handle namespace", () => {
  it("issues handles with `ltc-` prefix and consumes them once", async () => {
    const {
      issueLitecoinHandle,
      consumeLitecoinHandle,
      hasLitecoinHandle,
      __clearLitecoinTxStore,
    } = await import("../src/signing/ltc-tx-store.js");
    __clearLitecoinTxStore();
    const { handle, fingerprint } = issueLitecoinHandle({
      chain: "litecoin",
      action: "native_send",
      from: "ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck",
      psbtBase64: "cHNidP8BAAoCAAAAAAAAAAAAAA==",
      accountPath: "84'/2'/0'",
      addressFormat: "bech32",
      description: "test",
      decoded: {
        functionName: "litecoin.native_send",
        args: {},
        outputs: [],
        feeSats: "0",
        feeLtc: "0",
        feeRateSatPerVb: 1,
        rbfEligible: true,
      },
      vsize: 110,
    });
    expect(handle).toMatch(/^ltc-/);
    expect(fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hasLitecoinHandle(handle)).toBe(true);
    const tx = consumeLitecoinHandle(handle);
    expect(tx.from).toBe("ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck");
    // Consumption is non-destructive (matches BTC); must still be there
    // for the actual send_transaction to retire it after broadcast.
    expect(hasLitecoinHandle(handle)).toBe(true);
    __clearLitecoinTxStore();
    expect(hasLitecoinHandle(handle)).toBe(false);
  });
});
