import { z } from "zod";

/**
 * Schema for `build_incident_report` (issue #425, v1).
 *
 * v1 is read-only evidence gathering + redaction + markdown
 * narrative. The submission channel (`submit_incident_report`) is
 * deferred to v2 — see `claude-work/plan-incident-report-v2.md`.
 */
export const buildIncidentReportInput = z.object({
  scope: z
    .enum(["session", "wallet", "custom"])
    .default("session")
    .describe(
      "Evidence-collection scope. `session` (default): notice flags " +
        "fired this session, demo-mode state, paired Ledger summaries — " +
        "no on-chain reads. `wallet`: same as `session` PLUS the " +
        "supplied `wallet`'s recent on-chain history. `custom`: same as " +
        "`wallet` but lets `incident_class` widen evidence (e.g. allowances " +
        "for an address-poisoning incident). `last_tx` was reserved in the " +
        "filed issue but is deferred to v2 (needs the prepared-tx ring " +
        "buffer).",
    ),
  incident_class: z
    .enum([
      "hash_mismatch",
      "unexpected_tx",
      "address_poisoning",
      "skill_pin_drift",
      "unknown",
    ])
    .optional()
    .describe(
      "What category of incident is being reported. Drives which " +
        "evidence to fetch on top of the always-included session-level " +
        "summary. `address_poisoning` adds allowance enumeration; " +
        "`unexpected_tx` / `hash_mismatch` add recent tx history. " +
        "`skill_pin_drift` adds the live drift status block. `unknown` is " +
        "the safe default when the user isn't sure which category fits.",
    ),
  wallet: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Wallet address to scope evidence to. Required when `scope` is " +
        "`wallet` or `custom`. Format: EVM hex / Solana base58 / TRON " +
        "T-prefixed base58. Detected automatically from the prefix shape.",
    ),
  chain: z
    .enum([
      "ethereum",
      "arbitrum",
      "polygon",
      "base",
      "optimism",
      "tron",
      "solana",
    ])
    .optional()
    .describe(
      "Chain context for the wallet. Required when on-chain evidence is " +
        "fetched (`scope: wallet` or `scope: custom`). Defaults to " +
        "`ethereum` when omitted in those scopes.",
    ),
  txHash: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Transaction hash anchoring the incident to a specific tx. Surfaced " +
        "verbatim in the bundle (with redaction applied to the user-facing " +
        "shape per `redact`). v1 doesn't fetch the tx body itself — the " +
        "agent / user pastes additional context separately.",
    ),
  redact: z
    .enum(["none", "addresses", "all"])
    .default("addresses")
    .describe(
      "Redaction mode. Default `addresses` fuzzes every address-shaped " +
        "field (EVM/Solana/TRON/BTC) to first-4/last-4 of meaningful chars " +
        "so the bundle is safe to display before the user has decided where " +
        "to forward it. `all` additionally buckets USD amounts to coarse " +
        "ranges. `none` shows full hex — opt-in only when the user is ready " +
        "to share with a trusted security contact.",
    ),
});

export type BuildIncidentReportArgs = z.infer<typeof buildIncidentReportInput>;
