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

export const pairLedgerSolanaInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Ledger Solana account slot (hardened BIP-44 account index at path `44'/501'/<n>'`). " +
        "0 = first Solana account in Ledger Live, 1 = second, etc. Omit to pair the default " +
        "account (index 0). Call multiple times with different indices to expose multiple " +
        "Solana accounts in `get_ledger_status.solana`."
    ),
});

const solanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  .describe("Base58 Solana mainnet address (ed25519 pubkey, 43 or 44 chars).");

export const prepareSolanaNativeSendInput = z.object({
  wallet: solanaAddressSchema,
  to: solanaAddressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable SOL amount (up to 9 decimals). Example: "0.5" for 0.5 SOL. ' +
        'Pass "max" to send the full balance minus tx fee and a small safety buffer.'
    ),
});

export const prepareSolanaSplSendInput = z.object({
  wallet: solanaAddressSchema,
  mint: solanaAddressSchema.describe(
    "Base58 SPL mint address. Use the canonical mint for known tokens (e.g. USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)."
  ),
  to: solanaAddressSchema,
  amount: z
    .string()
    .describe(
      "Human-readable token amount. Decimals are resolved from the mint (canonical table " +
        "for USDC/USDT/JUP/BONK/JTO/mSOL/jitoSOL; otherwise on-chain `getTokenSupply`). " +
        'If the recipient does not yet have an associated token account for this mint, ' +
        'the tx automatically includes a `createAssociatedTokenAccount` instruction and the ' +
        'sender pays ~0.00204 SOL rent — disclosed in the preview.'
    ),
});

export const prepareSolanaNonceInitInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that will own (and authorize) the durable-nonce account. " +
      "The nonce account address is derived deterministically via " +
      "PublicKey.createWithSeed(wallet, 'vaultpilot-nonce-v1', SystemProgram). " +
      "No separate keypair or backup is needed — the same wallet + seed always " +
      "produces the same PDA."
  ),
});

export const prepareSolanaNonceCloseInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet whose durable-nonce account should be closed. The full balance " +
      "(~0.00144 SOL rent-exempt seed) is returned to this same wallet."
  ),
});

export const getSolanaSwapQuoteInput = z.object({
  inputMint: solanaAddressSchema.describe(
    "Base58 mint address of the token being sold. For native SOL use the wrapped-SOL " +
      "mint So11111111111111111111111111111111111111112 — Jupiter auto-wraps/unwraps."
  ),
  outputMint: solanaAddressSchema.describe(
    "Base58 mint address of the token being bought. Same wrapped-SOL convention as inputMint."
  ),
  amount: z
    .string()
    .regex(/^\d+$/)
    .describe(
      "Raw integer amount in base units (NOT decimal-adjusted). For ExactIn swaps " +
        "this is how much inputMint to sell; for ExactOut it's how much outputMint to buy. " +
        "Example: to sell 1 USDC (6 decimals), pass '1000000'."
    ),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(50)
    .describe("Slippage tolerance in basis points. 50 bps = 0.5%. Default 50."),
  swapMode: z
    .enum(["ExactIn", "ExactOut"])
    .default("ExactIn")
    .describe(
      "ExactIn: sell exactly `amount` inputMint, receive at least minOutput. " +
        "ExactOut: buy exactly `amount` outputMint, sell at most maxInput."
    ),
});

export const prepareSolanaSwapInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet executing the swap. Must have an initialized durable-nonce account — " +
      "run prepare_solana_nonce_init first if not set up yet."
  ),
  quote: z
    .record(z.unknown())
    .describe(
      "The full `quote` object returned by get_solana_swap_quote. Pass it back verbatim " +
        "— Jupiter computes a signature over the quote and rejects /swap-instructions if " +
        "any field is mutated."
    ),
  prioritizationFeeLamports: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional priority fee in lamports. Omit to let Jupiter pick based on the local " +
        "fee market (recommended)."
    ),
});

/**
 * MarginFi action schemas. `symbol` OR `mint` identifies the bank — pass
 * either, not both. The builder resolves the symbol via the canonical
 * SOLANA_TOKENS table; pass `mint` explicitly when the token isn't in that
 * (small) allowlist but MarginFi does list it.
 */
const marginfiBankTarget = {
  symbol: z
    .string()
    .optional()
    .describe(
      "Canonical token symbol (USDC, SOL, USDT, JUP, BONK, JTO, mSOL, jitoSOL). " +
        "The builder resolves this to the underlying mint; MarginFi treats SOL as wSOL internally " +
        "with auto-wrap/unwrap. Pass `mint` instead if your token isn't in the canonical list."
    ),
  mint: solanaAddressSchema
    .optional()
    .describe(
      "Base58 SPL mint address. Used as an override or when the token isn't in the canonical " +
        "SOLANA_TOKENS table. Exactly one of `symbol` or `mint` must be passed."
    ),
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "MarginfiAccount slot (0 = first, 1 = second, ...). Most users stay on 0. " +
        "Use a different index to segregate positions across multiple MarginfiAccounts " +
        "owned by the same wallet."
    ),
};

