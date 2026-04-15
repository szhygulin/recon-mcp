import { randomUUID } from "node:crypto";
import type { UnsignedTx } from "../types/index.js";
import { buildVerification } from "./verification.js";

/**
 * In-memory registry of prepared transactions keyed by an opaque handle.
 *
 * Purpose: bind `send_transaction` to the exact tx built by a `prepare_*` tool.
 * Without this, `send_transaction` accepts raw calldata — a prompt-injected
 * agent (e.g. via a malicious Etherscan source comment or ENS reverse record)
 * could convince the model to sign arbitrary bytes while the user thinks they
 * approved the previewed tx.
 *
 * Each prepared tx and every node in its `.next` chain gets its own handle.
 * The signing path looks up by handle and refuses anything not in the store.
 *
 * Lifetime: 15 minutes from issue, enough for a user to review and approve on
 * their Ledger. Expired entries are lazily pruned on every access.
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredTx {
  tx: UnsignedTx;
  expiresAt: number;
}

const store = new Map<string, StoredTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

/**
 * Recursively assign handles to `tx` and every node in its `.next` chain.
 * Returns a new tx tree with `handle` populated on each node.
 *
 * Each handle stores ONLY the one tx node it names — not the full chain.
 * The agent must call `send_transaction` once per handle, walking the chain
 * explicitly. This makes every signature an independent, auditable event.
 */
export function issueHandles(tx: UnsignedTx): UnsignedTx {
  prune();
  const now = Date.now();
  const expiresAt = now + TX_TTL_MS;

  const nextWithHandles = tx.next ? issueHandles(tx.next) : undefined;
  const handle = randomUUID();
  // Stamp verification metadata unconditionally — every tx carries a
  // payloadHash, a swiss-knife decoder URL (when calldata fits), and a
  // local decode. The send-time guard in execution/index.ts re-hashes the
  // exact bytes handed to WalletConnect and asserts equality with this
  // `verification.payloadHash`, giving the user end-to-end certainty that
  // what they preview is what they sign.
  const verification = tx.verification ?? buildVerification(tx);
  const withHandle: UnsignedTx = {
    ...tx,
    handle,
    verification,
    ...(nextWithHandles ? { next: nextWithHandles } : {}),
  };
  // Store a copy without `handle` on the stored value itself (not needed at
  // lookup time) to avoid the tautology of storing the key inside the value.
  const { handle: _h, next: _n, ...stored } = withHandle;
  store.set(handle, {
    tx: { ...stored, ...(nextWithHandles ? { next: nextWithHandles } : {}) },
    expiresAt,
  });
  return withHandle;
}

/**
 * Retrieve the tx named by `handle`, or throw if unknown/expired. Does NOT
 * delete the entry — we need retry-on-device-disconnect to work, so the handle
 * stays valid until either:
 *   (a) the tx is successfully submitted to the relay (caller invokes
 *       `retireHandle` after the WalletConnect request resolves), or
 *   (b) the TTL expires.
 * Callers must call `retireHandle(handle)` on successful submission so replays
 * fail loudly instead of silently re-submitting the same payload.
 */
export function consumeHandle(handle: string): UnsignedTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired tx handle. Prepared transactions expire after 15 minutes and ` +
        `are single-use after a successful submission. Re-run the prepare_* tool to get a fresh handle.`
    );
  }
  return entry.tx;
}

/**
 * Mark a handle as used. Called after the tx has been successfully submitted
 * so the same handle cannot replay the submission. Safe to call on a handle
 * that was already pruned.
 */
export function retireHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}
