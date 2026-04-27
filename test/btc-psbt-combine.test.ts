import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";

/**
 * PR1 — combine_btc_psbts + finalize_btc_psbt. No device touch; pure
 * bitcoinjs-lib wrapper tests with a mocked indexer for the broadcast
 * path.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    new (opts?: { network?: unknown }): {
      addInput(input: {
        hash: string | Buffer;
        index: number;
        sequence?: number;
        witnessUtxo?: { script: Buffer; value: number };
        witnessScript?: Buffer;
        bip32Derivation?: Array<{
          masterFingerprint: Buffer;
          pubkey: Buffer;
          path: string;
        }>;
      }): unknown;
      addOutput(output: { address?: string; script?: Buffer; value: number }): unknown;
      updateInput(
        i: number,
        update: {
          partialSig?: Array<{ pubkey: Buffer; signature: Buffer }>;
        },
      ): unknown;
      toBase64(): string;
    };
    fromBase64(b64: string): {
      data: { inputs: Array<{ partialSig?: Array<unknown> }> };
      txOutputs: Array<{ address?: string; value: number }>;
    };
  };
  payments: {
    p2wsh(opts: { redeem: { output: Buffer } }): { output?: Buffer };
  };
  script: { compile(chunks: Array<number | Buffer>): Buffer };
  opcodes: { OP_2: number; OP_3: number; OP_CHECKMULTISIG: number };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

const broadcastTxMock = vi.fn();
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    broadcastTx: broadcastTxMock,
    getUtxos: vi.fn(),
    getFeeEstimates: vi.fn(),
    getTxStatus: vi.fn(),
    getTxHex: vi.fn(),
    getTx: vi.fn(),
  }),
  resetBitcoinIndexer: () => {},
}));

beforeEach(() => {
  broadcastTxMock.mockReset();
});

// --- PSBT fixture builders ----------------------------------------------

function deriveCosigner(seed: string) {
  const seedBuf = Buffer.alloc(64);
  Buffer.from(seed.padEnd(64, "x")).copy(seedBuf);
  const master = HDKey.fromMasterSeed(seedBuf);
  const account = master.derive("m/48'/0'/0'/2'");
  const child = account.derive("m/0/0");
  if (!child.publicKey) throw new Error("derive failed");
  const fp = master.fingerprint;
  const masterFingerprint = Buffer.alloc(4);
  masterFingerprint.writeUInt32BE(fp, 0);
  return {
    masterFingerprint,
    pubkey: Buffer.from(child.publicKey),
  };
}

/**
 * Build a 2-of-3 P2WSH PSBT skeleton (no signatures yet). Returns the
 * base64 plus the cosigner pubkeys in sorted order so tests can splice
 * partial sigs.
 */
function buildSkeletonPsbt(): {
  psbtBase64: string;
  sortedPubkeys: Buffer[];
  witnessScript: Buffer;
} {
  const cosignerA = deriveCosigner("alice");
  const cosignerB = deriveCosigner("bob");
  const cosignerC = deriveCosigner("carol");
  const pubs = [cosignerA.pubkey, cosignerB.pubkey, cosignerC.pubkey];
  const sortedPubkeys = [...pubs].sort(Buffer.compare);
  const witnessScript = bitcoinjs.script.compile([
    bitcoinjs.opcodes.OP_2,
    ...sortedPubkeys,
    bitcoinjs.opcodes.OP_3,
    bitcoinjs.opcodes.OP_CHECKMULTISIG,
  ]);
  const p2wsh = bitcoinjs.payments.p2wsh({ redeem: { output: witnessScript } });
  if (!p2wsh.output) throw new Error("p2wsh output missing");
  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  psbt.addInput({
    hash: Buffer.alloc(32, 0xab),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: p2wsh.output, value: 100_000_000 },
    witnessScript,
  });
  psbt.addOutput({
    address: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
    value: 50_000_000,
  });
  return { psbtBase64: psbt.toBase64(), sortedPubkeys, witnessScript };
}