export const prepareMarginfiInitInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that will own the MarginfiAccount PDA. The account is deterministic — " +
      "seeds (marginfi_account, group, authority, accountIndex, third_party_id=0) produce " +
      "the same PDA every time. Only the user (authority + fee_payer) signs; no rent-exempt " +
      "seed is moved (this is a PDA, not a fresh account)."
  ),
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Account slot (default 0). Pass a different index to init a second MarginfiAccount " +
        "under the same wallet."
    ),
});

export const prepareMarginfiSupplyInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet executing the supply. Must have an initialized MarginfiAccount (run " +
      "prepare_marginfi_init first) AND a durable-nonce account (prepare_solana_nonce_init)."
  ),
  ...marginfiBankTarget,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount to supply (e.g. "1.5" for 1.5 USDC). Decimals resolved ' +
        'from the bank\'s mint — do NOT pass raw base units.'
    ),
});

export const prepareMarginfiWithdrawInput = z.object({
  wallet: solanaAddressSchema,
  ...marginfiBankTarget,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount to withdraw. Pre-flight refuses if the withdraw would ' +
        'push the health factor below the maintenance threshold.'
    ),
  withdrawAll: z
    .boolean()
    .optional()
    .describe(
      "Set true to close the entire supplied position in this bank (lets the SDK pass the " +
        "`withdraw_all` on-chain flag so the bank clears the balance slot). Omit for partial."
    ),
});

export const prepareMarginfiBorrowInput = z.object({
  wallet: solanaAddressSchema,
  ...marginfiBankTarget,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount to borrow. Pre-flight refuses if the account has zero ' +
        'free collateral.'
    ),
});

export const prepareMarginfiRepayInput = z.object({
  wallet: solanaAddressSchema,
  ...marginfiBankTarget,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount to repay against outstanding debt in this bank.'
    ),
  repayAll: z
    .boolean()
    .optional()
    .describe(
      "Set true to repay the full outstanding debt in this bank (SDK also clears the balance " +
        "slot — cheaper for the user if they're closing out). Omit for partial."
    ),
});

export const getSolanaSetupStatusInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet to probe. Returns the state of the durable-nonce account " +
      "(exists / address / lamports / currentNonce / authority) and the list of " +
      "existing MarginfiAccount PDAs (accountIndex + address) for the wallet. " +
      "Read-only, no RPC fan-out — one getAccountInfo per probed PDA."
  ),
});

export const getMarginfiPositionsInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet to enumerate MarginFi positions for. Probes the first 4 MarginfiAccount " +
      "PDAs under this wallet (accountIndex 0..3) and returns one entry per existing account."
  ),
});

export const getMarginfiDiagnosticsInput = z.object({});

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

export const prepareWethUnwrapInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  amount: z
    .string()
    .describe(
      'Human-readable WETH amount, NOT raw wei. Example: "0.5" for 0.5 WETH. ' +
        'Pass "max" to unwrap the full WETH balance. WETH is always 18 decimals on every supported chain.'
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
  previewToken: z
    .string()
    .optional()
    .describe(
      "EVM-only (ignored for TRON). Opaque token returned by the preceding `preview_send` call " +
        "in its top-level JSON response. Must be passed back verbatim here — a mismatch or " +
        "omission proves preview_send was skipped or re-run with `refresh: true` after capture, " +
        "and send_transaction refuses. Closes the gap where the agent collapses preview_send + " +
        "send_transaction into one step without surfacing the EXTRA CHECKS YOU CAN RUN BEFORE " +
        "REPLYING 'SEND' menu to the user."
    ),
  userDecision: z
    .literal("send")
    .optional()
    .describe(
      "EVM-only (ignored for TRON). The agent sets this to the literal \"send\" AFTER presenting " +
        "the EXTRA CHECKS menu from preview_send's agent-task block and receiving the user's " +
        "explicit 'send' reply. Schema-enforced contract that the preview-time gate was surfaced " +
        "to the user, not skipped. Missing value → send_transaction refuses with a clear error."
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

export const previewSolanaSendInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "Opaque handle returned by prepare_solana_native_send / prepare_solana_spl_send. " +
        "preview_solana_send fetches a fresh Solana blockhash, serializes the message " +
        "bytes, computes the base58(sha256(...)) Message Hash the Ledger Solana app will " +
        "display on blind-sign, and pins the handle so send_transaction can consume it. " +
        "MUST be called between prepare_solana_* and send_transaction — the pair is " +
        "separated because a Solana blockhash is only valid ~60s and prepare→user-approve " +
        "routinely blows that window. Re-callable on the same handle to re-pin with a " +
        "newer blockhash if the user pauses."
    ),
});

