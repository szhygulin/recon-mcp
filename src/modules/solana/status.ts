import { PublicKey } from "@solana/web3.js";
import { getNonceAccountValue } from "./nonce.js";
import { getSolanaConnection } from "./rpc.js";

export interface SolanaTransactionStatus {
  chain: "solana";
  signature: string;
  /**
   * `pending` — not yet visible on chain; might still land.
   * `success` / `failed` — landed (the latter with an error string).
   * `dropped` — one of two mathematical impossibilities:
   *   - Legacy-blockhash tx: baked blockhash is past its
   *     `lastValidBlockHeight` and `getSignatureStatuses` returns null.
   *   - Durable-nonce tx: on-chain nonce no longer matches the baked
   *     nonce value (rotated or account closed) and the tx was never
   *     found. The on-chain nonce state is what Agave checks, so this
   *     is authoritative.
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
   * Populated when a legacy-blockhash tx is reported as dropped — the block
   * height past which the tx's baked blockhash was no longer valid, and the
   * current block height observed at the time of the poll.
   */
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
  /**
   * Populated when a durable-nonce tx is reported as dropped — the nonce
   * account the tx referenced, the nonce value baked into the tx's
   * `recentBlockhash` field, and the on-chain nonce value observed at the
   * time of the poll (or `"closed"` if the account was destroyed). Lets
   * the agent explain exactly why we report dropped: another tx against
   * the same nonce advanced it before ours could land.
   */
  nonceAccount?: string;
  bakedNonce?: string;
  currentNonce?: string;
}

/**
 * Fetch the current status of a Solana tx by signature. Parallel to
 * `getTronTransactionStatus` / the EVM `getTransactionStatus`.
 *
 * Solana RPC surfaces the status via `getSignatureStatuses` — returns
 * a `{confirmationStatus, err, slot}` tuple or null if the tx isn't
 * visible yet. When null is returned, the poller distinguishes dropped
 * from still-pending based on tx type:
 *
 *   - Durable-nonce txs (nearly every send this server builds): check the
 *     on-chain nonce account. If the nonce rotated past the baked value
 *     (or the account was closed), the tx can never land — authoritative.
 *   - Legacy-blockhash txs (`nonce_init` only): check current block height
 *     against `lastValidBlockHeight`. If we're past, dropped.
 *
 * This avoids reporting `pending` forever for txs that silently fell out
 * of the mempool — a known UX gap from Solana Phase 2.
 */
export async function getSolanaTransactionStatus(args: {
  signature: string;
  /**
   * Optional. When supplied and `getSignatureStatuses` returns null, the
   * poller compares against `getBlockHeight()`; if we're past, the tx is
   * reported as `dropped` rather than forever `pending`. Used for legacy-
   * blockhash txs (currently just `nonce_init`).
   */
  lastValidBlockHeight?: number;
  /**
   * Optional. When supplied and `getSignatureStatuses` returns null, the
   * poller compares the on-chain nonce to `nonceValue`; if the nonce
   * rotated (or the account was closed), the tx is reported as `dropped`.
   * Authoritative for durable-nonce-protected sends (native_send, spl_send,
   * nonce_close, jupiter_swap, all `marginfi_*` actions). `send_transaction`
   * surfaces both fields on its return value.
   */
  durableNonce?: { noncePubkey: string; nonceValue: string };
}): Promise<SolanaTransactionStatus> {
  const conn = getSolanaConnection();
  const res = await conn.getSignatureStatuses([args.signature], {
    searchTransactionHistory: true,
  });
  const entry = res.value[0];
  if (!entry) {
    // Tx not visible to this RPC. Distinguish dropped vs pending.
    // Prefer the durable-nonce check when supplied — it's authoritative
    // (Agave validates the nonce state, not block height, for nonce txs).
    if (args.durableNonce) {
      const noncePubkey = new PublicKey(args.durableNonce.noncePubkey);
      const current = await getNonceAccountValue(conn, noncePubkey);
      if (!current || current.nonce !== args.durableNonce.nonceValue) {
        return {
          chain: "solana",
          signature: args.signature,
          status: "dropped",
          nonceAccount: args.durableNonce.noncePubkey,
          bakedNonce: args.durableNonce.nonceValue,
          currentNonce: current ? current.nonce : "closed",
        };
      }
      return { chain: "solana", signature: args.signature, status: "pending" };
    }
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