/**
 * Minimal valid DER-encoded ECDSA signature with SIGHASH_ALL byte.
 * bitcoinjs-lib's PSBT validator runs `isDerSigWithSighash`, so we
 * construct one with rLen=1, sLen=1.
 */
function fakeDerSig(rByte: number, sByte: number): Buffer {
  return Buffer.from([0x30, 0x06, 0x02, 0x01, rByte, 0x02, 0x01, sByte, 0x01]);
}

/**
 * Take a skeleton PSBT and splice in ONE partial sig at the given pubkey.
 */
function withPartialSig(
  psbtBase64: string,
  pubkey: Buffer,
  sig: Buffer,
): string {
  const psbt = bitcoinjs.Psbt.fromBase64(psbtBase64) as unknown as {
    updateInput(
      i: number,
      update: { partialSig: Array<{ pubkey: Buffer; signature: Buffer }> },
    ): unknown;
    toBase64(): string;
  };
  psbt.updateInput(0, { partialSig: [{ pubkey, signature: sig }] });
  return psbt.toBase64();
}

// --- combinePsbts --------------------------------------------------------

describe("combinePsbts", () => {
  it("merges two partial PSBTs into one carrying both signatures", async () => {
    const skel = buildSkeletonPsbt();
    const psbtA = withPartialSig(skel.psbtBase64, skel.sortedPubkeys[0], fakeDerSig(1, 1));
    const psbtB = withPartialSig(skel.psbtBase64, skel.sortedPubkeys[1], fakeDerSig(2, 2));
    const { combinePsbts } = await import("../src/modules/btc/psbt-combine.ts");
    const result = combinePsbts({ psbts: [psbtA, psbtB] });
    expect(result.psbtCount).toBe(2);
    expect(result.signaturesPerInput).toEqual([2]);
    const decoded = bitcoinjs.Psbt.fromBase64(result.combinedPsbtBase64);
    expect(decoded.data.inputs[0].partialSig?.length).toBe(2);
  });

  it("refuses when PSBTs have different unsigned tx bodies", async () => {
    const skelA = buildSkeletonPsbt();
    // Build a second skeleton with a DIFFERENT recipient (different output script).
    const cosignerA = deriveCosigner("alice");
    const cosignerB = deriveCosigner("bob");
    const cosignerC = deriveCosigner("carol");
    const sortedPubkeys = [cosignerA.pubkey, cosignerB.pubkey, cosignerC.pubkey].sort(Buffer.compare);
    const witnessScript = bitcoinjs.script.compile([
      bitcoinjs.opcodes.OP_2,
      ...sortedPubkeys,
      bitcoinjs.opcodes.OP_3,
      bitcoinjs.opcodes.OP_CHECKMULTISIG,
    ]);
    const p2wsh = bitcoinjs.payments.p2wsh({ redeem: { output: witnessScript } });
    if (!p2wsh.output) throw new Error("p2wsh output missing");
    const evil = new bitcoinjs.Psbt({ network: NETWORK });
    evil.addInput({
      hash: Buffer.alloc(32, 0xab),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wsh.output, value: 100_000_000 },
      witnessScript,
    });
    // Different recipient address → different output script.
    evil.addOutput({
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      value: 50_000_000,
    });
    const psbtA = withPartialSig(skelA.psbtBase64, skelA.sortedPubkeys[0], fakeDerSig(1, 1));
    const psbtEvil = withPartialSig(evil.toBase64(), sortedPubkeys[1], fakeDerSig(2, 2));
    const { combinePsbts } = await import("../src/modules/btc/psbt-combine.ts");
    expect(() => combinePsbts({ psbts: [psbtA, psbtEvil] })).toThrow(
      /different unsigned tx body/,
    );
  });

  it("refuses on fewer than 2 PSBTs", async () => {
    const { combinePsbts } = await import("../src/modules/btc/psbt-combine.ts");
    expect(() => combinePsbts({ psbts: ["only-one"] })).toThrow(/at least 2 PSBTs/);
  });

  it("refuses on a malformed PSBT entry", async () => {
    const skel = buildSkeletonPsbt();
    const { combinePsbts } = await import("../src/modules/btc/psbt-combine.ts");
    expect(() =>
      combinePsbts({ psbts: [skel.psbtBase64, "totally-not-a-psbt"] }),
    ).toThrow(/failed to decode/);
  });
});

