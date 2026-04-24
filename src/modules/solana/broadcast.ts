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
 * `maxRetries: 5` — web3.js rebroadcasts the EXACT same signed bytes
 * (no re-sign; the tx signature is deterministic) against the RPC up to
 * 5 times within the blockhash's validity window. This tolerates the
 * common case where the first leader saw the tx but didn't include it —
 * subsequent leaders get another shot without the user re-approving on
 * the Ledger. We previously set this to 0 reasoning "surface transient
 * failures to the caller" — but the transient failure was silent drop,
 * not a returned error, so 0 retries meant one leader failure = lost tx.
 * Double-landing isn't a risk: Solana sigs are deterministic, so the
 * cluster dedupes identical broadcasts.
 */
export async function broadcastSolanaTx(signedTxBytes: Buffer): Promise<string> {
  const conn = getSolanaConnection();
  try {
    const signature = await conn.sendRawTransaction(signedTxBytes, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
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
    const logsArr = Array.isArray(err?.logs) ? err.logs : [];
    const logs = logsArr.length ? `\nProgram logs:\n  ${logsArr.join("\n  ")}` : "";

    // Switchboard `NotEnoughSamples` (Anchor 6030 / 0x178e) on the crank ix
    // means the oracle samples we fetched at preview time aged past their
    // `max_staleness` window during Ledger review (issue #120). With
    // numSignatures=3 the headroom is ~3× but not unbounded; a slow
    // review (>20s) or a feed with a tight max_staleness can still trip
    // this. Reframe so the user gets an actionable message instead of
    // a raw program error — the remediation is always "re-prepare" and
    // the pre-sign simulation will re-fetch fresh samples.
    const notEnoughSamples =
      /custom program error: 0x178e/i.test(base) ||
      /custom program error: 0x178e/i.test(logs) ||
      /NotEnoughSamples/.test(logs);
    if (notEnoughSamples) {
      throw new Error(
        `Switchboard oracle samples aged out during Ledger review — the tx's ` +
          `embedded oracle attestations were fresh at preview time but too old ` +
          `by the time broadcast tried to land (issue #120). Re-prepare the ` +
          `action (call prepare_marginfi_* again) to fetch a fresh crank and ` +
          `retry. No on-chain effect — the durable nonce was not advanced. ` +
          `Raw: ${base}${logs}`,
      );
    }

    throw new Error(`Solana broadcast failed: ${base}${logs}`);
  }
}
