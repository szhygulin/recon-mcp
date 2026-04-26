import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * `explain_tx` — narrative post-mortem for a single transaction.
 *
 * v1 covers EVM (Ethereum / Arbitrum / Polygon / Base / Optimism), TRON,
 * and Solana. Bitcoin is deferred — the indexer surface for in-chain
 * inputs/outputs needs more thought than v1 has scope for.
 *
 * Output shape is deliberately flat: a one-sentence summary, ordered
 * step rows, balance + approval changes, and a heuristics block. Both
 * a structured envelope and a pre-rendered narrative string are
 * returned, with the agent picking the right one for the user-facing
 * surface.
 */

const POSTMORTEM_CHAINS = [
  ...SUPPORTED_CHAINS,
  "tron",
  "solana",
] as unknown as [string, ...string[]];

/**
 * Tx-hash regex per chain family. EVM hashes are 64-hex with optional
 * 0x prefix. TRON hashes are 64-hex bare. Solana signatures are
 * base58, 86-88 chars. We accept all three forms in the schema and
 * rely on the chain dispatcher to pick the right parser.
 */
const TX_HASH_PATTERN =
  /^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{86,88})$/;

const walletSchema = z.union([
  z.string().regex(EVM_ADDRESS),
  z.string().regex(TRON_ADDRESS),
  z.string().regex(SOLANA_ADDRESS),
]);

export const explainTxInput = z.object({
  hash: z
    .string()
    .regex(TX_HASH_PATTERN)
    .describe(
      "Transaction identifier. EVM: 32-byte hex (with or without `0x`). " +
        "TRON: 32-byte bare hex. Solana: 64-byte signature as base58 (86–88 chars)."
    ),
  chain: z
    .enum(POSTMORTEM_CHAINS)
    .describe(
      "Which chain the tx lives on. Required because EVM / TRON / Solana " +
        "post-mortems use different RPC paths and payload shapes."
    ),
  wallet: walletSchema
    .optional()
    .describe(
      "Optional. When supplied, balance + approval changes are computed " +
        "FROM THIS WALLET'S PERSPECTIVE — outflows are negative, inflows " +
        "positive. When omitted, defaults to the tx sender (the canonical " +
        "perspective). Pass an explicit wallet for recipient-side narratives."
    ),
  format: z
    .enum(["structured", "narrative", "both"])
    .default("both")
    .describe(
      '"structured" returns the JSON envelope only. "narrative" returns ' +
        'only the pre-rendered string. "both" (default) returns both — ' +
        "agents typically use the narrative for verbatim relay and the " +
        "structured for follow-up questions."
    ),
});

export type ExplainTxArgs = z.infer<typeof explainTxInput>;

/** One decoded step in the tx's top-level execution path. */
export interface ExplainTxStep {
  /**
   * Step kind:
   *   - `call`: a top-level contract call (EVM / TRON contract calls).
   *   - `native_transfer`: native-coin transfer (ETH / TRX / SOL).
   *   - `instruction`: Solana instruction.
   *   - `event`: a parsed log/event emitted by the tx.
   */
  kind: "call" | "native_transfer" | "instruction" | "event";
  /**
   * Decoded label — method name (`transfer`, `swap`, ...), event name
   * (`Transfer`, `Approval`), or instruction name (`SystemProgram::transfer`).
   * Best-effort; falls back to a hex selector or program-id fragment when
   * decoding fails.
   */
  label: string;
  /** Plain-text summary of the step's effect. */
  detail: string;
  /** Source program / contract address — surfaced for forensic context. */
  programOrContract?: string;
}

/**
 * One row per token (or native coin) the wallet's holdings changed by.
 * Signed: positive = received, negative = sent.
 */
export interface ExplainTxBalanceChange {
  symbol: string;
  /**
   * Token identifier — EVM contract address, Solana mint, "native" for
   * the chain's native coin.
   */
  token: string;
  /** Decimal-adjusted signed amount as a string (preserves bigint precision). */
  delta: string;
  /** Same value as a JS number for convenience — may lose precision on huge amounts. */
  deltaApprox: number;
  /** USD valuation of the delta when a price is available. */
  valueUsd?: number;
}

/** Approval change for an ERC-20 / TRC-20 owner → spender pair. */
export interface ExplainTxApprovalChange {
  symbol?: string;
  token: string;
  spender: string;
  /** New allowance as a decimal string. `unlimited` = MAX_UINT256. */
  newAllowance: string;
  isUnlimited: boolean;
}

/**
 * One heuristic flag the post-mortem fired. v1 surfaces:
 *   - `failed`: tx reverted on-chain.
 *   - `unlimited_approval`: an approval set MAX_UINT256.
 *   - `dust_transfer`: outflow < $0.01 USD-equivalent (potential
 *     poisoning bait — same heuristic family as #220).
 *   - `transfer_to_zero`: a Transfer event went to the zero address
 *     (token burn or contract self-destruct cleanup).
 *   - `high_gas`: gas cost > 10% of the transferred USD value (something
 *     unusual in routing or congestion).
 *   - `no_state_change`: receipt is success but no Transfer / native
 *     value moved — the tx might have been a no-op.
 */
export interface ExplainTxHeuristic {
  rule:
    | "failed"
    | "unlimited_approval"
    | "dust_transfer"
    | "transfer_to_zero"
    | "high_gas"
    | "no_state_change";
  message: string;
}

export interface ExplainTxResult {
  chain: string;
  hash: string;
  /** Tx sender / signer. */
  from: string;
  /**
   * Tx target. EVM: contract / EOA called. TRON: same. Solana: first
   * non-system program invoked when one exists; otherwise the first
   * destination of a SystemProgram::transfer.
   */
  to?: string;
  /**
   * Wallet whose perspective `balanceChanges` are computed from. Echoes
   * `args.wallet` when supplied; otherwise `from`.
   */
  perspective: string;
  /** Mined block / slot. */
  blockNumber?: string;
  /** ISO timestamp when the block confirmed. */
  blockTimeIso?: string;
  status: "success" | "failed" | "unknown";
  /** Native-coin gas / fee burn in human units. */
  feeNative?: string;
  feeNativeSymbol?: string;
  feeUsd?: number;
  summary: string;
  steps: ExplainTxStep[];
  balanceChanges: ExplainTxBalanceChange[];
  approvalChanges: ExplainTxApprovalChange[];
  heuristics: ExplainTxHeuristic[];
  /** Free-form scope reminders / partial-data flags. */
  notes: string[];
  /** Pre-rendered narrative string. Absent when `format === "structured"`. */
  narrative?: string;
}