// --- finalizePsbt --------------------------------------------------------

describe("finalizePsbt", () => {
  it("refuses with per-input breakdown when threshold not met", async () => {
    const skel = buildSkeletonPsbt();
    // Only one signature on a 2-of-3 wallet — under-signed.
    const psbtA = withPartialSig(skel.psbtBase64, skel.sortedPubkeys[0], fakeDerSig(1, 1));
    const { finalizePsbt } = await import("../src/modules/btc/psbt-combine.ts");
    await expect(finalizePsbt({ psbtBase64: psbtA })).rejects.toThrow(
      /input 0: 1\/2 signatures/,
    );
  });

  it("rejects malformed PSBT", async () => {
    const { finalizePsbt } = await import("../src/modules/btc/psbt-combine.ts");
    await expect(finalizePsbt({ psbtBase64: "not-base64" })).rejects.toThrow(
      /Failed to decode/,
    );
  });

  /**
   * Build a P2WPKH PSBT and pre-finalize input 0 by injecting
   * `finalScriptWitness` directly. Lets us exercise `extractTransaction`
   * + the broadcast path without producing a real ECDSA sig (the local
   * tiny-secp256k1 / ecpair version skew makes ECPair signing unusable
   * in tests).
   */
  function buildPreFinalizedPsbt(): string {
    const dummyPubkey = Buffer.alloc(33, 0x02);
    const pay = (
      bitcoinjs as unknown as {
        payments: {
          p2wpkh(opts: { pubkey: Buffer; network: unknown }): { output?: Buffer; address?: string };
        };
      }
    ).payments.p2wpkh({ pubkey: dummyPubkey, network: NETWORK });
    if (!pay.output || !pay.address) throw new Error("p2wpkh build failed");
    const psbt = new bitcoinjs.Psbt({ network: NETWORK });
    psbt.addInput({
      hash: Buffer.alloc(32, 0xcd),
      index: 0,
      witnessUtxo: { script: pay.output, value: 100_000 },
    });
    psbt.addOutput({ address: pay.address, value: 50_000 });
    // Inject finalScriptWitness directly: a fake DER sig + dummy pubkey
    // is enough for `extractTransaction` to assemble the witness stack.
    // bitcoinjs's `extractTransaction` doesn't re-validate.
    const fakeSigDer = Buffer.from([
      0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01,
    ]);
    // BIP-141 witness encoding: count(2) || len-prefixed item || len-prefixed item.
    const witness = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from([fakeSigDer.length]),
      fakeSigDer,
      Buffer.from([dummyPubkey.length]),
      dummyPubkey,
    ]);
    (psbt as unknown as {
      data: { inputs: Array<{ finalScriptWitness?: Buffer }> };
    }).data.inputs[0].finalScriptWitness = witness;
    return psbt.toBase64();
  }

  it("forwards to indexer when broadcast: true", async () => {
    const psbtBase64 = buildPreFinalizedPsbt();
    broadcastTxMock.mockResolvedValueOnce("abcdef".repeat(10) + "1234");
    const { finalizePsbt } = await import("../src/modules/btc/psbt-combine.ts");
    const result = await finalizePsbt({ psbtBase64, broadcast: true });
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.vsize).toBeGreaterThan(0);
    expect(result.broadcastedTxid).toBe("abcdef".repeat(10) + "1234");
    expect(broadcastTxMock).toHaveBeenCalledWith(result.txHex);
  });

  it("does not broadcast when broadcast: false (default)", async () => {
    const psbtBase64 = buildPreFinalizedPsbt();
    const { finalizePsbt } = await import("../src/modules/btc/psbt-combine.ts");
    const result = await finalizePsbt({ psbtBase64 });
    expect(result.txHex.length).toBeGreaterThan(0);
    expect(result.broadcastedTxid).toBeUndefined();
    expect(broadcastTxMock).not.toHaveBeenCalled();
  });
});
