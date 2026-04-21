import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const dataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const pairLedgerLiveInput = z.object({});

export const pairLedgerTronInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Ledger TRON account slot (hardened BIP-44 account index). 0 = first account, " +
        "1 = second, etc. — same convention Ledger Live uses. Omit to pair the default " +
        "account (index 0). Call pair_ledger_tron multiple times with different " +
        "indices to expose multiple TRON accounts in get_ledger_status."
    ),
});

export const getLedgerStatusInput = z.object({});

const baseAaveAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  asset: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of `asset`, NOT raw wei/base units. ' +
        'Example: "1.5" for 1.5 USDC, "0.01" for 0.01 ETH. Pass "max" for full-balance withdraw/repay.'
    ),
});

export const prepareAaveSupplyInput = baseAaveAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareAaveWithdrawInput = baseAaveAction;
// Aave V3 stable-rate borrowing is disabled on all production markets — we only
// build variable-rate borrow/repay txs. No `interestRateMode` arg on purpose.
export const prepareAaveBorrowInput = baseAaveAction;
export const prepareAaveRepayInput = baseAaveAction.extend({
  approvalCap: approvalCapSchema,
});

export const prepareLidoStakeInput = z.object({
  wallet: walletSchema,
  amountEth: z
    .string()
    .describe('Human-readable ETH amount, NOT raw wei. Example: "0.5" for 0.5 ETH.'),
});
export const prepareLidoUnstakeInput = z.object({
  wallet: walletSchema,
  amountStETH: z
    .string()
    .describe(
      'Human-readable stETH amount, NOT raw wei. Example: "0.5" for 0.5 stETH (18 decimals).'
    ),
  approvalCap: approvalCapSchema,
});

export const prepareEigenLayerDepositInput = z.object({
  wallet: walletSchema,
  strategy: addressSchema,
  token: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of `token`, NOT raw wei/base units. Example: "0.5" for 0.5 stETH.'
    ),
  approvalCap: approvalCapSchema,
});

export const prepareNativeSendInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  to: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable native-asset amount, NOT raw wei. Example: "0.5" for 0.5 ETH (or 0.5 MATIC on polygon).'
    ),
});

export const prepareTokenSendInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  token: addressSchema,
  to: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. Example: "10" for 10 USDC. ' +
        'Decimals resolved from the token contract. Pass "max" to send the full balance.'
    ),
});

export const sendTransactionInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "Opaque handle returned by a prepare_* tool in the `handle` field of the UnsignedTx. " +
        "Raw calldata is NOT accepted — the handle is the only way to name a tx for signing, " +
        "so the tx the user previewed is exactly the tx sent to Ledger. If the tx chain has a " +
        "`next` step (e.g. approve → swap), each step has its own handle; call send_transaction " +
        "once per handle in order. Handles expire 15 minutes after prepare and are single-use."
    ),
  confirmed: z
    .literal(true)
    .describe(
      "Must be literally `true`. The agent is affirming that the user has seen and acknowledged " +
        "the decoded preview returned by the preceding prepare_* call. This is a schema-enforced " +
        "contract — omitting it fails validation before any tx is submitted."
    ),
});

export const previewSendInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "Opaque handle returned by a prepare_* tool. preview_send fetches the current " +
        "nonce + EIP-1559 fees + gas limit, stashes them against the handle, computes " +
        "the EIP-1559 pre-sign RLP hash Ledger will display in blind-sign mode, and " +
        "returns the LEDGER BLIND-SIGN HASH block so the user can see and confirm the " +
        "hash BEFORE the Ledger device prompt appears. A follow-up send_transaction " +
        "call forwards the pinned fields verbatim. Handles expire 15 minutes after " +
        "prepare. Once a pin exists, re-calling preview_send on the same handle returns " +
        "the existing pin unchanged unless `refresh: true` is passed."
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Set to true to re-pin nonce/fees/gas (e.g. after the user paused for minutes and " +
        "wants fresh fees). Default is false: the existing pin and its pre-sign hash are " +
        "returned verbatim, so the hash the user matched in chat cannot silently drift " +
        "between preview and send."
    ),
});

export const getTransactionStatusInput = z.object({
  chain: z
    .enum([...SUPPORTED_CHAINS, "tron"] as unknown as [string, ...string[]])
    .describe("EVM chain or 'tron'."),
  txHash: z
    .string()
    .regex(/^(0x)?[a-fA-F0-9]{64}$/)
    .describe(
      "32-byte tx hash as hex. EVM txs are conventionally 0x-prefixed; TRON tx IDs are bare hex — both are accepted."
    ),
});

export const getTxVerificationInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "Opaque handle returned by any prepare_* tool. Use this when the original " +
        "prepare_* response (and its VERIFY-BEFORE-SIGNING block) has been dropped " +
        "from your context — the server re-emits the exact same JSON + verification " +
        "block from in-memory state. Read the response from this tool directly; " +
        "never recover verification data by reading tool-result files from disk."
    ),
});

export type PairLedgerTronArgs = z.infer<typeof pairLedgerTronInput>;
export type PrepareAaveSupplyArgs = z.infer<typeof prepareAaveSupplyInput>;
export type PrepareAaveWithdrawArgs = z.infer<typeof prepareAaveWithdrawInput>;
export type PrepareAaveBorrowArgs = z.infer<typeof prepareAaveBorrowInput>;
export type PrepareAaveRepayArgs = z.infer<typeof prepareAaveRepayInput>;
export type PrepareLidoStakeArgs = z.infer<typeof prepareLidoStakeInput>;
export type PrepareLidoUnstakeArgs = z.infer<typeof prepareLidoUnstakeInput>;
export type PrepareEigenLayerDepositArgs = z.infer<typeof prepareEigenLayerDepositInput>;
export type PrepareNativeSendArgs = z.infer<typeof prepareNativeSendInput>;
export type PrepareTokenSendArgs = z.infer<typeof prepareTokenSendInput>;
export type PreviewSendArgs = z.infer<typeof previewSendInput>;
export type SendTransactionArgs = z.infer<typeof sendTransactionInput>;
export type GetTransactionStatusArgs = z.infer<typeof getTransactionStatusInput>;
export type GetTxVerificationArgs = z.infer<typeof getTxVerificationInput>;
