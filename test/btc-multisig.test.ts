import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Tests for the BTC multi-sig co-signer flow:
 *   - register_btc_multisig_wallet
 *   - sign_btc_multisig_psbt
 *
 * The `ledger-bitcoin` AppClient is mocked via `btc-multisig-usb-loader.js`
 * (vi.mock at the loader level so the SDK is never loaded). PSBT
 * construction uses real bitcoinjs-lib so the round-trip exercises the
 * actual partialSig splicing path.
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
      toBase64(): string;
    };
    fromBase64(b64: string): {
      data: { inputs: Array<{ partialSig?: Array<{ pubkey: Buffer; signature: Buffer }> }> };
    };
  };
  address: {
    toOutputScript(addr: string, network?: unknown): Buffer;
  };
  payments: {
    p2wsh(opts: { redeem: { output: Buffer } }): { output?: Buffer; address?: string };
  };
  script: {
    compile(chunks: Array<number | Buffer>): Buffer;
  };
  opcodes: { OP_2: number; OP_3: number; OP_CHECKMULTISIG: number };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

// --- Mocked AppClient + transport ----------------------------------------

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

// --- Helpers for deterministic xpubs + multisig PSBT ---------------------

/**
 * Derive a deterministic mainnet xpub from a seed string. Different
 * seeds produce different cosigner identities. Returns the xpub string,
 * 4-byte master fingerprint hex, and the HDKey for child derivation in
 * sign tests.
 */
function makeCosigner(seed: string) {
  const seedBuf = Buffer.alloc(64);
  Buffer.from(seed.padEnd(64, "x")).copy(seedBuf);
  const master = HDKey.fromMasterSeed(seedBuf);
  // BIP-48 P2WSH multisig: m/48'/0'/0'/2'
  const account = master.derive("m/48'/0'/0'/2'");
  const xpub = account.publicExtendedKey;
  // master fingerprint = first 4 bytes of HASH160(masterPubkey).
  // @scure/bip32's HDKey exposes `fingerprint` on each derived key
  // (=4-byte fingerprint of the PARENT). The master's own fingerprint
  // is HDKey's `parentFingerprint` of its first child, but easier: use
  // the library's `master.fingerprint` for the master itself.
  const fp = master.fingerprint;
  const masterFingerprint = Buffer.alloc(4);
  masterFingerprint.writeUInt32BE(fp, 0);
  return {
    xpub,
    masterFingerprint: masterFingerprint.toString("hex"),
    accountKey: account,
    masterKey: master,
  };
}

function deriveChildPubkey(account: HDKey, change: number, index: number): Buffer {
  const child = account.derive(`m/${change}/${index}`);
  if (!child.publicKey) throw new Error("derive failed");
  return Buffer.from(child.publicKey);
}

/**
 * Build a 2-of-3 P2WSH multisig PSBT with one input (1.0 BTC) and one
 * external output (0.5 BTC). The witnessScript + bip32Derivation are
 * populated so `sign_btc_multisig_psbt`'s shape validation passes.
 */
function buildMultisigPsbt(
  cosigners: ReturnType<typeof makeCosigner>[],
  ourFingerprintHex: string,
): string {
  // Sort pubkeys lexicographically (sortedmulti requirement).
  const change = 0;
  const addressIndex = 0;
  const childPubkeys = cosigners.map((c) => deriveChildPubkey(c.accountKey, change, addressIndex));
  const sortedPubkeys = [...childPubkeys].sort(Buffer.compare);
  const witnessScript = bitcoinjs.script.compile([
    bitcoinjs.opcodes.OP_2,
    ...sortedPubkeys,
    bitcoinjs.opcodes.OP_3,
    bitcoinjs.opcodes.OP_CHECKMULTISIG,
  ]);
  const p2wsh = bitcoinjs.payments.p2wsh({ redeem: { output: witnessScript } });
  const scriptPubKey = p2wsh.output;
  if (!scriptPubKey) throw new Error("p2wsh output missing");

  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  // Fake prev-tx hash; only the PSBT shape matters for the unit test.
  const prevHash = Buffer.alloc(32, 0xab);
  const bip32Derivation = cosigners.map((c, idx) => {
    const fp = Buffer.from(c.masterFingerprint, "hex");
    return {
      masterFingerprint: fp,
      pubkey: childPubkeys[idx],
      path: `m/48'/0'/0'/2'/${change}/${addressIndex}`,
    };
  });
  psbt.addInput({
    hash: prevHash,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: scriptPubKey, value: 100_000_000 },
    witnessScript,
    bip32Derivation,
  });
  // External recipient — real mainnet address is fine.
  psbt.addOutput({
    address: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
    value: 50_000_000,
  });
  void ourFingerprintHex; // referenced in callers for clarity
  return psbt.toBase64();
}

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-multisig-"));
  setConfigDirForTesting(tmpHome);
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

