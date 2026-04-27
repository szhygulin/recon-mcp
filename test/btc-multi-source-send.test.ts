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
        }>;
      };
    };
  };
  address: {
    toOutputScript(addr: string, network?: unknown): Buffer;
  };
  networks: { bitcoin: unknown };
};

/**
 * Issue #264 — multi-source consolidation regression suite.
 *
 * Builds two paired chain=0 source addresses under the same Ledger
 * account (segwit, accountIndex=0) and exercises:
 *   - merged UTXO pool fed into one PSBT with one output (+ change)
 *   - per-PSBT-input source mapping (`tx.inputSources`)
 *   - per-source breakdown in `tx.decoded.sources`
 *   - signer's `knownAddressDerivations` carries one entry per source
 *   - rejection of mixed addressType
 *   - rejection of mixed accountIndex
 *   - "max" sweep across the merged pool
 *   - single-source backwards-compat (string `wallet` works exactly
 *     as before — same accountPath, same single sources entry)
 */

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

// Two real-looking native segwit addresses with deterministic pubkey
// fixtures. They don't need to be on-curve consistent with any known
// seed — the mocked Ledger SDK echoes back the address we hand it for
// the proof-of-identity guard.
const SEGWIT_ADDR_A = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SEGWIT_ADDR_B = "bc1q7xkc9sr96a773zpagat8cg7y3vwx0v5gjpw60j";
const TAPROOT_ADDR_C = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
const SEGWIT_PUBKEY = "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
const SEGWIT_PUBKEY_UNCOMPRESSED =
  "04a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd" +
  "5b8dec5235a0fa8722476c7709c02559e3aa73aa03918ba2d492eea75abea235";
const CHANGE_ADDR = "bc1qr0p2usnskwqhupc2590l2skll0vzd84cdp3gly";
const CHANGE_PATH = "84'/0'/0'/1/0";
const RECIPIENT = "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu";

const TXID_A =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TXID_B =
  "2222222222222222222222222222222222222222222222222222222222222222";
const FAKE_RAW_TX_HEX = "020000000001abcd";
const FAKE_BROADCAST_TXID =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const getWalletPublicKeyMock = vi.fn();
const signPsbtBufferMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signPsbtBuffer: signPsbtBufferMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
}));

const getUtxosMock = vi.fn();
const getFeeEstimatesMock = vi.fn();
const broadcastTxMock = vi.fn();
const getTxStatusMock = vi.fn();
const getTxHexMock = vi.fn();

// Map (address, txid) → registered value for the prev-tx fixture.
// The mock's getUtxos calls capture which UTXO came from which source;
// getTxHex pulls the value from that registry to build a parseable
// prev-tx hex paying the right address.
const utxoFixtureRegistry = new Map<
  string,
  { value: number; vout: number; sourceAddress: string }
