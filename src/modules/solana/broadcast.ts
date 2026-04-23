import { getSolanaConnection } from "./rpc.js";

/**
 * Broadcast a signed Solana tx to the network. Input is the full serialized
 * tx bytes (message + signature section). Output is the tx signature
 * (58-char base58, also the primary tx identifier on Solana).
 *
 * `skipPreflight: false` — default. The RPC runs a simulation before
 * submitting so obvious failures (insufficient balance, bad program
 * address, missing account) surface as an error up front rather than
 * landing on-chain and failing. Preflight is ~80ms extra; cheap insurance.
 *
 * `preflightCommitment: "confirmed"` — preflight-simulates against
 * `confirmed` cluster state so we don't false-positive on optimistically-
 * processed-then-reverted slots.
 *
 * `maxRetries: 0` — we prefer to surface RPC-side transient failures to
 * the caller rather than have web3.js silently retry. The handle is
 * already-used by this point; a retry could lead to the tx landing twice
 * in the rare case the first submission's ack was lost (Solana sigs are
 * deterministic, so this would just duplicate the attempt without
 * double-spending, but surfacing the error is still cleaner UX).
 */
export async function broadcastSolanaTx(signedTxBytes: Buffer): Promise<string> {
  const conn = getSolanaConnection();
  try {
    const signature = await conn.sendRawTransaction(signedTxBytes, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    });
    return signature;
  } catch (e) {
    // Normalize the error so the caller can show something useful. Solana
    // RPC errors often come with `SendTransactionError` carrying `logs`
    // from the preflight simulation — include them if present.
    const err = e as {
      message?: string;
      logs?: string[];
      name?: string;
    };
    const base = err?.message ?? String(e);
    const logs = Array.isArray(err?.logs) ? `\nProgram logs:\n  ${err.logs.join("\n  ")}` : "";
    throw new Error(`Solana broadcast failed: ${base}${logs}`);
  }
}