describe("registerBitcoinMultisigWallet", () => {
  it("registers a 2-of-3 P2WSH wallet, persists the policy + HMAC", async () => {
    const a = makeCosigner("alice");
    const b = makeCosigner("bob");
    const c = makeCosigner("carol");
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    getExtendedPubkeyMock.mockResolvedValueOnce(a.xpub);
    registerWalletMock.mockResolvedValueOnce([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);

    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await registerBitcoinMultisigWallet({
      name: "Family vault",
      threshold: 2,
      cosigners: [
        { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: c.xpub, masterFingerprint: c.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
      ],
      scriptType: "wsh",
    });
    expect(result.wallet.name).toBe("Family vault");
    expect(result.wallet.threshold).toBe(2);
    expect(result.wallet.totalSigners).toBe(3);
    expect(result.wallet.descriptor).toBe("wsh(sortedmulti(2,@0/**,@1/**,@2/**))");
    expect(result.wallet.policyHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(result.wallet.appVersion).toBe("2.4.6");
    expect(result.ourKeyIndex).toBe(0);
    expect(result.wallet.cosigners[0].isOurs).toBe(true);
    expect(result.wallet.cosigners[1].isOurs).toBe(false);
    expect(result.wallet.cosigners[2].isOurs).toBe(false);
    expect(transportCloseMock).toHaveBeenCalled();
    // Persisted across module reload.
    const { getPairedMultisigByName } = await import(
      "../src/modules/btc/multisig.js"
    );
    expect(getPairedMultisigByName("Family vault")?.policyHmac).toBe(
      result.wallet.policyHmac,
    );
  });

  it("refuses when the connected Ledger's fingerprint is not in cosigners", async () => {
    const a = makeCosigner("alice");
    const b = makeCosigner("bob");
    const stranger = makeCosigner("stranger");
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(stranger.masterFingerprint);

    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      registerBitcoinMultisigWallet({
        name: "Foreign vault",
        threshold: 2,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
          { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        ],
        scriptType: "wsh",
      }),
    ).rejects.toThrow(/does not appear in `cosigners`/);
    expect(registerWalletMock).not.toHaveBeenCalled();
  });

  it("refuses duplicate wallet name", async () => {
    const a = makeCosigner("alice");
    const b = makeCosigner("bob");
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6", flags: 0 });
    getMasterFingerprintMock.mockResolvedValue(a.masterFingerprint);
    getExtendedPubkeyMock.mockResolvedValue(a.xpub);
    registerWalletMock.mockResolvedValue([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);

    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await registerBitcoinMultisigWallet({
      name: "Vault",
      threshold: 2,
      cosigners: [
        { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
      ],
      scriptType: "wsh",
    });
    await expect(
      registerBitcoinMultisigWallet({
        name: "Vault",
        threshold: 2,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
          { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        ],
        scriptType: "wsh",
      }),
    ).rejects.toThrow(/already registered/);
  });

  it("refuses an xpub that fails checksum validation", async () => {
    const a = makeCosigner("alice");
    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      registerBitcoinMultisigWallet({
        name: "Bad",
        threshold: 2,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
          {
            xpub: "xpubGARBAGE_NOT_REAL",
            masterFingerprint: "deadbeef",
            derivationPath: "48'/0'/0'/2'",
          },
        ],
        scriptType: "wsh",
      }),
    ).rejects.toThrow(/checksum validation/);
  });

  it("refuses 1-of-1 (out of scope — use prepare_btc_send)", async () => {
    const a = makeCosigner("alice");
    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      registerBitcoinMultisigWallet({
        name: "Solo",
        threshold: 1,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        ],
        scriptType: "wsh",
      }),
    ).rejects.toThrow(/at least 2 entries/);
  });

  it("refuses when name exceeds 16 bytes", async () => {
    const a = makeCosigner("alice");
    const b = makeCosigner("bob");
    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      registerBitcoinMultisigWallet({
        name: "A name that is way too long",
        threshold: 2,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
          { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        ],
        scriptType: "wsh",
      }),
    ).rejects.toThrow(/16 bytes/);
  });
});

