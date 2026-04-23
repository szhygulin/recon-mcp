import { getSolanaConnection } from "./rpc.js";

export interface SolanaTransactionStatus {
  chain: "solana";
  signature: string;
  /**
   * `pending` — not yet visible on chain; might still land.
   * `success` / `failed` — landed (the latter with an error string).
   * `dropped` — blockhash past its last-valid-block-height and tx was never
   *   found; cannot possibly land from here. Only set when the caller
   *   supplied `lastValidBlockHeight` AND the current block height is past
   *   it AND `getSignatureStatuses` still returns null.
   */
  status: "pending" | "success" | "failed" | "dropped";
  /**
   * Solana commitment level the cluster has reached for this tx.
   * `processed` → seen by at least one validator; may still fork out.
   * `confirmed` → ⅔ stake voted; practical finality for UX.
   * `finalized` → ~12.8s later; guaranteed not to revert.
   */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Slot the tx landed in (equivalent to block height on Solana). */
  slot?: number;
  /** Human error string from the cluster when `status === "failed"`. */
  error?: string;
  /**
   * Populated when status === "dropped" — the block height past which the
   * tx's baked blockhash was no longer valid, and the current block height
   * observed at the time of the poll. Useful for the agent to explain why
   * it's reporting "dropped" and for the user to cross-check on an
   * explorer.
   */
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
}

/**
 * Fetch the current status of a Solana tx by signature. Parallel to
 * `getTronTransactionStatus` / the EVM `getTransactionStatus`.
 *
 * Solana RPC surfaces the status via `getSignatureStatuses` — returns
 * a `{confirmationStatus, err, slot}` tuple or null if the tx isn't
 * visible yet. When null is returned and the caller supplied
 * `lastValidBlockHeight` (populated by send_transaction from the pinned
 * tx), the poller cross-checks against current block height: if we're
 * past the validity window, the tx is mathematically unable to land and
 * we report `dropped`. This avoids the old behavior of reporting
 * `pending` forever for txs that silently fell out of the mempool.
 */
export async function getSolanaTransactionStatus(args: {
  signature: string;
  /**
   * Optional. When supplied and `getSignatureStatuses` returns null, the
   * poller compares against `getBlockHeight()`; if we're past, the tx is
   * reported as `dropped` rather than forever `pending`.
   */
  lastValidBlockHeight?: number;
}): Promise<SolanaTransactionStatus> {
  const conn = getSolanaConnection();
  const res = await conn.getSignatureStatuses([args.signature], {
    searchTransactionHistory: true,
  });
  const entry = res.value[0];
  if (!entry) {
    // Tx not visible to this RPC. Two possibilities: (a) genuinely in
    // flight and hasn't propagated yet, or (b) dropped and never will.
    // If the caller supplied lastValidBlockHeight, we can distinguish.
    if (args.lastValidBlockHeight !== undefined) {
      const currentBlockHeight = await conn.getBlockHeight("confirmed");
      if (currentBlockHeight > args.lastValidBlockHeight) {
        return {
          chain: "solana",
          signature: args.signature,
          status: "dropped",
          lastValidBlockHeight: args.lastValidBlockHeight,
          currentBlockHeight,
        };
      }
    }
    return { chain: "solana", signature: args.signature, status: "pending" };
  }
  const commitment = entry.confirmationStatus;
  if (entry.err) {
    return {
      chain: "solana",
      signature: args.signature,
      status: "failed",
      ...(commitment ? { commitment } : {}),
      ...(entry.slot ? { slot: entry.slot } : {}),
      error: typeof entry.err === "string" ? entry.err : JSON.stringify(entry.err),
    };
  }
  return {
    chain: "solana",
    signature: args.signature,
    status: "success",
    ...(commitment ? { commitment } : {}),
    ...(entry.slot ? { slot: entry.slot } : {}),
  };
}
