import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import { setConfigDirForTesting } from "../src/config/user-config.js";
import type { PairedBitcoinMultisigWallet } from "../src/types/index.js";

/**
 * PR3 — `prepare_btc_multisig_send` (initiator flow) +
 * `unregister_btc_multisig_wallet`. Mocks the indexer + multi-sig USB
 * loader; uses real bitcoinjs-lib + @scure/bip32 for crypto.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    fromBase64(b64: string): {
      data: {
        inputs: Array<{
          witnessScript?: Buffer;
          witnessUtxo?: { script: Buffer; value: number };
          nonWitnessUtxo?: Buffer;
          bip32Derivation?: Array<unknown>;
          partialSig?: Array<unknown>;
        }>;
      };
      txInputs: Array<{ sequence: number }>;
      txOutputs: Array<{ address?: string; value: number }>;
    };
  };
  Transaction: new () => {
    version: number;
    addInput(hash: Buffer, index: number, sequence?: number): unknown;
    addOutput(script: Buffer, value: number): unknown;
    toHex(): string;
  };
  address: { toOutputScript(addr: string, network?: unknown): Buffer };
  networks: { bitcoin: unknown };
};

// --- Mocks --------------------------------------------------------------

const getBalanceMock = vi.fn();
const getUtxosMock = vi.fn();
const getFeeEstimatesMock = vi.fn();
const getTxHexMock = vi.fn();
const getTxMock = vi.fn();
const getTxStatusMock = vi.fn();
const broadcastTxMock = vi.fn();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: getBalanceMock,
    getUtxos: getUtxosMock,
    getFeeEstimates: getFeeEstimatesMock,
    getTxHex: getTxHexMock,
    getTx: getTxMock,
    getTxStatus: getTxStatusMock,
    broadcastTx: broadcastTxMock,
  }),
  resetBitcoinIndexer: () => {},
}));

const getAppAndVersionMock = vi.fn();
const getMasterFingerprintMock = vi.fn();
const getExtendedPubkeyMock = vi.fn();
const registerWalletMock = vi.fn();
const signPsbtMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/btc-multisig-usb-loader.js", () => ({
  openLedgerMultisig: async () => ({
    app: {
      getAppAndVersion: getAppAndVersionMock,
      getMasterFingerprint: getMasterFingerprintMock,
      getExtendedPubkey: getExtendedPubkeyMock,
      registerWallet: registerWalletMock,
      signPsbt: signPsbtMock,
    },
    transport: { close: transportCloseMock },
  }),
  buildWalletPolicy: (name: string, descriptorTemplate: string, keys: readonly string[]) => ({
    name,
    descriptorTemplate,
    keys,
    getId: () => Buffer.alloc(32),
    serialize: () => Buffer.alloc(0),
  }),
}));

// --- Helpers ------------------------------------------------------------

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
    accountKey: account,
  };
}

function makeWallet(
  cosigners: Array<ReturnType<typeof deriveCosigner>>,
): PairedBitcoinMultisigWallet {
  return {
    name: "Vault",
    threshold: 2,
    totalSigners: cosigners.length,
    scriptType: "wsh",
    descriptor: `wsh(sortedmulti(2,${cosigners.map((_, i) => `@${i}/**`).join(",")}))`,
    cosigners: cosigners.map((c, i) => ({
      xpub: c.xpub,
      masterFingerprint: c.masterFingerprint,
      derivationPath: "48'/0'/0'/2'",
      isOurs: i === 0,
    })),
    policyHmac: "00".repeat(32),
    appVersion: "2.4.6",
  };
}

/**
 * Build a minimal mainnet prev-tx hex that pays `value` sats to an
 * arbitrary scriptPubKey at vout 0. Same shape the Phase 1 send tests
 * use — we don't validate this prev-tx anywhere; it just needs to be
 * parseable by bitcoinjs.
 */
function buildPrevTxHex(value: number, scriptPubKey: Buffer): string {
  const tx = new bitcoinjs.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  tx.addOutput(scriptPubKey, value);
  return tx.toHex();
}

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-multisig-init-"));
  setConfigDirForTesting(tmpHome);
  getBalanceMock.mockReset();
  getUtxosMock.mockReset();
  getFeeEstimatesMock.mockReset();
  getTxHexMock.mockReset();
  getTxMock.mockReset();
  getTxStatusMock.mockReset();
  broadcastTxMock.mockReset();
  getAppAndVersionMock.mockReset();
  getMasterFingerprintMock.mockReset();
  getExtendedPubkeyMock.mockReset();
  registerWalletMock.mockReset();
  signPsbtMock.mockReset();
  transportCloseMock.mockClear();
  const { __clearMultisigStore } = await import("../src/modules/btc/multisig.js");
  __clearMultisigStore();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("unregisterBitcoinMultisigWallet", () => {
  it("removes a registered wallet from the cache", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });
    const { unregisterBitcoinMultisigWallet, getPairedMultisigByName } =
      await import("../src/modules/btc/multisig.js");
    expect(getPairedMultisigByName("Vault")).not.toBeNull();
    const result = unregisterBitcoinMultisigWallet({ walletName: "Vault" });
    expect(result.removed).toBe(true);
    expect(getPairedMultisigByName("Vault")).toBeNull();
  });

  it("idempotent: returns removed: false on unknown name", async () => {
    const { unregisterBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = unregisterBitcoinMultisigWallet({ walletName: "Nonexistent" });
    expect(result.removed).toBe(false);
  });
});

