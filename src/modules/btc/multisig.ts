import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { HDKey } from "@scure/bip32";
import {
  patchUserConfig,
  readUserConfig,
  getConfigPath,
} from "../../config/user-config.js";
import {
  buildWalletPolicy,
  openLedgerMultisig,
  type BtcMultisigAppClient,
  type BtcMultisigPartialSignature,
} from "../../signing/btc-multisig-usb-loader.js";
import type {
  PairedBitcoinMultisigCosigner,
  PairedBitcoinMultisigWallet,
} from "../../types/index.js";
import { assertCanonicalLedgerApp } from "../../signing/canonical-apps.js";

/**
 * Bitcoin multi-sig co-signer flow. Phase 2 PR2 of the BTC Ledger
 * roadmap. We act as ONE of N signers in a multi-sig wallet — the
 * initiator (Sparrow / Specter / Caravan / a peer running this same
 * server) builds the tx and produces a PSBT; the user passes the PSBT
 * here, this module signs with the Ledger key, returns the partial PSBT
 * for the user to share back. Combination + finalization + broadcast
 * happens externally (deferred to a future PR — PSBT-combine is what
 * external coordinators already do well).
 *
 * Two tools are exposed via this module:
 *   - `register_btc_multisig_wallet` — one-time per setup. Builds a
 *     `wsh(sortedmulti(M, @0/**, @1/**, ...))` descriptor, calls Ledger's
 *     `registerWallet` (the device walks every cosigner xpub fingerprint
 *     on-screen for verification), persists the descriptor + 32-byte
 *     policy HMAC. The HMAC is reused on every subsequent signature
 *     call so the user only walks the descriptor approval flow once
 *     per setup.
 *   - `sign_btc_multisig_psbt` — adds our signature to a multi-sig PSBT.
 *     Looks up the registered wallet by name, decodes the PSBT,
 *     validates inputs/outputs against the policy, calls the device
 *     (the device walks every output address + amount on-screen),
 *     splices our partial signature into the PSBT, returns it.
 *
 * Phase 2 scope: P2WSH (`wsh(sortedmulti(...))`) only. Taproot multi-sig
 * (`tr(multi_a(...))`) and `sh(wsh(...))` wrapped multi-sig are
 * deferred — small audience, distinct script types.
 */

// --- bitcoinjs-lib loader (CommonJS-only) ---------------------------------

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    fromBase64(b64: string): {
      data: {
        inputs: Array<{
          witnessScript?: Buffer;
          bip32Derivation?: Array<{
            masterFingerprint: Buffer;
            pubkey: Buffer;
            path: string;
          }>;
          partialSig?: Array<{ pubkey: Buffer; signature: Buffer }>;
          witnessUtxo?: { script: Buffer; value: number };
          nonWitnessUtxo?: Buffer;
        }>;
        outputs: Array<unknown>;
      };
      txInputs: Array<{ hash: Buffer; index: number; sequence: number }>;
      txOutputs: Array<{ address?: string; value: number }>;
      updateInput(
        i: number,
        update: { partialSig: Array<{ pubkey: Buffer; signature: Buffer }> },
      ): unknown;
      toBase64(): string;
    };
  };
};

// --- Constants ------------------------------------------------------------

/** Ledger BTC app caps wallet-policy names at 16 ASCII bytes. */
const MULTISIG_NAME_MAX_BYTES = 16;
/** Ledger BTC app supports up to 15 cosigners in a wallet policy. */
const MAX_COSIGNERS = 15;
/** Sortedmulti needs at least 1-of-2 (1-of-1 is single-sig with extra steps). */
const MIN_COSIGNERS = 2;

// --- In-memory store + persistence ----------------------------------------

const multisigByName = new Map<string, PairedBitcoinMultisigWallet>();
let multisigHydrated = false;

function ensureMultisigHydrated(): void {
  if (multisigHydrated) return;
  multisigHydrated = true;
  const persisted = readUserConfig()?.pairings?.bitcoinMultisig ?? [];
  for (const entry of persisted) {
    multisigByName.set(entry.name, entry);
  }
}

function persistMultisig(): void {
  patchUserConfig({
    pairings: { bitcoinMultisig: Array.from(multisigByName.values()) },
  });
}

