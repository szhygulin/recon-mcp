import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { HDKey } from "@scure/bip32";
import { setConfigDirForTesting } from "../src/config/user-config.js";
import type { PairedBitcoinMultisigWallet } from "../src/types/index.js";

/**
 * Tests for the watch-only multi-sig balance + UTXO readers (PR2).
 * Mocks the indexer; uses real `@scure/bip32` + `bitcoinjs-lib` for
 * address derivation so the cross-check against expected addresses is
 * meaningful.
 */

const getBalanceMock = vi.fn();
const getUtxosMock = vi.fn();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: getBalanceMock,
    getUtxos: getUtxosMock,
    getFeeEstimates: vi.fn(),
    broadcastTx: vi.fn(),
    getTxStatus: vi.fn(),
    getTxHex: vi.fn(),
    getTx: vi.fn(),
  }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

function deriveCosigner(seed: string) {
  const seedBuf = Buffer.alloc(64);
  Buffer.from(seed.padEnd(64, "x")).copy(seedBuf);
  const master = HDKey.fromMasterSeed(seedBuf);
  const account = master.derive("m/48'/0'/0'/2'");
  const fp = master.fingerprint;
  const masterFingerprint = Buffer.alloc(4);
  masterFingerprint.writeUInt32BE(fp, 0);
  return {
    xpub: account.publicExtendedKey,
    masterFingerprint: masterFingerprint.toString("hex"),
  };
}

async function registerVault(): Promise<PairedBitcoinMultisigWallet> {
  const a = deriveCosigner("alice");
  const b = deriveCosigner("bob");
  const c = deriveCosigner("carol");
  const wallet: PairedBitcoinMultisigWallet = {
    name: "Vault",
    threshold: 2,
    totalSigners: 3,
    scriptType: "wsh",
    descriptor: "wsh(sortedmulti(2,@0/**,@1/**,@2/**))",
    cosigners: [
      { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'", isOurs: true },
      { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'", isOurs: false },
      { xpub: c.xpub, masterFingerprint: c.masterFingerprint, derivationPath: "48'/0'/0'/2'", isOurs: false },
    ],
    policyHmac: "00".repeat(32),
    appVersion: "2.4.6",
  };
  // Persist via the multisig store's setter — we use the direct user
  // config path so this test doesn't depend on register's mocked Ledger
  // flow.
  const { patchUserConfig } = await import("../src/config/user-config.js");
  patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });
  // Force the multisig module to re-hydrate from disk.
  const { __clearMultisigStore } = await import("../src/modules/btc/multisig.js");
  __clearMultisigStore();
  patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });
  return wallet;
}

