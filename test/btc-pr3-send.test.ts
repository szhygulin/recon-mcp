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
 * Build a minimal mainnet prev-tx hex with a single output at `vout`
 * paying `address` `value` sats. Issue #213 — `prepare_btc_send` now
 * fetches `getTxHex(input.txid)` for every selected UTXO and stuffs
 * the result into the PSBT as `nonWitnessUtxo`. bitcoinjs-lib's
 * `addInput` validates the value matches `witnessUtxo.value`, so the
 * fixture has to actually carry the right amount at the right vout.
 */
function buildPrevTxHex(value: number, address: string, vout = 0): string {
  const tx = new bitcoinjsForFixtures.Transaction();
  tx.version = 2;
  // Coinbase-style dummy input — we don't sign or validate this prev-tx
  // anywhere; it just needs to be parseable by bitcoinjs.
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

/**
 * BTC PR3 — `prepare_btc_send` (PSBT build) + `send_transaction` BTC
 * branch + `get_transaction_status` BTC branch.
 *
 * The Ledger BTC SDK is mocked via `btc-usb-loader.js` (same shim the
 * pairing tests use). The mempool.space indexer is mocked via
 * `getBitcoinIndexer`, replacing each method we touch with a fixture.
 * Real PSBTs are built via bitcoinjs-lib (not mocked) so the test
 * exercises the actual coin-selection + addInput/addOutput path.
 */

// A real-looking native segwit address with a deterministic pubkey.
// (Using bitcoinjs-lib's network constants + a fake leaf pubkey is enough
// — we don't broadcast or sign for real.)
const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
// Compressed (33-byte) form. The signer's pubkey buffer for the SDK's
// knownAddressDerivations map MUST be in this shape regardless of what
// Ledger returned, so the SDK's downstream P2WPKH/P2TR derivation
// arithmetic doesn't choke. Issue #211.
const SEGWIT_PUBKEY = "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
// Issue #254: BIP-32 chain=1 (internal/change) address that pair_ledger_btc
// caches for the same account. The builder picks this when adding the
// change output to the PSBT, and the signer registers it as a second
// `knownAddressDerivations` entry so the Ledger BTC app labels the
// output as "Change" instead of warning. Address + pubkey can be any
// well-formed pair — the mock SDK doesn't device-validate them.
// Derived with `bj.address.toBech32(ripemd160(sha256("…change-fixture")))`
// so the bech32 checksum is genuine (bitcoinjs's address.toOutputScript
// validates it).
const CHANGE_ADDR = "bc1qr0p2usnskwqhupc2590l2skll0vzd84cdp3gly";
const CHANGE_PUBKEY = SEGWIT_PUBKEY;
const CHANGE_PATH = "84'/0'/0'/1/0";
// Uncompressed (65-byte) form of the same on-curve point — what Ledger
// `getWalletPublicKey` actually returns. Tests stub the device with this
// to exercise the compress-on-the-way-in path.
const SEGWIT_PUBKEY_UNCOMPRESSED =
  "04a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd" +
  "5b8dec5235a0fa8722476c7709c02559e3aa73aa03918ba2d492eea75abea235";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
// A well-formed P2WPKH derived from a deterministic 20-byte pubkey hash
// (so coin-selection vbyte math matches our roughVbytes estimator —
// P2WSH outputs are 12 vbytes larger and trip the "max" test's
// exact-fit math).
const RECIPIENT = "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu";
const FAKE_TXID =
  "1111111111111111111111111111111111111111111111111111111111111111";
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
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-pr3-"));
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
  // Default: derive a valid prev-tx hex from whichever UTXOs the test
  // most recently registered via getUtxosMock. Tests can override with
  // mockResolvedValueOnce / mockRejectedValueOnce when they need to
  // exercise indexer failure modes.
  getTxHexMock.mockImplementation(async (txid: string) => {
    const lastResult =
      getUtxosMock.mock.results[getUtxosMock.mock.results.length - 1];
    if (!lastResult || lastResult.type !== "return") {
      throw new Error(
        `Test setup error: getTxHex(${txid}) called but no getUtxos mock has run.`,
      );
    }
    const utxos = (await lastResult.value) as Array<{
      txid: string;
      vout: number;
      value: number;
    }>;
    const matching = utxos.find((u) => u.txid === txid);
    if (!matching) {
      throw new Error(
        `Test setup error: no UTXO matches txid ${txid} (have: ${utxos
          .map((u) => u.txid)
          .join(",")}).`,
      );
    }
    return buildPrevTxHex(matching.value, SEGWIT_ADDR, matching.vout);
  });
  const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  const { __clearBitcoinTxStore } = await import(
    "../src/signing/btc-tx-store.js"
  );
  clearPairedBtcAddresses();
  __clearBitcoinTxStore();
  // Pre-pair the segwit address so prepare_btc_send finds it.
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
  // Issue #254: also pre-pair the BIP-32 chain=1 (change) address.
  // `pair_ledger_btc`'s gap-limit scan caches both chains; the modern
  // builder requires a chain=1 entry to construct the change output.
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

describe("buildBitcoinNativeSend", () => {
  it("builds a PSBT, registers a handle, and projects every output", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    getFeeEstimatesMock.mockResolvedValueOnce({
      fastestFee: 20,
      halfHourFee: 10,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
    });
    expect(tx.chain).toBe("bitcoin");
    expect(tx.action).toBe("native_send");
    expect(tx.from).toBe(SEGWIT_ADDR);
    expect(tx.handle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tx.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tx.psbtBase64.length).toBeGreaterThan(0);
    expect(tx.accountPath).toBe("84'/0'/0'");
    expect(tx.addressFormat).toBe("bech32");
    expect(tx.decoded.outputs.length).toBeGreaterThanOrEqual(1);
    const recipientOutput = tx.decoded.outputs.find((o) => o.address === RECIPIENT);
    expect(recipientOutput).toBeDefined();
    expect(recipientOutput?.amountSats).toBe("50000");
    expect(recipientOutput?.amountBtc).toBe("0.0005");
    expect(recipientOutput?.isChange).toBe(false);
    expect(tx.decoded.rbfEligible).toBe(true);
    expect(tx.decoded.feeRateSatPerVb).toBe(10);
    // Issue #213 regression: every input must carry nonWitnessUtxo
    // (full prev-tx hex), or Ledger BTC app 2.x raises "Security risk:
    // unverified inputs" before showing any output details. Decode the
    // PSBT and assert input #0 has both witnessUtxo AND nonWitnessUtxo.
    const psbt = bitcoinjsForFixtures.Psbt.fromBase64(tx.psbtBase64);
    expect(psbt.data.inputs.length).toBe(1);
    expect(psbt.data.inputs[0].witnessUtxo).toBeDefined();
    expect(psbt.data.inputs[0].nonWitnessUtxo).toBeDefined();
    expect((psbt.data.inputs[0].nonWitnessUtxo as Buffer).length).toBeGreaterThan(0);
    expect(getTxHexMock).toHaveBeenCalledWith(FAKE_TXID);
  });

  it("uses an explicit feeRate when passed", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 25,
    });
    expect(tx.decoded.feeRateSatPerVb).toBe(25);
    expect(getFeeEstimatesMock).not.toHaveBeenCalled();
  });

  it("rejects unpaired source addresses", async () => {
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: TAPROOT_ADDR,
        to: RECIPIENT,
        amount: "0.0005",
        feeRateSatPerVb: 10,
      }),
    ).rejects.toThrow(/not paired/);
  });

  it("rejects legacy/p2sh-segwit source addresses (Phase 1 scope)", async () => {
    const { setPairedBtcAddress, clearPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    clearPairedBtcAddresses();
    setPairedBtcAddress({
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      publicKey: SEGWIT_PUBKEY,
      path: "44'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "legacy",
      accountIndex: 0,
    });
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        to: RECIPIENT,
        amount: "0.0005",
        feeRateSatPerVb: 10,
      }),
    ).rejects.toThrow(/not supported in Phase 1/);
  });

  it("rejects when the wallet has no UTXOs", async () => {
    getUtxosMock.mockResolvedValueOnce([]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: SEGWIT_ADDR,
        to: RECIPIENT,
        amount: "0.0005",
        feeRateSatPerVb: 10,
      }),
    ).rejects.toThrow(/No UTXOs/);
  });

  // Issue #254 regression: when the pairings cache has a chain=0 source
  // entry but no chain=1 change entry (= the user paired before any
  // history existed; gap-limit scan skipped chain=1 in that branch),
  // the builder must refuse with a clear "re-pair" message rather than
  // silently fall back to change-on-source.
  it("refuses when the pairings cache has no chain=1 change entry for the account", async () => {
    const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    clearPairedBtcAddresses();
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
    // NOTE: no chain=1 entry inserted — mirrors a fresh-wallet pairing.
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      buildBitcoinNativeSend({
        wallet: SEGWIT_ADDR,
        to: RECIPIENT,
        amount: "0.0005",
        feeRateSatPerVb: 10,
      }),
    ).rejects.toThrow(/No paired chain=1 \(change\) address found.*pair_ledger_btc/s);
  });

  // Issue #254 happy path: the builder routes change to the cached
  // chain=1 address, threads it onto `tx.change`, and stamps the change
  // output's `decoded` projection with `changePath` so the verification
  // block (and second-LLM check) can show the BIP-44 internal-chain
  // derivation that backs the on-screen "Change" label.
  it("routes change to the cached chain=1 address and stamps decoded.outputs.changePath", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 1_000_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.001",
      feeRateSatPerVb: 10,
    });
    expect(tx.change).toEqual({
      address: CHANGE_ADDR,
      path: CHANGE_PATH,
      publicKey: CHANGE_PUBKEY,
    });
    const changeOutput = tx.decoded.outputs.find((o) => o.isChange);
    expect(changeOutput).toBeDefined();
    expect(changeOutput!.address).toBe(CHANGE_ADDR);
    expect(changeOutput!.changePath).toBe(CHANGE_PATH);
    // Recipient output is unaffected.
    const recipientOutput = tx.decoded.outputs.find(
      (o) => o.address === RECIPIENT,
    );
    expect(recipientOutput).toBeDefined();
    expect(recipientOutput!.isChange).toBe(false);
    expect(recipientOutput!.changePath).toBeUndefined();
  });

  it("supports rbf=false (sequence finality)", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 10,
      rbf: false,
    });
    expect(tx.decoded.rbfEligible).toBe(false);
  });

  it("resolves \"max\" to balance minus fee", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 1_000_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "max",
      feeRateSatPerVb: 5,
    });
    // 1_000_000 - fee (~545 sats at 5 sat/vB for one input + one output).
    // The recipient output is the full balance minus fee — there's no
    // change output on a clean exact-fit "max".
    const recipientOutput = tx.decoded.outputs.find((o) => o.address === RECIPIENT);
    expect(recipientOutput).toBeDefined();
    const sats = Number(recipientOutput!.amountSats);
    expect(sats).toBeGreaterThan(998_000);
    expect(sats).toBeLessThan(1_000_000);
    // Fee should be on the order of 5 sat/vB × ~110 vbytes.
    expect(Number(tx.decoded.feeSats)).toBeGreaterThan(0);
    expect(Number(tx.decoded.feeSats)).toBeLessThan(2000);
  });
});