export type PreviewSolanaSendArgs = z.infer<typeof previewSolanaSendInput>;

export const getTransactionStatusInput = z.object({
  chain: z
    .enum([...SUPPORTED_CHAINS, "tron", "solana"] as unknown as [string, ...string[]])
    .describe("EVM chain, 'tron', or 'solana'."),
  txHash: z
    .string()
    .regex(/^(0x)?[a-fA-F0-9]{64}$|^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
    .describe(
      "Transaction identifier. EVM: 32-byte hex (0x-prefixed or bare). TRON: 32-byte bare hex. " +
        "Solana: 64-byte signature as base58 (86–88 chars). All three forms are accepted."
    ),
  lastValidBlockHeight: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Solana only. Block-height ceiling for the tx's baked blockhash — returned by " +
        "send_transaction for Solana txs. When supplied and `getSignatureStatuses` " +
        "returns null (tx not visible), the poller compares against the current block " +
        "height and reports `dropped` instead of forever `pending` if the window has " +
        "passed. Omit for EVM / TRON; ignored on those chains."
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

export const getVerificationArtifactInput = z.object({
  handle: z
    .string()
    .min(1)
    .describe(
      "Opaque handle returned by any prepare_* tool. Returns a sparse, copy-paste-" +
        "friendly JSON artifact carrying the raw calldata (or TRON rawDataHex), " +
        "chain, recipient, value, payloadHash, and — when preview_send has already " +
        "pinned gas — the Ledger blind-sign preSignHash. A static prompt telling a " +
        "second LLM how to independently decode the bytes is included. The " +
        "artifact intentionally omits the server's humanDecode, swiss-knife URL, " +
        "and 4byte cross-check so the second agent cannot parrot them."
    ),
});

export type PairLedgerTronArgs = z.infer<typeof pairLedgerTronInput>;
export type PairLedgerSolanaArgs = z.infer<typeof pairLedgerSolanaInput>;
export type PrepareSolanaNativeSendArgs = z.infer<typeof prepareSolanaNativeSendInput>;
export type PrepareSolanaSplSendArgs = z.infer<typeof prepareSolanaSplSendInput>;
export type PrepareSolanaNonceInitArgs = z.infer<typeof prepareSolanaNonceInitInput>;
export type GetSolanaSwapQuoteArgs = z.infer<typeof getSolanaSwapQuoteInput>;
export type PrepareSolanaSwapArgs = z.infer<typeof prepareSolanaSwapInput>;
export type PrepareSolanaNonceCloseArgs = z.infer<typeof prepareSolanaNonceCloseInput>;
export type PrepareAaveSupplyArgs = z.infer<typeof prepareAaveSupplyInput>;
export type PrepareAaveWithdrawArgs = z.infer<typeof prepareAaveWithdrawInput>;
export type PrepareAaveBorrowArgs = z.infer<typeof prepareAaveBorrowInput>;
export type PrepareAaveRepayArgs = z.infer<typeof prepareAaveRepayInput>;
export type PrepareLidoStakeArgs = z.infer<typeof prepareLidoStakeInput>;
export type PrepareLidoUnstakeArgs = z.infer<typeof prepareLidoUnstakeInput>;
export type PrepareEigenLayerDepositArgs = z.infer<typeof prepareEigenLayerDepositInput>;
export type PrepareNativeSendArgs = z.infer<typeof prepareNativeSendInput>;
export type PrepareWethUnwrapArgs = z.infer<typeof prepareWethUnwrapInput>;
export type PrepareTokenSendArgs = z.infer<typeof prepareTokenSendInput>;
export type PreviewSendArgs = z.infer<typeof previewSendInput>;
export type SendTransactionArgs = z.infer<typeof sendTransactionInput>;
export type GetTransactionStatusArgs = z.infer<typeof getTransactionStatusInput>;
export type GetTxVerificationArgs = z.infer<typeof getTxVerificationInput>;
export type GetVerificationArtifactArgs = z.infer<typeof getVerificationArtifactInput>;
export type PrepareMarginfiInitArgs = z.infer<typeof prepareMarginfiInitInput>;
export type PrepareMarginfiSupplyArgs = z.infer<typeof prepareMarginfiSupplyInput>;
export type PrepareMarginfiWithdrawArgs = z.infer<typeof prepareMarginfiWithdrawInput>;
export type PrepareMarginfiBorrowArgs = z.infer<typeof prepareMarginfiBorrowInput>;
export type PrepareMarginfiRepayArgs = z.infer<typeof prepareMarginfiRepayInput>;
export type GetMarginfiPositionsArgs = z.infer<typeof getMarginfiPositionsInput>;
export type GetSolanaSetupStatusArgs = z.infer<typeof getSolanaSetupStatusInput>;
