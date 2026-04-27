import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createRequire } from "node:module";
import { setConfigDirForTesting } from "../src/config/user-config.js";

const requireCjs = createRequire(import.meta.url);
const bitcoinjsForFixtures = requireCjs("bitcoinjs-lib") as {
  Transaction: new () => {
    version: number;
    addInput(hash: Buffer, index: number, sequence?: number): unknown;
    addOutput(script: Buffer, value: number): unknown;
    toHex(): string;
  };
  Psbt: {
    fromBase64(b64: string): {
      data: {
        inputs: Array<{
          witnessUtxo?: { script: Buffer; value: number };
          nonWitnessUtxo?: Buffer;
          sequence?: number;
        }>;
        outputs: Array<unknown>;
      };
      txInputs: Array<{ sequence: number }>;
      txOutputs: Array<{ address?: string; value: number }>;
    };
  };
  address: {
    toOutputScript(addr: string, network?: unknown): Buffer;
  };
  networks: { bitcoin: unknown };
};

function buildPrevTxHex(value: number, address: string, vout = 0): string {
  const tx = new bitcoinjsForFixtures.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  for (let i = 0; i <= vout; i++) {
    const script = bitcoinjsForFixtures.address.toOutputScript(
      address,
      bitcoinjsForFixtures.networks.bitcoin,
    );
    tx.addOutput(script, i === vout ? value : 0);
  }
  return tx.toHex();
}

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SEGWIT_PUBKEY =
  "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
const CHANGE_ADDR = "bc1qr0p2usnskwqhupc2590l2skll0vzd84cdp3gly";
const CHANGE_PUBKEY = SEGWIT_PUBKEY;
const CHANGE_PATH = "84'/0'/0'/1/0";
const RECIPIENT = "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu";
const FOREIGN_WALLET = "bc1qpxg3y3yphn0vh4nh3rjz3p6cudn0jcvfk0nyf6";

const ORIG_TXID =
  "1111111111111111111111111111111111111111111111111111111111111111";
const ORIG_INPUT_TXID =
  "2222222222222222222222222222222222222222222222222222222222222222";

const getTxMock = vi.fn();
const getTxHexMock = vi.fn();
const getUtxosMock = vi.fn();
const getFeeEstimatesMock = vi.fn();
const broadcastTxMock = vi.fn();
const getTxStatusMock = vi.fn();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getUtxos: getUtxosMock,
    getFeeEstimates: getFeeEstimatesMock,
    broadcastTx: broadcastTxMock,
    getTxStatus: getTxStatusMock,
    getTxHex: getTxHexMock,
    getTx: getTxMock,
  }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

/**
 * Build a fake Esplora tx shape for the original (pre-bump) tx. Default
 * shape: 1 input from SEGWIT_ADDR (100k sats), 2 outputs (50k to
 * RECIPIENT, ~49k change to CHANGE_ADDR), fee 1000 sats, mempool. Tests
 * tweak fields via the override arg.
 */