describe("sendBitcoinTransaction", () => {
  it("signs the PSBT on Ledger and broadcasts the raw tx", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
    });
    // Mirror what Ledger BTC v2.4.6 actually returns: SEC1 uncompressed
    // (65 bytes, 0x04 || X || Y). Issue #211 — the signer must compress
    // before threading into knownAddressDerivations or the SDK throws
    // "Invalid pubkey length: 65" before any device prompt.
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: SEGWIT_ADDR,
      publicKey: SEGWIT_PUBKEY_UNCOMPRESSED,
      chainCode: "0".repeat(64),
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
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 10,
    });

    const { sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const result = await sendTransaction({
      handle: tx.handle!,
      confirmed: true,
    });
    expect(result.txHash).toBe(FAKE_BROADCAST_TXID);
    expect(result.chain).toBe("bitcoin");
    expect(broadcastTxMock).toHaveBeenCalledWith(FAKE_RAW_TX_HEX);
    expect(signPsbtBufferMock).toHaveBeenCalledTimes(1);
    const [, options] = signPsbtBufferMock.mock.calls[0];
    expect(options.accountPath).toBe("84'/0'/0'");
    expect(options.addressFormat).toBe("bech32");
    expect(options.finalizePsbt).toBe(true);
    // Issue #206 regression: the SDK keys knownAddressDerivations by the
    // witness-program payload (P2WPKH: 20-byte hash160 from the script's
    // bytes 2..22), NOT sha256(scriptPubKey). The previous sha256 keying
    // never matched at lookup time → derivations stayed empty → Ledger
    // BTC app v2.x rejected with 0x6a80 before any UI.
    const known = options.knownAddressDerivations as Map<
      string,
      { pubkey: Buffer; path: number[] }
    >;
    // Issue #254: the map now carries TWO entries — source (chain=0) and
    // change (chain=1) — so the Ledger BTC app labels the change output
    // as "Change" instead of warning "unusual change path".
    expect(known.size).toBe(2);
    for (const lookupKey of known.keys()) {
      expect(lookupKey).toMatch(/^[0-9a-f]{40}$/);
      expect(lookupKey).not.toMatch(/^[0-9a-f]{64}$/);
    }
    // Find each entry by matching the path's chain segment.
    const entries = [...known.values()];
    const sourceEntry = entries.find(
      (e) => e.path[3] === 0,
    );
    const changeEntry = entries.find((e) => e.path[3] === 1);
    expect(sourceEntry).toBeDefined();
    expect(changeEntry).toBeDefined();
    expect(sourceEntry!.pubkey.toString("hex")).toBe(SEGWIT_PUBKEY);
    // 84'/0'/0'/0/0 — three hardened segments + receive chain + index 0.
    expect(sourceEntry!.path).toEqual([
      (84 | 0x80000000) >>> 0,
      (0 | 0x80000000) >>> 0,
      (0 | 0x80000000) >>> 0,
      0,
      0,
    ]);
    // 84'/0'/0'/1/0 — same shape, change chain. The pubkey we threaded
    // through is the same fixture for simplicity; in production each
    // chain has its own derived leaf pubkey, which the device validates
    // against its own derivation at sign time.
    expect(changeEntry!.path).toEqual([
      (84 | 0x80000000) >>> 0,
      (0 | 0x80000000) >>> 0,
      (0 | 0x80000000) >>> 0,
      1,
      0,
    ]);
  });

  it("refuses to sign when the device derives a different address", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
    });
    // Device returns a DIFFERENT address than the paired one — proof
    // that the seed/app changed under us. Refuse rather than blind-sign.
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: TAPROOT_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });

    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 10,
    });

    const { sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      sendTransaction({
        handle: tx.handle!,
        confirmed: true,
      }),
    ).rejects.toThrow(/derived .* but the prepared tx lists/);
  });
});