export function getPairedMultisigWallets(): PairedBitcoinMultisigWallet[] {
  ensureMultisigHydrated();
  return Array.from(multisigByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getPairedMultisigByName(
  name: string,
): PairedBitcoinMultisigWallet | null {
  ensureMultisigHydrated();
  return multisigByName.get(name) ?? null;
}

/** Test-only — drops every cached entry. */
export function __clearMultisigStore(): void {
  multisigByName.clear();
  multisigHydrated = false;
  if (existsSync(getConfigPath())) {
    patchUserConfig({ pairings: { bitcoinMultisig: [] } });
  }
}

// --- Validation helpers ---------------------------------------------------

/**
 * Validate a hex-encoded master fingerprint. Ledger surfaces it as 8
 * lowercase hex chars (4 bytes); we accept upper/lower and normalize.
 */
function normalizeMasterFingerprint(raw: string, ctx: string): string {
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{8}$/.test(trimmed)) {
    throw new Error(
      `${ctx}: masterFingerprint "${raw}" is not 8 hex characters (4 bytes).`,
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Validate a BIP-32 derivation path with no leading `m/`. Hardened
 * markers must be `'` (apostrophe), each segment ≤ 2^31 - 1.
 */
function validateDerivationPath(raw: string, ctx: string): void {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${ctx}: derivationPath must be a non-empty string.`);
  }
  if (raw.startsWith("m/") || raw.startsWith("/")) {
    throw new Error(
      `${ctx}: derivationPath must not start with "m/" or "/" — got "${raw}".`,
    );
  }
  for (const seg of raw.split("/")) {
    const stripped = seg.endsWith("'") ? seg.slice(0, -1) : seg;
    if (!/^\d+$/.test(stripped)) {
      throw new Error(
        `${ctx}: derivationPath segment "${seg}" is not a non-negative integer.`,
      );
    }
    const n = Number(stripped);
    if (n < 0 || n >= 0x80000000) {
      throw new Error(
        `${ctx}: derivationPath segment ${seg} is out of range (0..2^31-1).`,
      );
    }
  }
}

/**
 * Round-trip an xpub through `@scure/bip32` to weed out checksum errors.
 * Memory: a typo silently registers a wrong wallet that can never sign,
 * so we want HARD validation here.
 */
function validateXpub(xpub: string, ctx: string): void {
  if (typeof xpub !== "string" || xpub.length === 0) {
    throw new Error(`${ctx}: xpub must be a non-empty string.`);
  }
  try {
    HDKey.fromExtendedKey(xpub);
  } catch (err) {
    throw new Error(
      `${ctx}: xpub failed checksum validation — likely a typo. ` +
        `Original error: ${(err as Error).message}`,
    );
  }
}

/**
 * Format one cosigner's key string for the Ledger BTC app's wallet
 * policy: `[<masterFingerprint>/<derivationPath>]<xpub>`.
 */
function formatPolicyKey(c: PairedBitcoinMultisigCosigner): string {
  return `[${c.masterFingerprint}/${c.derivationPath}]${c.xpub}`;
}

/**
 * Build the descriptor template string for a P2WSH sortedmulti policy:
 * `wsh(sortedmulti(<M>,@0/**,@1/**,...,@{N-1}/**))`.
 */
function buildSortedmultiDescriptor(
  threshold: number,
  cosignerCount: number,
): string {
  const slots = Array.from({ length: cosignerCount }, (_, i) => `@${i}/**`).join(",");
  return `wsh(sortedmulti(${threshold},${slots}))`;
}

// --- register_btc_multisig_wallet ----------------------------------------

export interface RegisterBitcoinMultisigWalletArgs {
  name: string;
  threshold: number;
  cosigners: Array<{
    xpub: string;
    masterFingerprint: string;
    derivationPath: string;
  }>;
  scriptType: "wsh";
}

export interface RegisterBitcoinMultisigWalletResult {
  wallet: PairedBitcoinMultisigWallet;
  /** Ledger app version observed at registration time. */
  appVersion: string;
  /** Index of the user's slot in `cosigners` (0-indexed). */
  ourKeyIndex: number;
}

export async function registerBitcoinMultisigWallet(
  args: RegisterBitcoinMultisigWalletArgs,
): Promise<RegisterBitcoinMultisigWalletResult> {
  // 1. Argument validation — every refusal here is BEFORE we touch the device.
  if (typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("`name` must be a non-empty ASCII string.");
  }
  // ASCII only; the Ledger device limits the on-screen label to 16 BYTES.
  if (!/^[\x20-\x7e]+$/.test(args.name)) {
    throw new Error(
      `\`name\` must be printable ASCII only (got "${args.name}").`,
    );
  }
  if (Buffer.byteLength(args.name, "utf-8") > MULTISIG_NAME_MAX_BYTES) {
    throw new Error(
      `\`name\` is ${Buffer.byteLength(args.name, "utf-8")} bytes — Ledger BTC app caps ` +
        `wallet-policy names at ${MULTISIG_NAME_MAX_BYTES} bytes. Shorten it.`,
    );
  }
  if (args.scriptType !== "wsh") {
    throw new Error(
      `\`scriptType\` "${args.scriptType}" is out of scope — Phase 2 supports "wsh" only ` +
        `(P2WSH native segwit). Taproot and P2SH-wrapped multi-sig are deferred.`,
    );
  }
  if (
    !Number.isInteger(args.threshold) ||
    args.threshold < 1 ||
    args.threshold > MAX_COSIGNERS
  ) {
    throw new Error(
      `\`threshold\` must be an integer between 1 and ${MAX_COSIGNERS} — got ${args.threshold}.`,
    );
  }
  if (!Array.isArray(args.cosigners)) {
    throw new Error("`cosigners` must be an array.");
  }
  if (args.cosigners.length < MIN_COSIGNERS) {
    throw new Error(
      `\`cosigners\` must have at least ${MIN_COSIGNERS} entries (got ${args.cosigners.length}). ` +
        `1-of-1 multi-sig is single-sig with extra steps; use \`prepare_btc_send\` instead.`,
    );
  }
  if (args.cosigners.length > MAX_COSIGNERS) {
    throw new Error(
      `\`cosigners\` has ${args.cosigners.length} entries — Ledger BTC app caps wallet ` +
        `policies at ${MAX_COSIGNERS} keys.`,
    );
  }
  if (args.threshold > args.cosigners.length) {
    throw new Error(
      `\`threshold\` ${args.threshold} exceeds cosigner count ${args.cosigners.length}.`,
    );
  }

  // 2. Validate every cosigner entry; weed out duplicate xpubs (the
  //    Ledger app doesn't allow the same key twice in a policy).
  const seenXpubs = new Set<string>();
  const validatedCosigners: PairedBitcoinMultisigCosigner[] = args.cosigners.map(
    (c, i) => {
      const ctx = `cosigners[${i}]`;
      const masterFingerprint = normalizeMasterFingerprint(c.masterFingerprint, ctx);
      validateDerivationPath(c.derivationPath, ctx);
      validateXpub(c.xpub, ctx);
      if (seenXpubs.has(c.xpub)) {
        throw new Error(
          `${ctx}: xpub appears more than once in \`cosigners\`. Each slot must be a ` +
            `distinct key.`,
        );
      }
      seenXpubs.add(c.xpub);
      return {
        xpub: c.xpub,
        masterFingerprint,
        derivationPath: c.derivationPath,
        isOurs: false, // patched after device probe.
      };
    },
  );

  // 3. Reject duplicate name (would silently overwrite the existing entry).
  ensureMultisigHydrated();
  if (multisigByName.has(args.name)) {
    throw new Error(
      `Multi-sig wallet "${args.name}" is already registered. Pick a different name, ` +
        `or call a (future) \`unregister_btc_multisig_wallet\` first.`,
    );
  }

  // 4. Open the device, identify which cosigner slot is ours, register
  //    the policy. Every device touch lives inside try/finally so we
  //    never leak the HID descriptor on error.
  const { app, transport } = await openLedgerMultisig();
  let result: RegisterBitcoinMultisigWalletResult;
  try {
    const appInfo = await app.getAppAndVersion();
    assertCanonicalLedgerApp({
      reportedName: appInfo.name,
      reportedVersion: appInfo.version,
      expectedNames: ["Bitcoin"],
    });
    const ourFingerprint = (await app.getMasterFingerprint()).toLowerCase();
    const candidates = validatedCosigners.filter(
      (c) => c.masterFingerprint === ourFingerprint,
    );
    if (candidates.length === 0) {
      throw new Error(
        `The connected Ledger's master fingerprint ${ourFingerprint} does not appear in ` +
          `\`cosigners\`. This Ledger is NOT a signer in the proposed wallet — refusing ` +
          `to register a policy we can never sign with.`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `Master fingerprint ${ourFingerprint} appears in multiple \`cosigners\` entries ` +
          `— ambiguous. Each Ledger fingerprint must occupy at most one slot.`,
      );
    }
    const ourEntry = candidates[0];
    // Verify the xpub at the user-supplied derivation path matches the
    // device-derived xpub. Catches typos in the cosigner's xpub field
    // even when fingerprints happen to match (extremely unlikely
    // collision, but cheap to check).
    const deviceXpub = await app.getExtendedPubkey(ourEntry.derivationPath, false);
    if (deviceXpub !== ourEntry.xpub) {
      throw new Error(
        `Cosigner xpub for fingerprint ${ourFingerprint} (path ${ourEntry.derivationPath}) ` +
          `does not match the Ledger-derived xpub. Expected ${deviceXpub}, got ${ourEntry.xpub}. ` +
          `Likely a copy-paste error in the cosigner's xpub field.`,
      );
    }
    const ourKeyIndex = validatedCosigners.indexOf(ourEntry);
    validatedCosigners[ourKeyIndex].isOurs = true;

    // 5. Construct + register the wallet policy.
    const descriptorTemplate = buildSortedmultiDescriptor(
      args.threshold,
      validatedCosigners.length,
    );
    const policyKeys = validatedCosigners.map(formatPolicyKey);
    const walletPolicy = buildWalletPolicy(args.name, descriptorTemplate, policyKeys);
    // The device walks every cosigner xpub fingerprint on-screen. The
    // user MUST verify each fingerprint matches what they expect (this
    // is the moment that anchors the policy — a malicious server could
    // otherwise swap an xpub for one whose private key it controls).
    const [, hmacBuf] = await app.registerWallet(walletPolicy);

    const wallet: PairedBitcoinMultisigWallet = {
      name: args.name,
      threshold: args.threshold,
      totalSigners: validatedCosigners.length,
      scriptType: args.scriptType,
      descriptor: descriptorTemplate,
      cosigners: validatedCosigners,
      policyHmac: hmacBuf.toString("hex"),
      appVersion: appInfo.version,
    };
    multisigByName.set(args.name, wallet);
    persistMultisig();

    result = { wallet, appVersion: appInfo.version, ourKeyIndex };
  } finally {
    await transport.close().catch(() => {});
  }
  return result;
}

// --- sign_btc_multisig_psbt ----------------------------------------------

export interface SignBitcoinMultisigPsbtArgs {
  walletName: string;
  psbtBase64: string;
}

export interface SignBitcoinMultisigPsbtResult {
  partialPsbtBase64: string;
  /** Number of signatures we added (always 1 in this flow). */
  signaturesAdded: number;
  /** Total signatures present after our addition. */
  signaturesPresent: number;
  /** Threshold M from the registered policy. */
  signaturesNeeded: number;
  /** True iff `signaturesPresent >= signaturesNeeded` on every input. */
  fullySigned: boolean;
}

/**
 * Validate that every PSBT input carries a `bip32Derivation` entry
 * matching our master fingerprint. This is the chat-side defense against
 * being tricked into signing for a foreign tx — the device does its own
 * deeper validation against the registered policy, but a mismatch we
 * catch here saves a USB round-trip.
 *
 * NOT a replacement for the device-side check: the user is the final
 * authority via the on-device output walkthrough.
 */
function ensurePsbtMatchesOurKey(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
  ourFingerprint: string,
): void {
  const ourFpBuf = Buffer.from(ourFingerprint, "hex");
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const input = psbt.data.inputs[i];
    const derivations = input.bip32Derivation ?? [];
    const hasOurs = derivations.some(
      (d) => d.masterFingerprint.equals(ourFpBuf),
    );
    if (!hasOurs) {
      throw new Error(
        `PSBT input ${i} has no bip32_derivation entry for our master fingerprint ` +
          `${ourFingerprint}. Either this PSBT belongs to a different wallet (refusing ` +
          `to forward to the device) or the initiator built it without our xpub. ` +
          `Verify the PSBT comes from a coordinator that knows about this Ledger.`,
      );
    }
  }
}

/**
 * Splice ledger-bitcoin's PartialSignature output into the PSBT's
 * input-level partialSig map. P2WSH multisig uses standard ECDSA
 * signatures (NOT taproot), so we drop `tapleafHash` and keep only
 * `{pubkey, signature}`.
 */
function applyPartialSignatures(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
  sigs: Array<[number, BtcMultisigPartialSignature]>,
): number {
  let added = 0;
  for (const [inputIdx, partial] of sigs) {
    if (partial.tapleafHash !== undefined) {
      // Taproot script-path signatures land in `tapScriptSig`, not
      // `partialSig`. Out of scope for Phase 2 (`wsh` only); refusing
      // here surfaces an unexpected device-side response shape rather
      // than silently dropping it.
      throw new Error(
        `Ledger returned a taproot partial signature for input ${inputIdx}, but this ` +
          `flow is P2WSH-only. The registered policy may not match the PSBT — refusing ` +
          `to splice.`,
      );
    }
    psbt.updateInput(inputIdx, {
      partialSig: [{ pubkey: partial.pubkey, signature: partial.signature }],
    });
    added += 1;
  }
  return added;
}

/**
 * For each input, count how many distinct signatures are present (post-
 * splice). Used to derive `signaturesPresent` and `fullySigned`.
 */
function minSignatureCount(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const input of psbt.data.inputs) {
    const count = input.partialSig?.length ?? 0;
    if (count < min) min = count;
  }
  return Number.isFinite(min) ? min : 0;
}

export async function signBitcoinMultisigPsbt(
  args: SignBitcoinMultisigPsbtArgs,
): Promise<SignBitcoinMultisigPsbtResult> {
  if (typeof args.walletName !== "string" || args.walletName.length === 0) {
    throw new Error("`walletName` must be a non-empty string.");
  }
  if (typeof args.psbtBase64 !== "string" || args.psbtBase64.length === 0) {
    throw new Error("`psbtBase64` must be a non-empty base64 string.");
  }

  // 1. Look up the registered wallet.
  ensureMultisigHydrated();
  const wallet = multisigByName.get(args.walletName);
  if (!wallet) {
    const available = Array.from(multisigByName.keys());
    throw new Error(
      `No multi-sig wallet registered under name "${args.walletName}". ` +
        (available.length > 0
          ? `Registered names: ${available.join(", ")}.`
          : `No multi-sig wallets registered yet — call \`register_btc_multisig_wallet\` first.`),
    );
  }

  // 2. Decode the PSBT (validates structure).
  let psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>;
  try {
    psbt = bitcoinjs.Psbt.fromBase64(args.psbtBase64);
  } catch (err) {
    throw new Error(
      `Failed to decode PSBT: ${(err as Error).message}. The input must be a valid ` +
        `base64-encoded PSBT v0.`,
    );
  }
  if (psbt.data.inputs.length === 0) {
    throw new Error("PSBT has no inputs — refusing to sign.");
  }

  // 3. Re-build the wallet policy from the persisted descriptor + keys.
  const policyKeys = wallet.cosigners.map(formatPolicyKey);
  const walletPolicy = buildWalletPolicy(
    wallet.name,
    wallet.descriptor,
    policyKeys,
  );
  const policyHmac = Buffer.from(wallet.policyHmac, "hex");

  // 4. Open device, validate PSBT shape against our key, sign.
  const { app, transport } = await openLedgerMultisig();
  let result: SignBitcoinMultisigPsbtResult;
  try {
    const appInfo = await app.getAppAndVersion();
    assertCanonicalLedgerApp({
      reportedName: appInfo.name,
      reportedVersion: appInfo.version,
      expectedNames: ["Bitcoin"],
    });
    const deviceFingerprint = (await app.getMasterFingerprint()).toLowerCase();
    const ourCosigner = wallet.cosigners.find((c) => c.isOurs);
    if (!ourCosigner) {
      throw new Error(
        `Internal error: registered wallet "${wallet.name}" has no cosigner flagged ` +
          `\`isOurs\`. Re-register via \`register_btc_multisig_wallet\`.`,
      );
    }
    if (deviceFingerprint !== ourCosigner.masterFingerprint) {
      throw new Error(
        `Connected Ledger's master fingerprint ${deviceFingerprint} does not match the ` +
          `fingerprint stored for "${wallet.name}" (${ourCosigner.masterFingerprint}). ` +
          `Either the wrong Ledger is plugged in, or the registered wallet was created ` +
          `with a different device — refusing to forward the PSBT.`,
      );
    }
    ensurePsbtMatchesOurKey(psbt, deviceFingerprint);

    // The device walks every output address + amount on-screen. The
    // user MUST verify each output matches the rendered verification
    // block before approving.
    const partialSigs = await app.signPsbt(args.psbtBase64, walletPolicy, policyHmac);
    if (partialSigs.length === 0) {
      throw new Error(
        `Ledger returned zero partial signatures for "${wallet.name}". The device may ` +
          `have been unable to find a derivation path matching our key on any input.`,
      );
    }
    const added = applyPartialSignatures(psbt, partialSigs);
    const signaturesPresent = minSignatureCount(psbt);
    result = {
      partialPsbtBase64: psbt.toBase64(),
      signaturesAdded: added,
      signaturesPresent,
      signaturesNeeded: wallet.threshold,
      fullySigned: signaturesPresent >= wallet.threshold,
    };
  } finally {
    await transport.close().catch(() => {});
  }
  return result;
}
