import { getSolanaConnection } from "./rpc.js";
import type { MarginfiFailureRecord } from "../../signing/solana-tx-store.js";

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
    // has two distinct causes, and the right user action differs:
    //
    //   1. Samples AGED OUT during Ledger review (issue #120). The tx's
    //      embedded oracle attestations were fresh at preview time but
    //      slipped past their max_staleness window by the time broadcast
    //      tried to land. Re-preparing refetches samples at a newer slot
    //      and usually succeeds.
    //
    //   2. Feed is ROTATING (issue #125). The Switchboard on-demand program
    //      emits "Rotating mega slot" when the feed is mid oracle-set
    //      transition; consensus is unreachable for ~60–120s regardless
    //      of sample count. Tight retry loops fail identically — the
    //      user needs to WAIT, not retry.
    //
    // Signal: "Rotating mega slot" in the logs. Without that line, treat
    // it as aged-out.
    const notEnoughSamples =
      /custom program error: 0x178e/i.test(base) ||
      /custom program error: 0x178e/i.test(logs) ||
      /NotEnoughSamples/.test(logs);
    if (notEnoughSamples) {
      const rotating = /Rotating mega slot/i.test(logs);
      if (rotating) {
        throw new Error(
          `Switchboard feed is ROTATING oracles ("Rotating mega slot" in the logs) ` +
            `— this is a transient ~60–120s state during which consensus cannot ` +
            `be reached regardless of how many samples we fetch (issue #125). ` +
            `Wait at least 60s before retrying — tight retry loops will fail ` +
            `identically until rotation completes. No on-chain effect — the ` +
            `durable nonce was not advanced. Raw: ${base}${logs}`,
        );
      }
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

/**
 * Classify a broadcast- or preview-time failure against the Switchboard
 * transient-oracle taxonomy. Used by the MarginFi fast-retry approval cache
 * to decide whether a subsequent same-op re-prepare is eligible for the
 * abridged CHECKS template.
 *
 * Inspects the error message text (both the friendly-wrapped forms this
 * module throws AND the raw pre-sign-simulation messages shaped in
 * `previewSolanaSend`), keyed on phrases that uniquely identify each
 * transient mode. Non-transient (MarginFi bad-health, arbitrary RPC
 * errors, user-rejected-on-device) fall into `{ kind: "other", ... }`.
 *
 * Returns a `MarginfiFailureRecord` regardless of err shape; callers can
 * pass it straight into `recordMarginfiFailure`. Never throws.
 */
export function classifyMarginfiFailure(err: unknown): MarginfiFailureRecord {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const now = Date.now();

  // Rotation is the most specific — check first so it doesn't get captured
  // by the plain NotEnoughSamples branch.
  if (/Rotating mega slot|ROTATING oracles/i.test(message)) {
    return { kind: "oracle-transient", reason: "RotatingMegaSlot", failedAt: now };
  }
  // Switchboard InvalidSlotNumber — the signed oracle response is past the
  // ~512-slot SlotHashes window. Either the Anchor code 6039 / 0x1797 or
  // the error name string may surface depending on where the error was
  // shaped.
  if (/InvalidSlotNumber|0x1797\b|\b6039\b/.test(message)) {
    return { kind: "oracle-transient", reason: "InvalidSlotNumber", failedAt: now };
  }
  // NotEnoughSamples — Anchor 6030 / 0x178e — caught by broadcast.ts's
  // friendly wrapper ("aged out during Ledger review") OR by the pre-sign
  // simulate gate ("Pre-sign simulation REJECTED ... NotEnoughSamples").
  if (
    /NotEnoughSamples|0x178e|aged out during Ledger review/i.test(message)
  ) {
    return { kind: "oracle-transient", reason: "NotEnoughSamples", failedAt: now };
  }
  // Everything else — MarginFi bad-health, stale non-Switchboard oracle,
  // arbitrary RPC issues, the user hitting "reject" on-device. Record a
  // truncated reason for observability but do NOT unlock fast-retry.
  return {
    kind: "other",
    reason: message.slice(0, 200),
    failedAt: now,
  };
}