describe("signBitcoinMultisigPsbt", () => {
  /** Register a 2-of-3 wallet with `alice` as our key, return cosigners. */
  async function registerVault() {
    const a = makeCosigner("alice");
    const b = makeCosigner("bob");
    const c = makeCosigner("carol");
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    getExtendedPubkeyMock.mockResolvedValueOnce(a.xpub);
    registerWalletMock.mockResolvedValueOnce([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);
    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await registerBitcoinMultisigWallet({
      name: "Vault",
      threshold: 2,
      cosigners: [
        { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: c.xpub, masterFingerprint: c.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
      ],
      scriptType: "wsh",
    });
    return [a, b, c] as const;
  }

  it("signs a multi-sig PSBT and splices our partial signature", async () => {
    const [a, b, c] = await registerVault();
    const psbtBase64 = buildMultisigPsbt([a, b, c], a.masterFingerprint);

    // Reset for the sign call.
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    // Mock signPsbt: return a partial signature for input 0.
    const ourPubkey = deriveChildPubkey(a.accountKey, 0, 0);
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: ourPubkey,
          // Minimal valid DER-encoded ECDSA sig with SIGHASH_ALL byte.
          // bip174's partialSig validator runs `isDerSigWithSighash` so
          // we can't use a placeholder here.
          signature: Buffer.from([
            0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01,
          ]),
        },
      ],
    ]);

    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    const result = await signBitcoinMultisigPsbt({
      walletName: "Vault",
      psbtBase64,
    });
    expect(result.signaturesAdded).toBe(1);
    expect(result.signaturesPresent).toBe(1);
    expect(result.signaturesNeeded).toBe(2);
    expect(result.fullySigned).toBe(false);
    // The returned PSBT decodes and carries our partial signature on input 0.
    const decoded = bitcoinjs.Psbt.fromBase64(result.partialPsbtBase64);
    expect(decoded.data.inputs[0].partialSig?.length).toBe(1);
    expect(decoded.data.inputs[0].partialSig?.[0].pubkey.equals(ourPubkey)).toBe(true);
  });

  it("flags fullySigned when our sig completes the threshold", async () => {
    const [a, b, c] = await registerVault();
    // Build PSBT with one pre-existing partial sig (from cosigner B);
    // our signature pushes it to 2-of-3.
    const psbt = new bitcoinjs.Psbt({ network: NETWORK });
    const change = 0;
    const idx = 0;
    const childPubkeys = [a, b, c].map((co) => deriveChildPubkey(co.accountKey, change, idx));
    const sortedPubkeys = [...childPubkeys].sort(Buffer.compare);
    const witnessScript = bitcoinjs.script.compile([
      bitcoinjs.opcodes.OP_2,
      ...sortedPubkeys,
      bitcoinjs.opcodes.OP_3,
      bitcoinjs.opcodes.OP_CHECKMULTISIG,
    ]);
    const p2wsh = bitcoinjs.payments.p2wsh({ redeem: { output: witnessScript } });
    const scriptPubKey = p2wsh.output;
    if (!scriptPubKey) throw new Error("scriptPubKey missing");
    psbt.addInput({
      hash: Buffer.alloc(32, 0xab),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: scriptPubKey, value: 100_000_000 },
      witnessScript,
      bip32Derivation: [a, b, c].map((co, i) => ({
        masterFingerprint: Buffer.from(co.masterFingerprint, "hex"),
        pubkey: childPubkeys[i],
        path: `m/48'/0'/0'/2'/${change}/${idx}`,
      })),
    });
    psbt.addOutput({
      address: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
      value: 50_000_000,
    });
    // Splice cosigner B's signature in directly. We use bitcoinjs's
    // updateInput shape via the PSBT parser path: re-load the PSBT and
    // hand-mutate.
    const reloaded = bitcoinjs.Psbt.fromBase64(psbt.toBase64()) as unknown as {
      updateInput(
        i: number,
        update: { partialSig: Array<{ pubkey: Buffer; signature: Buffer }> },
      ): unknown;
      toBase64(): string;
    };
    reloaded.updateInput(0, {
      partialSig: [
        {
          pubkey: childPubkeys[1],
          signature: Buffer.from([
            0x30, 0x06, 0x02, 0x01, 0x02, 0x02, 0x01, 0x02, 0x01,
          ]),
        },
      ],
    });
    const psbtBase64 = reloaded.toBase64();

    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: childPubkeys[0],
          signature: Buffer.from([
            0x30, 0x06, 0x02, 0x01, 0x03, 0x02, 0x01, 0x03, 0x01,
          ]),
        },
      ],
    ]);
    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    const result = await signBitcoinMultisigPsbt({
      walletName: "Vault",
      psbtBase64,
    });
    expect(result.signaturesPresent).toBe(2);
    expect(result.signaturesNeeded).toBe(2);
    expect(result.fullySigned).toBe(true);
  });

  it("refuses when the PSBT has no bip32_derivation for our key", async () => {
    const [a, b, c] = await registerVault();
    // Build a PSBT whose bip32_derivation lists ONLY b and c — not us.
    const psbt = new bitcoinjs.Psbt({ network: NETWORK });
    const childPubkeys = [a, b, c].map((co) => deriveChildPubkey(co.accountKey, 0, 0));
    const sortedPubkeys = [...childPubkeys].sort(Buffer.compare);
    const witnessScript = bitcoinjs.script.compile([
      bitcoinjs.opcodes.OP_2,
      ...sortedPubkeys,
      bitcoinjs.opcodes.OP_3,
      bitcoinjs.opcodes.OP_CHECKMULTISIG,
    ]);
    const p2wsh = bitcoinjs.payments.p2wsh({ redeem: { output: witnessScript } });
    psbt.addInput({
      hash: Buffer.alloc(32, 0xab),
      index: 0,
      witnessUtxo: { script: p2wsh.output!, value: 100_000_000 },
      witnessScript,
      bip32Derivation: [
        {
          masterFingerprint: Buffer.from(b.masterFingerprint, "hex"),
          pubkey: childPubkeys[1],
          path: "m/48'/0'/0'/2'/0/0",
        },
        {
          masterFingerprint: Buffer.from(c.masterFingerprint, "hex"),
          pubkey: childPubkeys[2],
          path: "m/48'/0'/0'/2'/0/0",
        },
      ],
    });
    psbt.addOutput({
      address: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
      value: 50_000_000,
    });
    const psbtBase64 = psbt.toBase64();

    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    await expect(
      signBitcoinMultisigPsbt({ walletName: "Vault", psbtBase64 }),
    ).rejects.toThrow(/no bip32_derivation entry for our master fingerprint/);
    expect(signPsbtMock).not.toHaveBeenCalled();
  });

  it("refuses when wallet name isn't registered", async () => {
    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    await expect(
      signBitcoinMultisigPsbt({
        walletName: "Unknown",
        psbtBase64: "cHNidP8BAFICAAAAAQ==",
      }),
    ).rejects.toThrow(/No multi-sig wallet registered/);
  });

  it("refuses when the device fingerprint differs from the registered one", async () => {
    const [a, b, c] = await registerVault();
    const psbtBase64 = buildMultisigPsbt([a, b, c], a.masterFingerprint);
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    // Different Ledger plugged in.
    getMasterFingerprintMock.mockResolvedValueOnce("ffffffff");
    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    await expect(
      signBitcoinMultisigPsbt({ walletName: "Vault", psbtBase64 }),
    ).rejects.toThrow(/does not match the fingerprint stored/);
  });

  it("refuses when the wrong Ledger app is open", async () => {
    const [a, b, c] = await registerVault();
    const psbtBase64 = buildMultisigPsbt([a, b, c], a.masterFingerprint);
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Ethereum",
      version: "1.10.0",
      flags: 0,
    });
    const { signBitcoinMultisigPsbt } = await import("../src/modules/btc/multisig.js");
    await expect(
      signBitcoinMultisigPsbt({ walletName: "Vault", psbtBase64 }),
    ).rejects.toThrow(/not a known Ledger app/);
  });
});
