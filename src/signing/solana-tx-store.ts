import { randomUUID } from "node:crypto";
import type { Transaction } from "@solana/web3.js";
import type { UnsignedSolanaTx } from "../types/index.js";
import { buildSolanaVerification } from "./verification.js";

/**
 * In-memory registry of prepared Solana transactions. Two-phase: `prepare_*`
 * stores a DRAFT (instruction list + fee payer, no blockhash), and
 * `preview_solana_send` later PINS the draft with a fresh blockhash and
 * serialized message bytes. `send_transaction` only accepts pinned handles.
 *
 * The split exists because Solana blockhashes expire after ~150 blocks (~60s)
 * and the prepare → CHECKS → user-approve → broadcast round-trip on a live
 * Ledger routinely runs 90+ seconds. Fetching the blockhash at prepare time
 * burned the full validity window before the device ever prompted. Pinning
 * right before broadcast gives the user a full ~60s window from seeing the
 * hash on-device to the network accepting the tx.
 *
 * Parallel to `signing/tron-tx-store.ts` and `signing/tx-store.ts` —
 * `send_transaction` routes by which store owns the handle, so Solana
 * handles flow through the USB HID Solana signer and never touch the EVM
 * pipeline or the TRON signer.
 *
 * Lifetime: 15 minutes from issue. A pinned message's on-chain validity is
 * still bounded by the baked blockhash (~60s); re-calling preview_solana_send
 * on a stale pinned handle simply re-pins with a fresh blockhash.
 */
const TX_TTL_MS = 15 * 60_000;

/**
 * Metadata about a draft Solana tx that isn't part of the draft's
 * instruction list itself — description, decoded args, fee estimate, rent
 * cost, etc. Mirrors the non-message fields of `UnsignedSolanaTx`.
 */
export interface SolanaDraftMeta {
  action: "native_send" | "spl_send";
  from: string;
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  rentLamports?: number;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  estimatedFeeLamports?: number;
}

/**
 * A Solana tx draft awaiting a blockhash pin. `draftTx` carries the
 * instruction list + fee payer but no `recentBlockhash` — that gets set
 * by `preview_solana_send` right before serialization.
 */
export interface SolanaTxDraft {
  draftTx: Transaction;
  meta: SolanaDraftMeta;
}

interface StoredSolanaTx {
  draft: SolanaTxDraft;
  /** Present only after `pinSolanaHandle`. `send_transaction` requires it. */
  pinned?: UnsignedSolanaTx;
  expiresAt: number;
}

const store = new Map<string, StoredSolanaTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

/**
 * Register a prepared Solana tx draft. Returns the handle that callers
 * pass back to `preview_solana_send` to pin a fresh blockhash and to
 * `send_transaction` to sign + broadcast.
 */
export function issueSolanaDraftHandle(draft: SolanaTxDraft): { handle: string } {
  prune();
  const handle = randomUUID();
  store.set(handle, {
    draft,
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return { handle };
}

/**
 * Look up the draft for `handle`. Used by `preview_solana_send` to
 * re-serialize with a fresh blockhash. Throws for unknown / expired
 * handles (same TTL semantics as the pinned path).
 */
export function getSolanaDraft(handle: string): SolanaTxDraft {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle. Prepared transactions expire after 15 minutes. ` +
        `Re-run the prepare_solana_* tool for a fresh handle.`,
    );
  }
  return entry.draft;
}

/**
 * Pin a draft with the given fresh blockhash. Serializes the message bytes,
 * computes the verification bundle (including the base58(sha256(…)) that
 * the Ledger Solana app displays on blind-sign), and stores the result so
 * `send_transaction` can consume it. Re-callable — a second `preview_solana_send`
 * on the same handle just re-pins with an even fresher blockhash (replacing
 * the earlier pinned form).
 */
export function pinSolanaHandle(
  handle: string,
  freshBlockhash: string,
): UnsignedSolanaTx {
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle '${handle}'. Re-run the prepare_solana_* tool.`,
    );
  }
  const { draftTx } = entry.draft;
  draftTx.recentBlockhash = freshBlockhash;
  const messageBytes = draftTx.serializeMessage();
  const messageBase64 = messageBytes.toString("base64");

  const meta = entry.draft.meta;
  const pinnedBase: UnsignedSolanaTx = {
    chain: "solana",
    action: meta.action,
    from: meta.from,
    messageBase64,
    recentBlockhash: freshBlockhash,
    description: meta.description,
    decoded: meta.decoded,
    handle,
    ...(meta.rentLamports !== undefined ? { rentLamports: meta.rentLamports } : {}),
    ...(meta.priorityFeeMicroLamports !== undefined
      ? { priorityFeeMicroLamports: meta.priorityFeeMicroLamports }
      : {}),
    ...(meta.computeUnitLimit !== undefined
      ? { computeUnitLimit: meta.computeUnitLimit }
      : {}),
    ...(meta.estimatedFeeLamports !== undefined
      ? { estimatedFeeLamports: meta.estimatedFeeLamports }
      : {}),
  };
  const verification = buildSolanaVerification(pinnedBase);
  const pinned: UnsignedSolanaTx = { ...pinnedBase, verification };
  entry.pinned = pinned;
  return pinned;
}

/**
 * Retrieve the pinned tx for `handle`, or throw if the caller skipped
 * `preview_solana_send` (handle exists but has no blockhash pinned yet) or
 * if the handle is unknown / expired. Called by the Solana branch of
 * `send_transaction`. Does NOT delete the entry — the retire call at the
 * end of a successful broadcast handles that.
 */
export function consumeSolanaHandle(handle: string): UnsignedSolanaTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_solana_* tool for a fresh handle.`,
    );
  }
  if (!entry.pinned) {
    throw new Error(
      `Solana tx handle '${handle}' has not been pinned yet. Call preview_solana_send(handle) ` +
        `first — it fetches a fresh blockhash, serializes the message, and emits the Message Hash ` +
        `for the user to match on-device. send_transaction cannot run without a pin.`,
    );
  }
  return entry.pinned;
}

export function retireSolanaHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasSolanaHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}

/** Test-only: true if `handle` has been pinned (preview_solana_send called). */
export function isSolanaHandlePinned(handle: string): boolean {
  prune();
  const entry = store.get(handle);
  return entry?.pinned != null;
}
