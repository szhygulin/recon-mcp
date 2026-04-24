import { randomUUID } from "node:crypto";
import {
  Message,
  MessageV0,
  VersionedMessage,
  type AddressLookupTableAccount,
  type PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
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
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay";
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
  /**
   * Durable-nonce metadata for txs that use ix[0] = nonceAdvance. Present
   * on `native_send` / `spl_send` / `nonce_close` (all of which self-
   * protect with the existing nonce account); absent on `nonce_init` (the
   * create-nonce tx has no nonce to consume yet — uses a regular recent
   * blockhash one time only).
   *
   * The `value` field is what pinSolanaHandle writes into the message's
   * `recentBlockhash` field — not a network blockhash, but the current
   * on-chain nonce value. Agave detects the durable-nonce tx via ix[0]
   * and validates this field against the nonce account's state.
   */
  nonce?: {
    account: string;
    authority: string;
    value: string;
  };
  /**
   * Bank addresses (base58) the MarginFi risk engine will cross-check on
   * this tx — the target action bank PLUS every bank with an active balance
   * on the user's MarginfiAccount. Stamped at prepare time so
   * `preview_solana_send` can diagnose `RiskEngineInitRejected` (Anchor
   * error 6009) without re-deriving the account's balance set (issue #116).
   *
   * Absent on non-MarginFi actions. A present-but-empty array means the
   * builder saw zero active balances + target (shouldn't happen; treated
   * as "diagnosis N/A").
   */
  marginfiTouchedBanks?: string[];
  /**
   * Switchboard oracle feeds that were cranked as part of this tx —
   * populated when `prepare_marginfi_*` detects any touched
   * SwitchboardPull bank and auto-prepends `createUpdateFeedIx`
   * instructions (issue #116 ask C). Empty array means the check ran
   * but nothing needed cranking; absent means the builder skipped
   * the check (non-MarginFi action).
   */
  marginfiOracleCranks?: {
    oracles: string[];
    instructionCount: number;
  };
  /**
   * Fast-retry descriptor — present only when `buildMarginfiBorrow` /
   * `buildMarginfiRepay` detected a recent approved-and-oracle-transient-
   * failed prior attempt for the exact same (wallet, action, accountIndex,
   * bank, mint, amount) tuple. When set, `previewSolanaSend` renders the
   * abridged CHECKS template instead of the full decode-narrative block.
   *
   * The abridge is a user-consented UX trade-off for the Switchboard crank
   * flake case only: Switchboard oracle rotations (error 6030/6039) can
   * flake a borrow/repay 2–3 times in a row on a tx whose semantic meaning
   * the user already approved on-device. Forcing the full decode every
   * retry is pure attention tax — the pair-consistency Ledger-hash check
   * stays mandatory to anchor the bytes the Ledger will sign.
   */
  fastRetry?: {
    priorLedgerHash: string;
    approvedAt: number;
    transientReason:
      | "NotEnoughSamples"
      | "InvalidSlotNumber"
      | "RotatingMegaSlot";
    priorDecodedArgs: Record<string, string>;
  };
}

/**
 * A Solana tx draft awaiting a blockhash pin.
 *
 * Message-format discriminated union: `kind: "legacy"` for `new Transaction()`
 * (the Phase 1/2 shape), `kind: "v0"` for `VersionedMessage` / `MessageV0`
 * (Phase 3 onward). The store doesn't care which; `pinSolanaHandle` branches
 * on the discriminant to pick the right serialize path. Neither variant
 * carries a blockhash at draft time — that gets set by `preview_solana_send`
 * right before signing.
 *
 * Jupiter returns a ready-made v0 tx; Kamino/MarginFi sometimes need ALTs
 * too. Legacy Transaction has no ALT support, so those flows MUST use the
 * v0 variant. Existing native_send / spl_send / nonce_init / nonce_close
 * can stay legacy — they all fit comfortably under the 35-account legacy
 * limit.
 */
export interface SolanaLegacyDraft {
  kind: "legacy";
  draftTx: Transaction;
  meta: SolanaDraftMeta;
}

export interface SolanaV0Draft {
  kind: "v0";
  payerKey: PublicKey;
  instructions: TransactionInstruction[];
  /**
   * ALT accounts the v0 message references (if any). Empty array is fine —
   * a v0 message without lookups is still valid and distinguishable from
   * legacy by the `0x80` version prefix.
   */
  addressLookupTableAccounts: AddressLookupTableAccount[];
  meta: SolanaDraftMeta;
}

