import { createRequire } from "node:module";
import { getBitcoinIndexer } from "./indexer.js";

/**
 * PSBT combine + finalize for the multi-sig flows. Phase 3 PR1 of the
 * BTC Ledger roadmap.
 *
 * `combinePsbts` merges partial PSBTs from M cosigners into one whose
 * inputs carry every cosigner's signature. `finalizePsbt` consumes a
 * combined PSBT, validates every input has reached its threshold,
 * extracts the broadcast-ready tx hex, and optionally broadcasts via
 * the indexer.
 *
 * Both tools are bitcoinjs-lib wrappers — the heavy lifting is in
 * `Psbt.combine(...)` and `Psbt.finalizeAllInputs()`. We add three
 * things:
 *   1. Defense against being tricked into combining PSBTs with
 *      different unsigned-tx bodies (an honest mistake or an attack
 *      that swaps the recipient).
 *   2. A clear per-input breakdown when finalize fails because the
 *      threshold isn't met.
 *   3. Optional indexer broadcast routing — finalize-and-broadcast in
 *      one call when the user is the M-th signer.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    fromBase64(b64: string): {
      data: {
        inputs: Array<{
          partialSig?: Array<{ pubkey: Buffer; signature: Buffer }>;
          tapScriptSig?: Array<{ pubkey: Buffer; signature: Buffer; leafHash: Buffer }>;
          tapKeySig?: Buffer;
          witnessScript?: Buffer;
          finalScriptSig?: Buffer;
          finalScriptWitness?: Buffer;
        }>;
      };
      txInputs: Array<{ hash: Buffer; index: number; sequence: number }>;
      txOutputs: Array<{ address?: string; value: number; script: Buffer }>;
      combine(...others: Array<unknown>): unknown;
      finalizeAllInputs(): unknown;
      extractTransaction(disableFeeCheck?: boolean): {
        toHex(): string;
        getId(): string;
        virtualSize(): number;
      };
      toBase64(): string;
    };
  };
};

// --- Helpers -------------------------------------------------------------

/**
 * The "unsigned tx body" that two PSBTs must agree on to be combinable:
 * inputs (txid + vout + sequence) and outputs (script + value). Witness
 * data is per-cosigner and explicitly differs across PSBTs — that's the
 * whole point of combining.
 */
function unsignedBodyFingerprint(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
): string {
  const inputs = psbt.txInputs
    .map(
      (i) =>
        `${Buffer.from(i.hash).reverse().toString("hex")}:${i.index}:${i.sequence}`,
    )
    .join(",");
  const outputs = psbt.txOutputs
    .map((o) => `${o.script.toString("hex")}:${o.value}`)
    .join(",");
  return `${inputs}|${outputs}`;
}

/** Count signatures present on an input (post-combine, pre-finalize). */
function countSignatures(input: {
  partialSig?: Array<unknown>;
  tapScriptSig?: Array<unknown>;
  tapKeySig?: Buffer;
}): number {
  let n = 0;
  if (input.partialSig) n += input.partialSig.length;
  if (input.tapScriptSig) n += input.tapScriptSig.length;
  if (input.tapKeySig) n += 1;
  return n;
}

/**
 * Best-effort threshold extraction from a witnessScript (P2WSH
 * sortedmulti). The script's first byte is `OP_M` where M = byte - 80,
 * for OP_1..OP_16 (0x51..0x60). Returns `null` for taproot inputs (the
 * threshold lives in the leaf script — taproot finalization is bitcoinjs's
 * job, not ours; we surface present-count only).
 */
function inferP2wshThreshold(witnessScript: Buffer | undefined): number | null {
  if (!witnessScript || witnessScript.length === 0) return null;
  const opcode = witnessScript[0];
  if (opcode >= 0x51 && opcode <= 0x60) return opcode - 0x50;
  return null;
}

// --- combine_btc_psbts ---------------------------------------------------

export interface CombineBtcPsbtsArgs {
  psbts: string[];
}

export interface CombineBtcPsbtsResult {
  combinedPsbtBase64: string;
  /** Number of input PSBTs combined. */
  psbtCount: number;
  /** Per-input signature count after the combine. */
  signaturesPerInput: number[];
}