// Issue #211 regression. Ledger BTC v2.4.6 returns SEC1-uncompressed
// pubkeys (65 bytes); the SDK's PSBT machinery downstream of
// knownAddressDerivations chokes on anything other than the 33-byte
// compressed form. Verify the compressor in isolation so failures
// surface here instead of as "Invalid pubkey length: 65" mid-flow.
describe("compressPubkey", () => {
  const COMPRESSED =
    "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
  const UNCOMPRESSED =
    "04a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd" +
    "5b8dec5235a0fa8722476c7709c02559e3aa73aa03918ba2d492eea75abea235";
  // Even-Y test vector — secp256k1 generator point G.
  const G_COMPRESSED =
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const G_UNCOMPRESSED =
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
    "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

  it("compresses a 65-byte uncompressed pubkey with odd Y to 0x03 prefix", async () => {
    const { compressPubkey } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const out = compressPubkey(Buffer.from(UNCOMPRESSED, "hex"));
    expect(out.length).toBe(33);
    expect(out.toString("hex")).toBe(COMPRESSED);
  });

  it("compresses a 65-byte uncompressed pubkey with even Y to 0x02 prefix", async () => {
    const { compressPubkey } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const out = compressPubkey(Buffer.from(G_UNCOMPRESSED, "hex"));
    expect(out.toString("hex")).toBe(G_COMPRESSED);
  });

  it("is idempotent on already-compressed input", async () => {
    const { compressPubkey } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const buf = Buffer.from(COMPRESSED, "hex");
    expect(compressPubkey(buf).toString("hex")).toBe(COMPRESSED);
  });

  it("rejects unexpected pubkey shapes", async () => {
    const { compressPubkey } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(() =>
      compressPubkey(Buffer.from("00".repeat(33), "hex")),
    ).toThrow(/Unexpected SEC1 pubkey shape/);
    expect(() => compressPubkey(Buffer.alloc(64))).toThrow(
      /Unexpected SEC1 pubkey shape/,
    );
  });
});