>();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getUtxos: getUtxosMock,
    getFeeEstimates: getFeeEstimatesMock,
    broadcastTx: broadcastTxMock,
    getTxStatus: getTxStatusMock,
    getTxHex: getTxHexMock,
  }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-multi-"));
  setConfigDirForTesting(tmpHome);
  getWalletPublicKeyMock.mockReset();
  signPsbtBufferMock.mockReset();
  transportCloseMock.mockClear();
  getAppAndVersionMock.mockReset();
  getUtxosMock.mockReset();
  getFeeEstimatesMock.mockReset();
  broadcastTxMock.mockReset();
  getTxStatusMock.mockReset();
  getTxHexMock.mockReset();
  utxoFixtureRegistry.clear();
  // getTxHex looks up the registry to find which source funded the txid
  // (so the prev-tx fixture pays the right address back).
  getTxHexMock.mockImplementation(async (txid: string) => {
    const fix = utxoFixtureRegistry.get(txid);
    if (!fix) {
      throw new Error(`Test setup error: no fixture registered for txid ${txid}`);
    }
    return buildPrevTxHex(fix.value, fix.sourceAddress, fix.vout);
  });

  const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  const { __clearBitcoinTxStore } = await import(
    "../src/signing/btc-tx-store.js"
  );
  clearPairedBtcAddresses();
  __clearBitcoinTxStore();
  // Pair two segwit sources under accountIndex=0.
  setPairedBtcAddress({
    address: SEGWIT_ADDR_A,
    publicKey: SEGWIT_PUBKEY,
    path: "84'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 0,
    addressIndex: 0,
  });
  setPairedBtcAddress({
    address: SEGWIT_ADDR_B,
    publicKey: SEGWIT_PUBKEY,
    path: "84'/0'/0'/0/1",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 0,
    addressIndex: 1,
  });
  // Change address (chain=1) for the same account.
  setPairedBtcAddress({
    address: CHANGE_ADDR,
    publicKey: SEGWIT_PUBKEY,
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

/**
 * Stage `getUtxos` so each address returns its own UTXO list, in the
 * order the builder calls per `wallets`. Records each (txid, value,
 * source) tuple in `utxoFixtureRegistry` so getTxHex can synthesize
 * matching prev-tx hex.
 */
function stageUtxos(perSource: Array<{
  address: string;
  utxos: Array<{ txid: string; vout: number; value: number }>;
}>): void {
  for (const src of perSource) {
    for (const u of src.utxos) {
      utxoFixtureRegistry.set(u.txid, {
        value: u.value,
        vout: u.vout,
        sourceAddress: src.address,
      });
    }
    getUtxosMock.mockResolvedValueOnce(
      src.utxos.map((u) => ({ ...u, unconfirmed: false })),
    );
  }
}

describe("buildBitcoinNativeSend — multi-source (issue #264)", () => {
  it("merges UTXOs from multiple sources into one PSBT with per-input source mapping", async () => {
    stageUtxos([
      {
        address: SEGWIT_ADDR_A,
        utxos: [{ txid: TXID_A, vout: 0, value: 60_000 }],
      },
      {
        address: SEGWIT_ADDR_B,
        utxos: [{ txid: TXID_B, vout: 0, value: 80_000 }],
      },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: [SEGWIT_ADDR_A, SEGWIT_ADDR_B],
      to: RECIPIENT,
      amount: "0.0009",
      feeRateSatPerVb: 1,
    });

    // Both sources show up in the envelope.
    expect(tx.sources).toHaveLength(2);
    expect(tx.sources[0]).toMatchObject({ address: SEGWIT_ADDR_A });
    expect(tx.sources[1]).toMatchObject({ address: SEGWIT_ADDR_B });

    // Multi-input PSBT: both 60k + 80k UTXOs are pulled to cover 90k +
    // fee. Per-input source mapping is recorded on the envelope and
    // ordered by PSBT input order.
    expect(tx.inputSources.length).toBe(2);
    const inputSourceSet = new Set(tx.inputSources);
    expect(inputSourceSet.has(SEGWIT_ADDR_A)).toBe(true);
    expect(inputSourceSet.has(SEGWIT_ADDR_B)).toBe(true);

    // PSBT carries 2 inputs with witnessUtxo + nonWitnessUtxo.
    const psbt = bitcoinjsForFixtures.Psbt.fromBase64(tx.psbtBase64);
    expect(psbt.data.inputs.length).toBe(2);
    for (const inp of psbt.data.inputs) {
      expect(inp.witnessUtxo).toBeDefined();
      expect(inp.nonWitnessUtxo).toBeDefined();
    }

    // Per-source breakdown surfaces both addresses with the right sat
    // totals and input counts.
    expect(tx.decoded.sources).toHaveLength(2);
    const a = tx.decoded.sources.find((s) => s.address === SEGWIT_ADDR_A)!;
    const b = tx.decoded.sources.find((s) => s.address === SEGWIT_ADDR_B)!;
    expect(a.pulledSats).toBe("60000");
    expect(b.pulledSats).toBe("80000");
    expect(a.inputCount).toBe(1);
    expect(b.inputCount).toBe(1);

    // `from` defaults to the first wallet in the input list (backwards
    // compat label).
    expect(tx.from).toBe(SEGWIT_ADDR_A);
    expect(tx.description).toMatch(/Consolidate.*from 2 addresses/);
  });

  it("rejects mixed addressType across sources (Phase 1 scope)", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    setPairedBtcAddress({
      address: TAPROOT_ADDR_C,
      publicKey: SEGWIT_PUBKEY,
      path: "86'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: [SEGWIT_ADDR_A, TAPROOT_ADDR_C],
        to: RECIPIENT,
        amount: "0.0001",
        feeRateSatPerVb: 1,
      }),
    ).rejects.toThrow(/Mixed source-address types/);
  });

  it("rejects mixed accountIndex across sources", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const otherAccountAddr = "bc1qksrfmukh8582qhdpy74f7z0y4qluyx489m3jaz";
    setPairedBtcAddress({
      address: otherAccountAddr,
      publicKey: SEGWIT_PUBKEY,
      path: "84'/0'/1'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 1,
      chain: 0,
      addressIndex: 0,
    });
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: [SEGWIT_ADDR_A, otherAccountAddr],
        to: RECIPIENT,
        amount: "0.0001",
        feeRateSatPerVb: 1,
      }),
    ).rejects.toThrow(/Cross-account multi-source/);
  });

  it("'max' sweeps the merged pool across all sources", async () => {
    stageUtxos([
      {
        address: SEGWIT_ADDR_A,
        utxos: [{ txid: TXID_A, vout: 0, value: 100_000 }],
      },
      {
        address: SEGWIT_ADDR_B,
        utxos: [{ txid: TXID_B, vout: 0, value: 200_000 }],
      },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: [SEGWIT_ADDR_A, SEGWIT_ADDR_B],
      to: RECIPIENT,
      amount: "max",
      feeRateSatPerVb: 1,
    });
    // Total balance 300k, max produces a single recipient output with
    // the full balance minus fee. No change output (exact-fit branch).
    const recipientOutput = tx.decoded.outputs.find(
      (o) => o.address === RECIPIENT,
    );
    expect(recipientOutput).toBeDefined();
    const sats = Number(recipientOutput!.amountSats);
    expect(sats).toBeGreaterThan(298_000);
    expect(sats).toBeLessThan(300_000);
    // Both sources contributed.
    expect(tx.decoded.sources).toHaveLength(2);
    expect(tx.inputSources.length).toBe(2);
  });

  it("backwards-compat: string `wallet` builds a single-source tx unchanged", async () => {
    stageUtxos([
      {
        address: SEGWIT_ADDR_A,
        utxos: [{ txid: TXID_A, vout: 0, value: 100_000 }],
      },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR_A,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 1,
    });
    expect(tx.from).toBe(SEGWIT_ADDR_A);
    expect(tx.sources).toHaveLength(1);
    expect(tx.sources[0].address).toBe(SEGWIT_ADDR_A);
    expect(tx.decoded.sources).toHaveLength(1);
    expect(tx.decoded.sources[0].inputCount).toBe(1);
    expect(tx.description).toMatch(/^Send /);
  });

  it("signer registers one knownAddressDerivations entry per unique source + change", async () => {
    stageUtxos([
      {
        address: SEGWIT_ADDR_A,
        utxos: [{ txid: TXID_A, vout: 0, value: 60_000 }],
      },
      {
        address: SEGWIT_ADDR_B,
        utxos: [{ txid: TXID_B, vout: 0, value: 80_000 }],
      },
    ]);
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
    });
    // The signer re-derives every source against the device — return
    // the matching address each call.
    getWalletPublicKeyMock.mockImplementation(async (path: string) => {
      if (path === "84'/0'/0'/0/0") {
        return {
          bitcoinAddress: SEGWIT_ADDR_A,
          publicKey: SEGWIT_PUBKEY_UNCOMPRESSED,
          chainCode: "0".repeat(64),
        };
      }
      if (path === "84'/0'/0'/0/1") {
        return {
          bitcoinAddress: SEGWIT_ADDR_B,
          publicKey: SEGWIT_PUBKEY_UNCOMPRESSED,
          chainCode: "0".repeat(64),
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    signPsbtBufferMock.mockResolvedValueOnce({
      psbt: Buffer.alloc(0),
      tx: FAKE_RAW_TX_HEX,
    });
    broadcastTxMock.mockResolvedValueOnce(FAKE_BROADCAST_TXID);

    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: [SEGWIT_ADDR_A, SEGWIT_ADDR_B],
      to: RECIPIENT,
      amount: "0.0009",
      feeRateSatPerVb: 1,
    });

    const { sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    await sendTransaction({
      handle: tx.handle!,
      confirmed: true,
    });
    const [, options] = signPsbtBufferMock.mock.calls[0];
    const known = options.knownAddressDerivations as Map<
      string,
      { pubkey: Buffer; path: number[] }
    >;
    // 2 sources + 1 change = 3 entries.
    expect(known.size).toBe(3);
    // Both source paths show up under chain=0; change path under chain=1.
    const entries = [...known.values()];
    const sourceA = entries.find((e) => e.path[3] === 0 && e.path[4] === 0);
    const sourceB = entries.find((e) => e.path[3] === 0 && e.path[4] === 1);
    const changeEntry = entries.find((e) => e.path[3] === 1);
    expect(sourceA).toBeDefined();
    expect(sourceB).toBeDefined();
    expect(changeEntry).toBeDefined();
  });

  it("verification block lists every source with its sat pull", async () => {
    stageUtxos([
      {
        address: SEGWIT_ADDR_A,
        utxos: [{ txid: TXID_A, vout: 0, value: 60_000 }],
      },
      {
        address: SEGWIT_ADDR_B,
        utxos: [{ txid: TXID_B, vout: 0, value: 80_000 }],
      },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: [SEGWIT_ADDR_A, SEGWIT_ADDR_B],
      to: RECIPIENT,
      amount: "0.0009",
      feeRateSatPerVb: 1,
    });
    const { renderBitcoinVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderBitcoinVerificationBlock(tx);
    expect(block).toMatch(/multi-source consolidation/);
    expect(block).toContain("2 source addresses");
    expect(block).toContain(SEGWIT_ADDR_A);
    expect(block).toContain(SEGWIT_ADDR_B);
    // Sat totals from each source surface in the block.
    expect(block).toMatch(/0\.0006 BTC/);
    expect(block).toMatch(/0\.0008 BTC/);
  });
});