function makeOrigTx(overrides: Partial<{
  vinSequence: number;
  vinAddress: string;
  vinValue: number;
  outputs: Array<{ address: string; value: number }>;
  fee: number;
  confirmed: boolean;
  blockHeight: number;
}> = {}) {
  const vinValue = overrides.vinValue ?? 100_000;
  const outputs =
    overrides.outputs ??
    [
      { address: RECIPIENT, value: 50_000 },
      { address: CHANGE_ADDR, value: 49_000 },
    ];
  const fee = overrides.fee ?? vinValue - outputs.reduce((s, o) => s + o.value, 0);
  return {
    txid: ORIG_TXID,
    vin: [
      {
        txid: ORIG_INPUT_TXID,
        vout: 0,
        prevout: {
          scriptpubkey_address: overrides.vinAddress ?? SEGWIT_ADDR,
          value: vinValue,
        },
        sequence: overrides.vinSequence ?? 0xfffffffd,
      },
    ],
    vout: outputs.map((o) => ({
      scriptpubkey_address: o.address,
      value: o.value,
    })),
    fee,
    status: overrides.confirmed
      ? { confirmed: true, block_height: overrides.blockHeight ?? 900_000 }
      : { confirmed: false },
  };
}

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-rbf-"));
  setConfigDirForTesting(tmpHome);
  getTxMock.mockReset();
  getTxHexMock.mockReset();
  getUtxosMock.mockReset();
  getFeeEstimatesMock.mockReset();
  broadcastTxMock.mockReset();
  getTxStatusMock.mockReset();
  // Default: derive prev-tx hex from the input value the most-recent
  // getTxMock returned. Tests can override per-call.
  getTxHexMock.mockImplementation(async (txid: string) => {
    const lastResult = getTxMock.mock.results[getTxMock.mock.results.length - 1];
    if (!lastResult || lastResult.type !== "return") {
      throw new Error(`getTxHex(${txid}) called but no getTx mock has run.`);
    }
    const tx = (await lastResult.value) as ReturnType<typeof makeOrigTx>;
    const matchingVin = tx.vin.find((v) => v.txid === txid);
    if (!matchingVin) {
      throw new Error(`No vin matches txid ${txid}.`);
    }
    return buildPrevTxHex(matchingVin.prevout.value, SEGWIT_ADDR, matchingVin.vout);
  });
  const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  const { __clearBitcoinTxStore } = await import(
    "../src/signing/btc-tx-store.js"
  );
  clearPairedBtcAddresses();
  __clearBitcoinTxStore();
  setPairedBtcAddress({
    address: SEGWIT_ADDR,
    publicKey: SEGWIT_PUBKEY,
    path: "84'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 0,
    addressIndex: 0,
  });
  setPairedBtcAddress({
    address: CHANGE_ADDR,
    publicKey: CHANGE_PUBKEY,
    path: CHANGE_PATH,
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 1,
    addressIndex: 0,
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("buildBitcoinRbfBump", () => {
  it("happy path: bumps fee, shrinks change, preserves recipient", async () => {
    getTxMock.mockResolvedValueOnce(makeOrigTx({ fee: 1_000 }));
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinRbfBump({
      wallet: SEGWIT_ADDR,
      txid: ORIG_TXID,
      newFeeRate: 25,
    });
    expect(tx.chain).toBe("bitcoin");
    expect(tx.action).toBe("rbf_bump");
    expect(tx.from).toBe(SEGWIT_ADDR);
    expect(tx.handle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tx.replaces?.txid).toBe(ORIG_TXID);
    expect(tx.replaces?.oldFeeSats).toBe("1000");
    expect(tx.decoded.feeRateSatPerVb).toBe(25);
    expect(tx.decoded.rbfEligible).toBe(true);
    // Recipient preserved verbatim.
    const recipient = tx.decoded.outputs.find((o) => o.address === RECIPIENT);
    expect(recipient?.amountSats).toBe("50000");
    // Change shrunk: input 100k - recipient 50k - newFee = newChange.
    const change = tx.decoded.outputs.find((o) => o.address === CHANGE_ADDR);
    expect(change?.isChange).toBe(true);
    const newFee = Number(tx.decoded.feeSats);
    expect(newFee).toBeGreaterThan(1_000);
    expect(Number(change?.amountSats)).toBe(100_000 - 50_000 - newFee);
    // PSBT carries every input with sequence 0xFFFFFFFD + nonWitnessUtxo.
    const psbt = bitcoinjsForFixtures.Psbt.fromBase64(tx.psbtBase64);
    expect(psbt.txInputs.length).toBe(1);
    expect(psbt.txInputs[0].sequence).toBe(0xfffffffd);
    expect(psbt.data.inputs[0].witnessUtxo).toBeDefined();
    expect(psbt.data.inputs[0].nonWitnessUtxo).toBeDefined();
  });

  it("refuses when the original tx is already confirmed", async () => {
    getTxMock.mockResolvedValueOnce(
      makeOrigTx({ confirmed: true, blockHeight: 900_001 }),
    );
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/already confirmed/);
  });

  it("refuses when no input is BIP-125-eligible", async () => {
    getTxMock.mockResolvedValueOnce(makeOrigTx({ vinSequence: 0xffffffff }));
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/not BIP-125 RBF-eligible/);
  });

  it("refuses when an input belongs to a foreign wallet", async () => {
    getTxMock.mockResolvedValueOnce(
      makeOrigTx({ vinAddress: FOREIGN_WALLET }),
    );
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/Multi-source RBF is out of scope/);
  });

  it("refuses when the original tx has no change output (sweep)", async () => {
    getTxMock.mockResolvedValueOnce(
      makeOrigTx({
        outputs: [{ address: RECIPIENT, value: 99_000 }],
        fee: 1_000,
      }),
    );
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/no change output/);
  });

  it("refuses when newFeeRate fails BIP-125 rule 4", async () => {
    // Old fee 5000 sats; newFeeRate 30 sat/vB × ~141 vbytes ≈ 4230 sats —
    // strictly less than the 5141-sats minimum required by rule 4.
    getTxMock.mockResolvedValueOnce(makeOrigTx({ fee: 5_000 }));
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 30,
      }),
    ).rejects.toThrow(/BIP-125 rule 4/);
  });

  it("refuses when bumped change drops below dust", async () => {
    // Input 100k - recipient 99k = 1k available. Any fee bump ≥ 455 sats
    // pushes change below the 546-sat dust threshold.
    getTxMock.mockResolvedValueOnce(
      makeOrigTx({
        outputs: [
          { address: RECIPIENT, value: 99_000 },
          { address: CHANGE_ADDR, value: 900 },
        ],
        fee: 100,
      }),
    );
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/dust threshold/);
  });

  it("refuses unpaired wallet", async () => {
    const { clearPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    clearPairedBtcAddresses();
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: ORIG_TXID,
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/not paired/);
  });

  it("allowHighFee threads through to the build path", async () => {
    getTxMock.mockResolvedValueOnce(makeOrigTx({ fee: 500 }));
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinRbfBump({
      wallet: SEGWIT_ADDR,
      txid: ORIG_TXID,
      newFeeRate: 50,
      allowHighFee: true,
    });
    expect(tx.action).toBe("rbf_bump");
    expect(Number(tx.decoded.feeSats)).toBeGreaterThan(500);
  });

  it("rejects malformed txid up-front (no indexer call)", async () => {
    const { buildBitcoinRbfBump } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinRbfBump({
        wallet: SEGWIT_ADDR,
        txid: "not-a-real-txid",
        newFeeRate: 25,
      }),
    ).rejects.toThrow(/64 hex characters/);
    expect(getTxMock).not.toHaveBeenCalled();
  });
});
