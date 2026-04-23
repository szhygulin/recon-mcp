import { getSolanaConnection } from "./rpc.js";

export interface SolanaTransactionStatus {
  chain: "solana";
  signature: string;
  /** `pending` = not yet visible on chain; `success` / `failed` for landed txs. */
  status: "pending" | "success" | "failed";
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
}

/**
 * Fetch the current status of a Solana tx by signature. Parallel to
 * `getTronTransactionStatus` / the EVM `getTransactionStatus`.
 *
 * Solana RPC surfaces the status via `getSignatureStatuses` — returns
 * a `{confirmationStatus, err, slot}` tuple or null if the tx isn't
 * visible yet. Null → pending (either not yet submitted, or landed in
 * a slot that hasn't propagated to this RPC).
 */
export async function getSolanaTransactionStatus(
  signature: string,
): Promise<SolanaTransactionStatus> {
  const conn = getSolanaConnection();
  const res = await conn.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const entry = res.value[0];
  if (!entry) {
    return { chain: "solana", signature, status: "pending" };
  }
  const commitment = entry.confirmationStatus;
  if (entry.err) {
    return {
      chain: "solana",
      signature,
      status: "failed",
      ...(commitment ? { commitment } : {}),
      ...(entry.slot ? { slot: entry.slot } : {}),
      error: typeof entry.err === "string" ? entry.err : JSON.stringify(entry.err),
    };
  }
  return {
    chain: "solana",
    signature,
    status: "success",
    ...(commitment ? { commitment } : {}),
    ...(entry.slot ? { slot: entry.slot } : {}),
  };
}
