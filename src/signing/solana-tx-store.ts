import { randomUUID } from "node:crypto";
import type { UnsignedSolanaTx } from "../types/index.js";
import { buildSolanaVerification } from "./verification.js";

/**
 * In-memory registry of prepared Solana transactions. Parallel to
 * `signing/tron-tx-store.ts` and `signing/tx-store.ts`. Separated
 * deliberately: `send_transaction` routes by which store owns the handle,
 * so Solana handles flow through the USB HID Solana signer and never
 * touch the EVM pipeline (WalletConnect, eth_call re-sim, chain-id check)
 * or the TRON signer.
 *
 * Lifetime: 15 minutes from issue (same as EVM/TRON). A Solana tx message
 * bakes the recent blockhash and is only valid for ~150 blocks (~60s), so
 * the handle TTL is actually much longer than the on-chain validity window
 * — the practical expiry is the blockhash, not the handle.
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredTx {
  tx: UnsignedSolanaTx;
  expiresAt: number;
}

const store = new Map<string, StoredTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

export function issueSolanaHandle(tx: UnsignedSolanaTx): UnsignedSolanaTx {
  prune();
  const handle = randomUUID();
  const verification = tx.verification ?? buildSolanaVerification(tx);
  const withHandle: UnsignedSolanaTx = { ...tx, handle, verification };
  const { handle: _h, ...stored } = withHandle;
  store.set(handle, {
    tx: stored as UnsignedSolanaTx,
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return withHandle;
}

export function consumeSolanaHandle(handle: string): UnsignedSolanaTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_solana_* tool for a fresh handle. ` +
        `Note: on-chain validity is shorter (~60s from the baked recent blockhash), so a stale ` +
        `handle whose blockhash has expired will also be rejected at broadcast time.`,
    );
  }
  return entry.tx;
}

export function retireSolanaHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasSolanaHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}
