import { randomUUID } from "node:crypto";
import type { UnsignedTronTx } from "../types/index.js";

/**
 * In-memory registry of prepared TRON transactions. Parallel to
 * signing/tx-store.ts but stores `UnsignedTronTx` rather than EVM
 * `UnsignedTx`. Separated deliberately: the EVM send flow runs an
 * eth_call re-simulation, chain-id check, and spender allowlist that are
 * all meaningless on TRON. A TRON handle therefore cannot be consumed by
 * the EVM `send_transaction` — the two stores share no keys and the TRON
 * send path (Phase 3, USB HID) will have its own security pipeline.
 *
 * Lifetime matches the EVM store (15 min from issue).
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredTx {
  tx: UnsignedTronTx;
  expiresAt: number;
}

const store = new Map<string, StoredTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

export function issueTronHandle(tx: UnsignedTronTx): UnsignedTronTx {
  prune();
  const handle = randomUUID();
  const withHandle: UnsignedTronTx = { ...tx, handle };
  const { handle: _h, ...stored } = withHandle;
  store.set(handle, { tx: stored as UnsignedTronTx, expiresAt: Date.now() + TX_TTL_MS });
  return withHandle;
}

export function consumeTronHandle(handle: string): UnsignedTronTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired TRON tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_tron_* tool for a fresh handle.`
    );
  }
  return entry.tx;
}

export function retireTronHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasTronHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}