describe("getTransactionStatus(bitcoin)", () => {
  it("reports success with confirmation count for confirmed txs", async () => {
    getTxStatusMock.mockResolvedValueOnce({
      confirmed: true,
      blockHeight: 850_000,
      confirmations: 3,
    });
    const { getTransactionStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const r = await getTransactionStatus({
      chain: "bitcoin",
      txHash: FAKE_BROADCAST_TXID,
    });
    expect(r).toMatchObject({
      chain: "bitcoin",
      status: "success",
      blockNumber: "850000",
      confirmations: 3,
    });
  });

  it("reports pending for in-mempool txs", async () => {
    getTxStatusMock.mockResolvedValueOnce({ confirmed: false });
    const { getTransactionStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const r = await getTransactionStatus({
      chain: "bitcoin",
      txHash: FAKE_BROADCAST_TXID,
    });
    expect(r.status).toBe("pending");
  });

  it("reports unknown when the indexer doesn't know the txid", async () => {
    getTxStatusMock.mockResolvedValueOnce(null);
    const { getTransactionStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const r = await getTransactionStatus({
      chain: "bitcoin",
      txHash: FAKE_BROADCAST_TXID,
    });
    expect(r.status).toBe("unknown");
  });
});

describe("renderBitcoinVerificationBlock", () => {
  it("emits a Markdown-friendly block with every output, fee, and RBF flag", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 10,
    });
    const { renderBitcoinVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderBitcoinVerificationBlock(tx);
    expect(block).toContain("VERIFY BEFORE SIGNING (Bitcoin");
    expect(block).toContain(`Output 1: 0.0005 BTC → ${RECIPIENT}`);
    expect(block).toMatch(/Fee:.*BTC.*sat\/vB/);
    expect(block).toContain("RBF:      enabled");
  });

  // Issue #215 — the agent in a live session wrote multi-file PSBT
  // decode scripts (`/tmp/psbt-verify.cjs` then `cp` into the project
  // tree to find bitcoinjs-lib) before signing. Lock the agent-note
  // that explicitly forbids the pattern so a future doc edit doesn't
  // silently revert.
  it("explicitly tells the agent NOT to write multi-file PSBT decode scripts", async () => {
    getUtxosMock.mockResolvedValueOnce([
      { txid: FAKE_TXID, vout: 0, value: 100_000, unconfirmed: false },
    ]);
    const { buildBitcoinNativeSend } = await import(
      "../src/modules/btc/actions.ts"
    );
    const tx = await buildBitcoinNativeSend({
      wallet: SEGWIT_ADDR,
      to: RECIPIENT,
      amount: "0.0005",
      feeRateSatPerVb: 10,
    });
    const { renderBitcoinVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderBitcoinVerificationBlock(tx);
    expect(block).toMatch(/AGENT NOTE/);
    expect(block).toMatch(/Do NOT decode the PSBT in chat/);
    expect(block).toMatch(/node -e/);
    expect(block).toMatch(/_psbt-verify\.cjs/);
    expect(block).toMatch(/cp/);
    expect(block).toMatch(/device .* (truth|verification)/);
    // The AFTER-BROADCAST mempool.space aside used to live here; it now
    // belongs to renderPostBroadcastBlock so the verification block
    // stays scoped to pre-sign concerns.
    expect(block).not.toContain("AFTER BROADCAST");
    expect(block).not.toContain("mempool.space");
  });
});

describe("Bitcoin post-send blocks", () => {
  // Issue #215 — BTC's ~10-min block time made agent-side polling
  // wasteful (12 min budget covered ~1 block; almost always timed out
  // without a real outcome). The BTC branch in renderPostSendPollBlock
  // must emit a "do NOT poll, end your turn" directive instead.
  it("post-send BTC block tells agent NOT to poll and end the turn", async () => {
    const { renderPostSendPollBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPostSendPollBlock({
      chain: "bitcoin",
      txHash: "a".repeat(64),
    });
    expect(block).toMatch(/AGENT TASK/);
    expect(block).toMatch(/Do NOT call get_transaction_status/);
    expect(block).toMatch(/Do NOT poll/i);
    expect(block).toMatch(/END YOUR TURN/);
    expect(block).not.toMatch(/every ~\d+ seconds/);
    expect(block).not.toMatch(/maxPolls/);
    // The on-demand path is still allowed — surface the exact one-shot
    // call so the agent has it ready when the user asks "did it confirm?".
    expect(block).toMatch(
      new RegExp(`get_transaction_status\\(\\{ chain: "bitcoin", txHash: "${"a".repeat(64)}" \\}\\)`),
    );
  });

  it("post-broadcast BTC block tells the user to check the explorer link later, not wait", async () => {
    const { renderPostBroadcastBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPostBroadcastBlock({
      chain: "bitcoin",
      txHash: "a".repeat(64),
    });
    expect(block).toContain("TRANSACTION BROADCAST");
    expect(block).toContain("mempool.space");
    expect(block).toMatch(/~10 minutes/);
    expect(block).toMatch(/agent will not\s+poll/);
    // EVM-style "agent will report when it confirms" is wrong for BTC —
    // the agent will NOT continue polling, so don't suggest it does.
    expect(block).not.toMatch(/will report .* when it confirms or times out/);
  });
});

describe("coin-select", () => {
  it("rejects invalid feeRate", async () => {
    const { selectInputs } = await import(
      "../src/modules/btc/coin-select.js"
    );
    expect(() =>
      selectInputs({
        utxos: [{ txid: FAKE_TXID, vout: 0, value: 1_000_000 }],
        outputs: [{ address: RECIPIENT, value: 200_000 }],
        feeRate: 0,
        changeAddress: SEGWIT_ADDR,
      }),
    ).toThrow(/Invalid feeRate/);
    expect(() =>
      selectInputs({
        utxos: [{ txid: FAKE_TXID, vout: 0, value: 1_000_000 }],
        outputs: [{ address: RECIPIENT, value: 200_000 }],
        feeRate: 20_000,
        changeAddress: SEGWIT_ADDR,
      }),
    ).toThrow(/Invalid feeRate/);
  });

  it("rejects empty UTXO sets and zero-value outputs", async () => {
    const { selectInputs } = await import(
      "../src/modules/btc/coin-select.js"
    );
    expect(() =>
      selectInputs({
        utxos: [],
        outputs: [{ address: RECIPIENT, value: 200_000 }],
        feeRate: 1,
        changeAddress: SEGWIT_ADDR,
      }),
    ).toThrow(/No UTXOs/);
    expect(() =>
      selectInputs({
        utxos: [{ txid: FAKE_TXID, vout: 0, value: 1_000_000 }],
        outputs: [{ address: RECIPIENT, value: 0 }],
        feeRate: 1,
        changeAddress: SEGWIT_ADDR,
      }),
    ).toThrow(/strictly-positive value/);
  });

  it("returns a feasible selection for a typical tx", async () => {
    const { selectInputs } = await import(
      "../src/modules/btc/coin-select.js"
    );
    const r = selectInputs({
      utxos: [{ txid: FAKE_TXID, vout: 0, value: 1_000_000 }],
      outputs: [{ address: RECIPIENT, value: 200_000 }],
      feeRate: 5,
      changeAddress: SEGWIT_ADDR,
    });
    expect(r.inputs.length).toBe(1);
    expect(r.outputs.length).toBeGreaterThanOrEqual(1);
    // Recipient + change.
    const recipient = r.outputs.find((o) => o.address === RECIPIENT);
    expect(recipient?.value).toBe(200_000);
    expect(r.fee).toBeGreaterThan(0);
  });
});