export type SolanaTxDraft = SolanaLegacyDraft | SolanaV0Draft;

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
 * Pin a draft with the given fresh blockhash (or current nonce value, for
 * durable-nonce txs). Serializes the message bytes, computes the
 * verification bundle (including the base58(sha256(…)) that the Ledger
 * Solana app displays on blind-sign), and stores the result so
 * `send_transaction` can consume it. Re-callable — a second `preview_solana_send`
 * on the same handle just re-pins with a fresher blockhash/nonce value
 * (replacing the earlier pinned form).
 *
 * For durable-nonce txs (`meta.nonce` present), the caller should pass the
 * current nonce value as `freshBlockhash` AND have already updated
 * `meta.nonce.value` to match — we assert the two agree, catching caller
 * bugs where preview forgot to refresh one or the other. For `nonce_init`
 * (the only non-nonce-protected tx in the current scheme), `freshBlockhash`
 * is a real network blockhash fetched via `getLatestBlockhash`.
 */
export function pinSolanaHandle(
  handle: string,
  freshBlockhash: string,
  lastValidBlockHeight?: number,
): UnsignedSolanaTx {
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle '${handle}'. Re-run the prepare_solana_* tool.`,
    );
  }
  const meta = entry.draft.meta;
  if (meta.nonce && meta.nonce.value !== freshBlockhash) {
    throw new Error(
      `pinSolanaHandle consistency check failed: meta.nonce.value='${meta.nonce.value}' ` +
        `does not match passed freshBlockhash='${freshBlockhash}'. The preview handler must ` +
        `refresh both in lockstep — pass the just-fetched nonce value as freshBlockhash and ` +
        `update meta.nonce.value to the same string before calling pin.`,
    );
  }

  // Serialize the message bytes. Legacy and v0 take different paths —
  // legacy mutates `draftTx.recentBlockhash` then calls `serializeMessage()`;
  // v0 compiles a fresh MessageV0 with the blockhash/nonce baked in and
  // then calls `serialize()`. Either way the downstream consumer (Ledger
  // signer, broadcast path) sees an opaque `messageBase64` and doesn't
  // need to care which version produced it.
  let messageBytes: Buffer;
  if (entry.draft.kind === "legacy") {
    entry.draft.draftTx.recentBlockhash = freshBlockhash;
    messageBytes = entry.draft.draftTx.serializeMessage();
  } else {
    const msg = MessageV0.compile({
      payerKey: entry.draft.payerKey,
      instructions: entry.draft.instructions,
      recentBlockhash: freshBlockhash,
      addressLookupTableAccounts: entry.draft.addressLookupTableAccounts,
    });
    messageBytes = Buffer.from(msg.serialize());
  }
  const messageBase64 = messageBytes.toString("base64");

  // Pre-compute program IDs in the pinned message when fast-retry is set —
  // the abridged CHECKS template renders a whitelist assertion and the
  // agent visually compares against the allowed set. For the v0 path,
  // programIdIndex references the STATIC account keys (pre-ALT-resolve),
  // which is exactly what we want: all non-user programs (MarginFi,
  // Switchboard, System, ComputeBudget, Secp256k1, AToken, Token) are in
  // the static section — ALTs carry token accounts, not program IDs.
  let programIdsInMessage: string[] | undefined;
  if (meta.fastRetry) {
    if (messageBytes[0]! & 0x80) {
      const msg = VersionedMessage.deserialize(messageBytes);
      const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
      const ids = new Set<string>();
      for (const ix of msg.compiledInstructions) {
        const id = staticKeys[ix.programIdIndex];
        if (id) ids.add(id);
      }
      programIdsInMessage = [...ids];
    } else {
      const msg = Message.from(messageBytes);
      const keys = msg.accountKeys.map((k) => k.toBase58());
      const ids = new Set<string>();
      for (const ix of msg.instructions) {
        const id = keys[ix.programIdIndex];
        if (id) ids.add(id);
      }
      programIdsInMessage = [...ids];
    }
  }

  const pinnedBase: UnsignedSolanaTx = {
    chain: "solana",
    action: meta.action,
    from: meta.from,
    messageBase64,
    recentBlockhash: freshBlockhash,
    description: meta.description,
    decoded: meta.decoded,
    handle,
    // lastValidBlockHeight is meaningless for durable-nonce txs (they
    // never expire via block-height) — only carry it through when meta
    // indicates this is a legacy-blockhash tx.
    ...(lastValidBlockHeight !== undefined && !meta.nonce
      ? { lastValidBlockHeight }
      : {}),
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
    ...(meta.nonce ? { nonce: { ...meta.nonce } } : {}),
    ...(meta.fastRetry ? { fastRetry: { ...meta.fastRetry } } : {}),
    ...(programIdsInMessage ? { programIdsInMessage } : {}),
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

// ----- MarginFi fast-retry approval cache -----

/**
 * The subset of a MarginFi action's identity used to key the approval cache.
 * Matches the six user-visible dimensions that uniquely identify the op:
 * same wallet, same direction (borrow/repay), same MarginfiAccount PDA
 * (via accountIndex), same bank, same mint, same amount. Any difference in
 * these six fields is treated as a semantically-different tx and the cache
 * misses (full CHECKS path runs).
 */
export interface ApprovalKeyFields {
  wallet: string;
  action: "marginfi_borrow" | "marginfi_repay";
  accountIndex: number;
  bank: string;
  mint: string;
  /** Exact canonical decimal string (BigNumber.toFixed()). */
  amount: string;
}

/**
 * Record of a same-op Ledger approval the user performed in-process. The
 * `approvedAt` timestamp gates TTL; `ledgerHash` is surfaced on the retry's
 * advisory line so the user can see which prior on-device approval is being
 * referenced. `decodedArgs` is the snapshot of the approved tx's decoded
 * args (from its `meta.decoded.args`) — used for the abridged-template
 * semantic-diff check on retry.
 */
export interface ApprovedMarginfiOp {
  key: ApprovalKeyFields;
  ledgerHash: string;
  approvedAt: number;
  decodedArgs: Record<string, string>;
}

/**
 * Classification of the most recent failure seen for a given approved op.
 * Only `oracle-transient` unlocks the abridged-checks retry path — any
 * other failure kind (hard revert, user rejection, RPC error, unknown)
 * falls back to the full-CHECKS default on the next prepare.
 */
export interface MarginfiFailureRecord {
  kind: "oracle-transient" | "other";
  reason: string;
  failedAt: number;
}

const APPROVAL_TTL_MS = 15 * 60_000;

interface ApprovalEntry {
  approval: ApprovedMarginfiOp;
  lastFailure?: MarginfiFailureRecord;
  expiresAt: number;
}

const approvalCache = new Map<string, ApprovalEntry>();

function approvalKey(fields: ApprovalKeyFields): string {
  return [
    fields.wallet,
    fields.action,
    String(fields.accountIndex),
    fields.bank,
    fields.mint,
    fields.amount,
  ].join("|");
}

function pruneApprovals(now = Date.now()): void {
  for (const [k, entry] of approvalCache) {
    if (entry.expiresAt < now) approvalCache.delete(k);
  }
}

/**
 * Record that the user physically approved a same-op tx at the Ledger. Called
 * from `send_transaction` the instant the device returns a signature — BEFORE
 * broadcast, since user-at-device consent is independent of any downstream
 * broadcast outcome. A same-op re-prepare within TTL + (later) transient-
 * oracle failure classification is what unlocks the abridged path.
 */
export function recordMarginfiApproval(op: ApprovedMarginfiOp): void {
  pruneApprovals();
  const k = approvalKey(op.key);
  const existing = approvalCache.get(k);
  approvalCache.set(k, {
    approval: op,
    ...(existing?.lastFailure ? { lastFailure: existing.lastFailure } : {}),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
  });
}

/**
 * Record the most recent failure classification for a same-op descriptor.
 * Called from the broadcast / preview failure paths after the oracle-vs-
 * other classifier runs. Idempotent overwrite — the freshest failure wins.
 * If no prior approval exists in the cache, this is a no-op (fast-retry
 * requires A ∧ B; without an approval, (A) never holds).
 */
export function recordMarginfiFailure(
  fields: ApprovalKeyFields,
  failure: MarginfiFailureRecord,
): void {
  pruneApprovals();
  const k = approvalKey(fields);
  const existing = approvalCache.get(k);
  if (!existing) return;
  approvalCache.set(k, { ...existing, lastFailure: failure });
}

/**
 * Look up a same-op approval + last-failure state. Returns `null` when
 * the cache has nothing for this descriptor, or when the approval has
 * expired. Eligibility for fast-retry is computed at the call site —
 * typically `approval && lastFailure?.kind === "oracle-transient"`.
 */
export function findMarginfiApproval(
  fields: ApprovalKeyFields,
): { approval: ApprovedMarginfiOp; lastFailure?: MarginfiFailureRecord } | null {
  pruneApprovals();
  const k = approvalKey(fields);
  const entry = approvalCache.get(k);
  if (!entry) return null;
  return {
    approval: entry.approval,
    ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
  };
}

/** Test-only: clear the approval cache between tests. */
export function __clearMarginfiApprovalCache(): void {
  approvalCache.clear();
}
