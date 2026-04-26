import { z } from "zod";
import { ALL_CHAINS } from "../../types/index.js";
import type { AnyChain } from "../../types/index.js";
import { EVM_ADDRESS, TRON_ADDRESS, SOLANA_ADDRESS } from "../../shared/address-patterns.js";

/**
 * Accept both EVM 0x addresses and TRON mainnet base58. Mirrors the
 * `walletSchema` pattern in src/modules/balances/schemas.ts — keep the two
 * regexes inline rather than importing, because that file's export is
 * private (prefixed, not re-exported) and mirroring the shape is cheap.
 */
const walletSchema = z.union([
  z.string().regex(EVM_ADDRESS),
  z.string().regex(TRON_ADDRESS),
  // Solana base58 pubkey, 43–44 chars.
  z.string().regex(SOLANA_ADDRESS),
]);

const chainEnum = z.enum(ALL_CHAINS as unknown as [string, ...string[]]);

export const getTransactionHistoryInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  /**
   * Max merged items to return. Capped at 50 to keep the historical-price
   * fan-out (one DefiLlama call per unique tx timestamp) bounded.
   */
  limit: z.number().int().min(1).max(50).default(25),
  includeExternal: z.boolean().default(true),
  includeTokenTransfers: z.boolean().default(true),
  /**
   * EVM-only. Silently ignored on TRON (TronGrid's internal-tx surface is
   * inconsistent across nodes — skipping it until asked).
   */
  includeInternal: z.boolean().default(true),
  /** Unix seconds; items with timestamp < startTimestamp are filtered out. */
  startTimestamp: z.number().int().nonnegative().optional(),
  /** Unix seconds; items with timestamp > endTimestamp are filtered out. */
  endTimestamp: z.number().int().nonnegative().optional(),
});

export type GetTransactionHistoryArgs = z.infer<typeof getTransactionHistoryInput>;

export type HistoryItemType =
  | "external"
  | "token_transfer"
  | "internal"
  | "program_interaction";

/**
 * Address-poisoning annotation. Issue #220. Surfaced on history items
 * when a strong heuristic fires; absent otherwise. Detection is
 * precision-tuned (no warning fatigue) — we only flag the three signals
 * with negligible false-positive rates.
 *
 * - `zero_amount_transfer`: token_transfer with `amount === "0"`. The
 *   USDC `transferFrom` `>= 0` allowance bug lets anyone log a 0-token
 *   transfer between arbitrary addresses; there is no legitimate
 *   reason for an external party to do this.
 * - `vanity_suffix_lookalike`: dust tx whose counterparty shares the
 *   first-4 AND last-4 hex chars (after the `0x` prefix) with another
 *   distinct counterparty in the same wallet's recent history. Set
 *   `mimics` to the matched address.
 * - `self_suffix_lookalike`: dust tx whose counterparty shares the
 *   first-4 AND last-4 hex chars with the wallet itself. Bidirectional
 *   inter-wallet variant. `mimics` is the wallet.
 *
 * EVM-only in v1: the suffix-lookalike rules require the hex shape.
 * The zero-amount rule is chain-agnostic and applies on TRON too
 * (TRC-20 has the same `transferFrom` allowance shape).
 */
export interface SuspectedPoisoning {
  reasons: Array<
    | "zero_amount_transfer"
    | "vanity_suffix_lookalike"
    | "self_suffix_lookalike"
  >;
  /** Legit address being impersonated, when known. Lowercased. */
  mimics?: string;
}

interface HistoryItemBase {
  type: HistoryItemType;
  hash: string;
  timestamp: number;
  from: string;
  to: string;
  status: "success" | "failed";
  /**
   * Set when an address-poisoning heuristic fires (#220). Absent when
   * the entry is clean.
   */
  suspectedPoisoning?: SuspectedPoisoning;
}

export interface ExternalHistoryItem extends HistoryItemBase {
  type: "external";
  valueNative: string;
  valueNativeFormatted: string;
  valueUsd?: number;
  methodSelector?: string;
  methodName?: string;
}

export interface TokenTransferHistoryItem extends HistoryItemBase {
  type: "token_transfer";
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  amountFormatted: string;
  valueUsd?: number;
}

export interface InternalHistoryItem extends HistoryItemBase {
  type: "internal";
  valueNative: string;
  valueNativeFormatted: string;
  valueUsd?: number;
  traceId?: string;
}

/**
 * Solana program interaction — emitted when a tx calls a non-native program
 * (Jupiter swap, Marinade stake, Raydium/Orca swap, or any unknown program).
 * Rather than parse per-protocol IDLs (brittle across upgrades), the history
 * module derives a balance-delta summary: for each token the wallet held,
 * what was the net change across the tx? The result is robust to IDL
 * version drift and answers "what happened to my wallet?" directly.
 *
 * `from` is the wallet being queried; `to` is the program ID. `hash` is the
 * signature. `balanceDeltas` lists every non-zero delta observed for the
 * wallet's accounts in the tx, keyed by token (SPL mint address or "SOL").
 */
export interface ProgramInteractionHistoryItem extends HistoryItemBase {
  type: "program_interaction";
  programId: string;
  programName?: string;
  programKind?: string;
  balanceDeltas: Array<{
    token: string;
    symbol?: string;
    decimals?: number;
    /** Signed integer amount as a decimal string. Negative = out, positive = in. */
    amount: string;
    /** Human-formatted signed amount (e.g. "-1.5" or "+200"). */
    amountFormatted: string;
    valueUsd?: number;
  }>;
}

export type HistoryItem =
  | ExternalHistoryItem
  | TokenTransferHistoryItem
  | InternalHistoryItem
  | ProgramInteractionHistoryItem;

export interface HistoryResponse {
  chain: AnyChain;
  wallet: string;
  items: HistoryItem[];
  /** True if any per-type fetch returned its server-side row cap before merge. */
  truncated: boolean;
  /** Best-effort indicator of how much of the response got a USD annotation. */
  priceCoverage: "full" | "partial" | "none";
  /** Non-fatal per-endpoint errors (e.g. Etherscan 429 on one of three calls). */
  errors?: Array<{ source: string; message: string }>;
}
