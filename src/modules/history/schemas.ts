import { z } from "zod";
import { ALL_CHAINS } from "../../types/index.js";
import type { AnyChain } from "../../types/index.js";

/**
 * Accept both EVM 0x addresses and TRON mainnet base58. Mirrors the
 * `walletSchema` pattern in src/modules/balances/schemas.ts — keep the two
 * regexes inline rather than importing, because that file's export is
 * private (prefixed, not re-exported) and mirroring the shape is cheap.
 */
const walletSchema = z.union([
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
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

export type HistoryItemType = "external" | "token_transfer" | "internal";

interface HistoryItemBase {
  type: HistoryItemType;
  hash: string;
  timestamp: number;
  from: string;
  to: string;
  status: "success" | "failed";
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

export type HistoryItem =
  | ExternalHistoryItem
  | TokenTransferHistoryItem
  | InternalHistoryItem;

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