describe("prepareBitcoinMultisigSend", () => {
  async function setupVaultWithUtxo(amountSats: number) {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });

    // Derive the chain=0 / index=0 multi-sig address so we know what
    // to fund.
    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const fundedAddr = deriveMultisigAddress(wallet, 0, 0);
    // chain=0/index=0 has UTXOs; everything else empty.
    getBalanceMock.mockImplementation(async (addr: string) => {
      if (addr === fundedAddr.address) {
        return {
          address: addr,
          confirmedSats: BigInt(amountSats),
          mempoolSats: 0n,
          totalSats: BigInt(amountSats),
          txCount: 1,
        };
      }
      return {
        address: addr,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });
    getUtxosMock.mockImplementation(async (addr: string) =>
      addr === fundedAddr.address
        ? [
            {
              txid: "ab".repeat(32),
              vout: 0,
              value: amountSats,
              unconfirmed: false,
            },
          ]
        : [],
    );
    getFeeEstimatesMock.mockResolvedValue({
      fastestFee: 20,
      halfHourFee: 10,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });
    getTxHexMock.mockImplementation(async (txid: string) => {
      if (txid === "ab".repeat(32)) {
        return buildPrevTxHex(amountSats, fundedAddr.scriptPubKey);
      }
      throw new Error(`unexpected getTxHex(${txid})`);
    });
    return { wallet, cosigners: [a, b, c], fundedAddr };
  }

  it("builds + signs a multi-sig send, returns partial PSBT with our sig", async () => {
    const { wallet, cosigners } = await setupVaultWithUtxo(100_000_000); // 1 BTC
    const a = cosigners[0];

    // sign_btc_multisig_psbt path: device confirms app, fingerprint,
    // returns one partial sig.
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    // Derive the per-input child pubkey we'd produce at chain=0/idx=0.
    const childA = a.accountKey.derive("m/0/0");
    const ourPubkey = Buffer.from(childA.publicKey!);
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: ourPubkey,
          signature: Buffer.from([
            0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01,
          ]),
        },
      ],
    ]);

    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await prepareBitcoinMultisigSend({
      walletName: "Vault",
      to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
      amount: "0.001",
      feeRateSatPerVb: 10,
    });
    expect(result.signaturesAdded).toBe(1);
    expect(result.signaturesPresent).toBe(1);
    expect(result.signaturesNeeded).toBe(2);
    expect(result.fullySigned).toBe(false);
    expect(result.walletName).toBe("Vault");
    expect(result.feeRateSatPerVb).toBe(10);
    expect(Number(result.feeSats)).toBeGreaterThan(0);
    expect(result.changeAddress).toBeDefined();

    // The returned PSBT carries our partial sig + bip32_derivation
    // for ALL cosigners on every input.
    const psbt = bitcoinjs.Psbt.fromBase64(result.partialPsbtBase64);
    expect(psbt.data.inputs[0].witnessScript).toBeDefined();
    expect(psbt.data.inputs[0].nonWitnessUtxo).toBeDefined();
    expect(psbt.data.inputs[0].bip32Derivation?.length).toBe(3);
    expect(psbt.data.inputs[0].partialSig?.length).toBe(1);
    // Sequence is RBF-eligible.
    expect(psbt.txInputs[0].sequence).toBe(0xfffffffd);
    // Two outputs: recipient + change (~1 BTC - 0.001 BTC - fee).
    expect(psbt.txOutputs.length).toBe(2);
    expect(psbt.txOutputs[0].value).toBe(100_000); // 0.001 BTC
  });

  it("refuses unknown wallet name", async () => {
    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      prepareBitcoinMultisigSend({
        walletName: "Nonexistent",
        to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        amount: "0.001",
      }),
    ).rejects.toThrow(/No multi-sig wallet registered/);
  });

  it("refuses when the wallet has zero UTXOs", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });
    getBalanceMock.mockResolvedValue({
      address: "",
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 0,
    });
    getUtxosMock.mockResolvedValue([]);
    getFeeEstimatesMock.mockResolvedValue({
      fastestFee: 20,
      halfHourFee: 10,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });

    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      prepareBitcoinMultisigSend({
        walletName: "Vault",
        to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        amount: "0.001",
      }),
    ).rejects.toThrow(/No UTXOs found/);
  });

  it("refuses insufficient funds", async () => {
    await setupVaultWithUtxo(1_000); // 1000 sats — way too small for any reasonable send
    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      prepareBitcoinMultisigSend({
        walletName: "Vault",
        to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        amount: "0.01", // 1M sats > 1k
        feeRateSatPerVb: 10,
      }),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it("supports 'max' to sweep every UTXO without change", async () => {
    const { wallet, cosigners } = await setupVaultWithUtxo(100_000_000);
    const a = cosigners[0];

    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    const childA = a.accountKey.derive("m/0/0");
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: Buffer.from(childA.publicKey!),
          signature: Buffer.from([
            0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01,
          ]),
        },
      ],
    ]);

    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await prepareBitcoinMultisigSend({
      walletName: "Vault",
      to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
      amount: "max",
      feeRateSatPerVb: 10,
    });
    // No change → only one output.
    const psbt = bitcoinjs.Psbt.fromBase64(result.partialPsbtBase64);
    expect(psbt.txOutputs.length).toBe(1);
    expect(result.changeAddress).toBeUndefined();
    expect(result.changeSats).toBe("0");
    // Recipient gets balance - fee.
    expect(Number(psbt.txOutputs[0].value)).toBe(100_000_000 - Number(result.feeSats));
    void wallet;
  });
});