beforeEach(() => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-multisig-bal-"));
  setConfigDirForTesting(tmpHome);
  getBalanceMock.mockReset();
  getUtxosMock.mockReset();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("deriveMultisigAddress", () => {
  it("derives a stable bc1q...-prefixed P2WSH address for chain=0/index=0", async () => {
    const wallet = await registerVault();
    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const info = deriveMultisigAddress(wallet, 0, 0);
    expect(info.address.startsWith("bc1q")).toBe(true);
    // P2WSH bech32 addresses are 62 chars (1 hrp + 1 separator + 1 witness ver + 32 program + 6 checksum).
    expect(info.address.length).toBe(62);
    // Re-derivation must be deterministic.
    const again = deriveMultisigAddress(wallet, 0, 0);
    expect(again.address).toBe(info.address);
    // chain=1 should produce a DIFFERENT address.
    const change = deriveMultisigAddress(wallet, 1, 0);
    expect(change.address).not.toBe(info.address);
  });

  it("includes every cosigner's pubkey in the witnessScript", async () => {
    const wallet = await registerVault();
    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const info = deriveMultisigAddress(wallet, 0, 0);
    expect(info.cosignerPubkeys).toHaveLength(3);
    for (const pk of info.cosignerPubkeys) {
      expect(pk.length).toBe(33); // compressed
      expect([0x02, 0x03]).toContain(pk[0]);
    }
    // Witness script begins with OP_2 (threshold=2 → 0x52) and ends
    // with OP_3 (totalSigners=3 → 0x53) + OP_CHECKMULTISIG (0xae).
    expect(info.witnessScript[0]).toBe(0x52);
    expect(info.witnessScript[info.witnessScript.length - 2]).toBe(0x53);
    expect(info.witnessScript[info.witnessScript.length - 1]).toBe(0xae);
  });

  it("refuses unsupported scriptType (taproot deferred to PR4)", async () => {
    const wallet = await registerVault();
    const taprootWallet = { ...wallet, scriptType: "tr" as never };
    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    expect(() => deriveMultisigAddress(taprootWallet, 0, 0)).toThrow(
      /not supported in this module/,
    );
  });
});

describe("getMultisigBalance", () => {
  it("walks both chains and aggregates non-empty addresses", async () => {
    await registerVault();
    // Make chain=0 index=0 funded; everything else empty (gap limit
    // tripped after 20 empties).
    getBalanceMock.mockImplementation(async (address: string) => {
      // Funded address: deterministic — first chain=0 derivation.
      if (getBalanceMock.mock.calls.length === 1) {
        return {
          address,
          confirmedSats: 50_000n,
          mempoolSats: 0n,
          totalSats: 50_000n,
          txCount: 1,
        };
      }
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });
    const { getMultisigBalance } = await import(
      "../src/modules/btc/multisig-balance.ts"
    );
    const result = await getMultisigBalance({ walletName: "Vault", gapLimit: 5 });
    expect(result.confirmedSats).toBe(50_000n);
    expect(result.txCount).toBe(1);
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses[0].chain).toBe(0);
    expect(result.addresses[0].addressIndex).toBe(0);
    // gap-limit 5 → walks 6 receive (idx 0 funded + 5 empties), then 5 change empties.
    expect(getBalanceMock).toHaveBeenCalledTimes(11);
  });

  it("refuses unknown wallet name", async () => {
    const { getMultisigBalance } = await import(
      "../src/modules/btc/multisig-balance.ts"
    );
    await expect(
      getMultisigBalance({ walletName: "Nonexistent" }),
    ).rejects.toThrow(/No multi-sig wallet registered/);
  });
});

describe("getMultisigUtxos", () => {
  it("returns UTXOs annotated with witnessScript + cosigner pubkeys", async () => {
    await registerVault();
    // First derived chain=0 address has 1 UTXO; rest empty.
    let firstAddress: string | null = null;
    getBalanceMock.mockImplementation(async (address: string) => {
      const isFirst =
        firstAddress === null || firstAddress === address;
      if (firstAddress === null) firstAddress = address;
      return isFirst && address === firstAddress
        ? {
            address,
            confirmedSats: 100_000n,
            mempoolSats: 0n,
            totalSats: 100_000n,
            txCount: 1,
          }
        : {
            address,
            confirmedSats: 0n,
            mempoolSats: 0n,
            totalSats: 0n,
            txCount: 0,
          };
    });
    getUtxosMock.mockImplementation(async (address: string) =>
      address === firstAddress
        ? [
            {
              txid: "ab".repeat(32),
              vout: 0,
              value: 100_000,
              unconfirmed: false,
            },
          ]
        : [],
    );
    const { getMultisigUtxos } = await import(
      "../src/modules/btc/multisig-balance.ts"
    );
    const result = await getMultisigUtxos({ walletName: "Vault", gapLimit: 3 });
    expect(result.utxos).toHaveLength(1);
    expect(result.utxos[0].chain).toBe(0);
    expect(result.utxos[0].addressIndex).toBe(0);
    expect(result.utxos[0].cosignerPubkeys).toHaveLength(3);
    expect(result.utxos[0].witnessScript[0]).toBe(0x52); // OP_2
    expect(result.totalSats).toBe(100_000n);
  });
});