export function combinePsbts(args: CombineBtcPsbtsArgs): CombineBtcPsbtsResult {
  if (!Array.isArray(args.psbts) || args.psbts.length < 2) {
    throw new Error(
      `\`psbts\` must be an array of at least 2 PSBTs (got ${args.psbts?.length ?? 0}).`,
    );
  }
  const decoded = args.psbts.map((b64, idx) => {
    try {
      return bitcoinjs.Psbt.fromBase64(b64);
    } catch (err) {
      throw new Error(
        `psbts[${idx}] failed to decode: ${(err as Error).message}. Each entry must ` +
          `be a valid base64-encoded PSBT v0.`,
      );
    }
  });
  const baseline = unsignedBodyFingerprint(decoded[0]);
  for (let i = 1; i < decoded.length; i++) {
    const fp = unsignedBodyFingerprint(decoded[i]);
    if (fp !== baseline) {
      throw new Error(
        `psbts[${i}] has a different unsigned tx body than psbts[0]. Combining PSBTs ` +
          `from different unsigned txs would silently merge signatures across distinct ` +
          `transactions — refusing. Confirm every cosigner started from the same ` +
          `coordinator-issued PSBT.`,
      );
    }
  }
  // bitcoinjs-lib's combine mutates the receiver in-place; the order
  // matters when there are conflicts (the receiver wins). Use a fresh
  // copy of psbt[0] as the receiver so we don't mutate the caller's
  // input. fromBase64 already gave us a fresh object — combine the rest in.
  const combined = decoded[0];
  for (let i = 1; i < decoded.length; i++) {
    combined.combine(decoded[i]);
  }
  const signaturesPerInput = combined.data.inputs.map((input) =>
    countSignatures(input),
  );
  return {
    combinedPsbtBase64: combined.toBase64(),
    psbtCount: args.psbts.length,
    signaturesPerInput,
  };
}

// --- finalize_btc_psbt ---------------------------------------------------

export interface FinalizeBtcPsbtArgs {
  psbtBase64: string;
  /** Optional: broadcast via the configured indexer after finalization. */
  broadcast?: boolean;
}

export interface FinalizeBtcPsbtResult {
  /** Hex-encoded fully-signed tx, ready to broadcast. */
  txHex: string;
  /** 64-hex transaction id (sha256d(tx) reversed). */
  txid: string;
  /** Tx vsize (vbytes), useful for fee-rate post-checks. */
  vsize: number;
  /**
   * Set when `broadcast: true` and the indexer accepted the tx —
   * matches `txid` on success. Undefined when `broadcast` was false or
   * when the broadcast call itself threw (the throw propagates; we
   * don't swallow).
   */
  broadcastedTxid?: string;
}

export async function finalizePsbt(
  args: FinalizeBtcPsbtArgs,
): Promise<FinalizeBtcPsbtResult> {
  if (typeof args.psbtBase64 !== "string" || args.psbtBase64.length === 0) {
    throw new Error("`psbtBase64` must be a non-empty base64 string.");
  }
  let psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>;
  try {
    psbt = bitcoinjs.Psbt.fromBase64(args.psbtBase64);
  } catch (err) {
    throw new Error(`Failed to decode PSBT: ${(err as Error).message}`);
  }
  // Per-input pre-flight: surface a useful error BEFORE bitcoinjs's
  // generic "Cannot finalize input X" exception.
  const underSigned: Array<{ index: number; have: number; need: number | null }> = [];
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const input = psbt.data.inputs[i];
    if (input.finalScriptSig || input.finalScriptWitness) continue; // already finalized
    const have = countSignatures(input);
    const need = inferP2wshThreshold(input.witnessScript);
    if (need !== null && have < need) {
      underSigned.push({ index: i, have, need });
    }
  }
  if (underSigned.length > 0) {
    const lines = underSigned.map(
      (u) => `  • input ${u.index}: ${u.have}/${u.need ?? "?"} signatures`,
    );
    throw new Error(
      `Cannot finalize — some inputs are below their threshold:\n${lines.join("\n")}\n\n` +
        `Gather the remaining signatures (combine via \`combine_btc_psbts\`) before ` +
        `retrying \`finalize_btc_psbt\`.`,
    );
  }

  // Finalize only inputs that aren't already finalized — calling
  // `finalizeAllInputs()` blanket on a PSBT whose inputs already carry
  // `finalScriptWitness` re-runs the finalizer and crashes (bitcoinjs
  // doesn't have an idempotent guard there).
  const needsFinalize = psbt.data.inputs.some(
    (input) => !input.finalScriptSig && !input.finalScriptWitness,
  );
  if (needsFinalize) {
    try {
      psbt.finalizeAllInputs();
    } catch (err) {
      throw new Error(
        `bitcoinjs-lib refused to finalize: ${(err as Error).message}. The signatures ` +
          `present may not satisfy the script (wrong pubkeys, malformed sigs, or a ` +
          `script type bitcoinjs does not auto-finalize).`,
      );
    }
  }
  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();
  const txid = tx.getId();
  const vsize = tx.virtualSize();

  let broadcastedTxid: string | undefined;
  if (args.broadcast === true) {
    const indexer = getBitcoinIndexer();
    broadcastedTxid = await indexer.broadcastTx(txHex);
  }

  return {
    txHex,
    txid,
    vsize,
    ...(broadcastedTxid !== undefined ? { broadcastedTxid } : {}),
  };
}
