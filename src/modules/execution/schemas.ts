import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";
import { EVM_ADDRESS, SOLANA_ADDRESS, TRON_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(EVM_ADDRESS);
const addressSchema = z.string().regex(EVM_ADDRESS);
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
  .regex(SOLANA_ADDRESS)
  .describe("Base58 Solana mainnet address (ed25519 pubkey, 43 or 44 chars).");

export const prepareSolanaNativeSendInput = z.object({
  wallet: solanaAddressSchema,
  to: solanaAddressSchema,
  amount: z
    .string()
    .max(50)
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
    .max(50)
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
    .max(50)
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
    .max(50)
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
    .max(50)
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
    .max(50)
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
    .max(50)
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

/**
 * Marinade liquid-staking action schemas. Both flows share the
 * durable-nonce-account requirement (ix[0] = nonceAdvance) so the wallet
 * must have run prepare_solana_nonce_init first.
 */
export const prepareMarinadeStakeInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that funds the deposit and receives mSOL. Must have an " +
      "initialized durable-nonce account (prepare_solana_nonce_init) and enough " +
      "SOL to cover the deposit + ATA rent (if mSOL ATA doesn't exist) + tx fee."
  ),
  amountSol: z
    .string()
    .max(50)
    .describe(
      'Human-readable SOL amount to stake (e.g. "1.5"). Decimals are SOL-native ' +
        '(9 dec); the builder rounds down to lamport precision.'
    ),
});

export const prepareMarinadeUnstakeImmediateInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that burns mSOL and receives SOL. Must have an initialized " +
      "durable-nonce account and an mSOL position to unstake from. Liquid unstake " +
      "routes through Marinade's liquidity pool (NOT delayed-unstake / OrderUnstake) " +
      "so the user pays a small fee but receives SOL in the same tx — no one-epoch wait."
  ),
  amountMSol: z
    .string()
    .max(50)
    .describe(
      'Human-readable mSOL amount to unstake (e.g. "1.5"). Builder converts to ' +
        'mSOL base units (9 dec) and rounds down.'
    ),
});

/**
 * Native Solana stake-program write actions. Stake account is deterministic
 * per (wallet, validator) — the same `(wallet, validator)` pair always
 * yields the same stake-account address. To exit a position, run
 * `prepare_native_stake_deactivate` (one-epoch cooldown), then
 * `prepare_native_stake_withdraw` once the cooldown lapses.
 */
export const prepareNativeStakeDelegateInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that funds the stake account and becomes its staker + " +
      "withdrawer authority. Must have an initialized durable-nonce account " +
      "(prepare_solana_nonce_init) and enough SOL to cover the stake amount + " +
      "rent-exempt seed (~0.00228 SOL) + tx fee. Refuses if a stake account " +
      "already exists at the deterministic address for this (wallet, validator)."
  ),
  validator: solanaAddressSchema.describe(
    "Vote-account address (NOT validator identity) of the validator to delegate " +
      "to. Solana's stake program delegates to vote accounts, which validators " +
      "publish alongside their identity. Use a Solana explorer to find the " +
      "vote account for a chosen validator."
  ),
  amountSol: z
    .string()
    .max(50)
    .describe(
      'Human-readable SOL amount to stake (e.g. "1.5"). Decimals are SOL-native ' +
        '(9). The actual lamports moved from the wallet are this value PLUS the ' +
        'stake account rent-exempt minimum (~0.00228 SOL); the rent-exempt floor ' +
        'is reclaimable on full withdraw after deactivation.'
    ),
});

export const prepareNativeStakeDeactivateInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet — must be the stake account's staker authority (the wallet " +
      "that originally created the stake)."
  ),
  stakeAccount: solanaAddressSchema.describe(
    "Base58 stake account address to deactivate. Discovery: call " +
      "get_solana_staking_positions; the wallet's native stake accounts are " +
      "listed under `native[].stakePubkey`. Deactivation takes one epoch " +
      "(~2-3 days); the stake earns no rewards during the cooldown but stays " +
      "non-withdrawable until it lapses."
  ),
});

export const prepareNativeStakeWithdrawInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet — must be the stake account's withdrawer authority + " +
      "receives the SOL. (For stakes created via prepare_native_stake_delegate, " +
      "wallet === staker === withdrawer; no authority handoff is supported in " +
      "this server.)"
  ),
  stakeAccount: solanaAddressSchema.describe(
    "Base58 stake account address to withdraw from. Stake must be inactive " +
      "(one full epoch after prepare_native_stake_deactivate). On-chain reverts " +
      "if the stake is still cooling down — the simulation gate catches it."
  ),
  amountSol: z
    .string()
    .max(50)
    .describe(
      'Human-readable SOL amount to withdraw (e.g. "1.5"), OR the literal ' +
        'string "max" to withdraw the full lamport balance (closes the stake ' +
        'account and reclaims the rent-exempt seed). Partial withdraws leave ' +
        'the account open with a smaller balance.'
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

/**
 * LiFi-on-Solana write action. Cross-chain bridges (Solana → EVM) and
 * in-chain swaps (Solana → Solana) share one tool surface; LiFi internally
 * picks the right protocol (Jupiter for in-chain, Wormhole / deBridge /
 * Mayan / Allbridge for bridges).
 *
 * For pure in-chain Solana swaps `prepare_solana_swap` (Jupiter, single
 * aggregator) is the more direct path — fewer hops, simpler routing.
 * Reach for `prepare_solana_lifi_swap` when you need Solana → EVM bridge
 * functionality, or you explicitly want LiFi's multi-aggregator routing
 * on Solana.
 */
export const prepareSolanaLifiSwapInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — funds the swap and signs the source tx. Must " +
      "have an initialized durable-nonce account (prepare_solana_nonce_init)."
  ),
  fromMint: z
    .string()
    .max(50)
    .describe(
      "Source token: SPL mint address (base58) or the literal string \"native\" " +
        "to swap SOL (LiFi maps \"native\" to wrapped-SOL internally; the wrap " +
        "ix is built into the route)."
    ),
  fromAmount: z
    .string()
    .max(50)
    .regex(/^\d+$/)
    .describe(
      "Raw integer amount in base units (NOT decimal-adjusted). Decimals are " +
        "the source token's decimals — e.g. 1 USDC (6 decimals) = '1000000', " +
        "1 SOL (9 decimals) = '1000000000'."
    ),
  toChain: z
    .enum([
      "solana",
      ...(SUPPORTED_CHAINS as unknown as [string, ...string[]]),
    ])
    .describe(
      "Destination chain. \"solana\" runs an in-chain swap (LiFi routes " +
        "through Jupiter / Orca / similar — consider prepare_solana_swap for " +
        "the more direct path). EVM chains run a cross-chain bridge."
    ),
  toToken: z
    .string()
    .max(80)
    .describe(
      "Destination token. SPL mint (base58) when toChain=\"solana\"; 0x-prefixed " +
        "EVM token address otherwise. \"native\" works on both (resolves to the " +
        "chain's conventional native sentinel)."
    ),
  toAddress: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Optional destination wallet. Defaults to the source wallet for in-chain " +
        "swaps. REQUIRED for cross-chain bridges since the Solana base58 source " +
        "wallet won't be a valid EVM-chain recipient."
    ),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%). Omit for LiFi's default " +
        "(0.5%). Cross-chain bridges may impose their own minimums above this."
    ),
});

/**
 * TRON-source LiFi swap / bridge. User signs a TRON tx via Ledger over
 * USB; the bridge protocol delivers tokens on the destination chain
 * (any EVM chain or Solana) after the source tx confirms.
 *
 * BLIND-SIGN on Ledger — the LiFi Diamond on TRON is not in the TRON
 * app's clear-sign allowlist. User must enable "Allow blind signing" in
 * the on-device Settings; the device then displays the txID (sha256 of
 * raw_data_hex), which the user matches against the txID printed in the
 * prepare receipt. TRC-20 source flows require a prior approve — this
 * tool does not prepare it; insufficient allowance reverts on-chain.
 */
export const prepareTronLifiSwapInput = z.object({
  wallet: z
    .string()
    .regex(TRON_ADDRESS)
    .describe(
      "TRON base58 wallet (T-prefixed, 34 chars) — funds the swap and signs " +
        "the source tx on Ledger via USB. Pair via `pair_ledger_tron` first."
    ),
  fromToken: z
    .string()
    .max(50)
    .describe(
      "Source token. T-prefixed TRC-20 contract address OR the literal string " +
        "\"native\" for TRX (LiFi maps \"native\" to TRX's contract address " +
        "internally). TRC-20 source REQUIRES a prior approve to the LiFi " +
        "Diamond on TRON (TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt) — this tool " +
        "does not prepare the approve; insufficient allowance reverts on-chain."
    ),
  fromAmount: z
    .string()
    .max(50)
    .regex(/^\d+$/)
    .describe(
      "Raw integer amount in base units (NOT decimal-adjusted). For TRX (6 decimals) " +
        "1 TRX = '1000000'; for TRC-20 USDT (6 decimals) 10 USDT = '10000000'."
    ),
  toChain: z
    .enum([
      ...(SUPPORTED_CHAINS as unknown as [string, ...string[]]),
      "solana",
    ])
    .describe(
      "Destination chain. Any EVM chain (cross-chain bridge to EVM) or \"solana\" " +
        "(cross-chain bridge to Solana). LiFi internally picks the best bridge " +
        "protocol (NearIntents, Wormhole, Allbridge, etc.)."
    ),
  toToken: z
    .string()
    .max(80)
    .describe(
      "Destination token. 0x-prefixed EVM token when toChain is EVM; SPL mint base58 " +
        "when toChain=\"solana\". \"native\" works on both (resolves to the chain's " +
        "conventional native sentinel)."
    ),
  toAddress: z
    .string()
    .max(80)
    .describe(
      "Destination wallet — REQUIRED. EVM hex when toChain is EVM; Solana base58 " +
        "when toChain=\"solana\". The TRON source wallet isn't a valid recipient on " +
        "either destination chain family."
    ),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%). Omit for LiFi's default " +
        "(0.5%). Cross-chain bridges may impose their own minimums above this."
    ),
});

/**
 * No args — `get_vaultpilot_config_status` returns a structured snapshot of
 * the local server config, intended for diagnostic / onboarding flows.
 * The output deliberately never echoes any secret values (API keys, RPC
 * URLs that may carry keys, full WC session topics) — every field is
 * either a boolean, a count, a category enum, or a session-topic suffix
 * (last 8 chars).
 */
export const getVaultPilotConfigStatusInput = z.object({});

/**
 * No args — `get_ledger_device_info` opens a USB HID transport to the
 * connected Ledger, issues the dashboard-level GET_APP_AND_VERSION APDU
 * (CLA=0xb0 INS=0x01), and returns the name/version of the currently-
 * open app. Read-only, one USB round-trip, closes the transport before
 * returning.
 */
export const getLedgerDeviceInfoInput = z.object({});

export const getMarginfiPositionsInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet to enumerate MarginFi positions for. Probes the first 4 MarginfiAccount " +
      "PDAs under this wallet (accountIndex 0..3) and returns one entry per existing account."
  ),
});

export const getSolanaStakingPositionsInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet to enumerate staking positions for. Returns three sections: " +
      "Marinade (mSOL LST balance + SOL-equivalent via on-chain exchange rate), Jito " +
      "(jitoSOL LST balance + SOL-equivalent), and native stake accounts (SPL stake-program " +
      "accounts this wallet has withdrawer authority on, with activation status). Read-only."
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
    .max(50)
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
    .max(50)
    .describe('Human-readable ETH amount, NOT raw wei. Example: "0.5" for 0.5 ETH.'),
});
export const prepareLidoUnstakeInput = z.object({
  wallet: walletSchema,
  amountStETH: z
    .string()
    .max(50)
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
    .max(50)
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
    .max(50)
    .describe(
      'Human-readable native-asset amount, NOT raw wei. Example: "0.5" for 0.5 ETH (or 0.5 MATIC on polygon).'
    ),
});

export const prepareWethUnwrapInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  amount: z
    .string()
    .max(50)
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
    .max(50)
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
      "Required for EVM and Solana (ignored for TRON — TRON has no preview step). " +
        "Opaque token returned by the preceding `preview_send` (EVM) or `preview_solana_send` " +
        "(Solana) call in its top-level JSON response. Must be passed back verbatim here — a " +
        "mismatch or omission proves preview was skipped or re-run after capture, and " +
        "send_transaction refuses. Closes the gap where the agent collapses preview + send into " +
        "one step without surfacing the CHECKS PERFORMED block to the user."
    ),
  userDecision: z
    .literal("send")
    .optional()
    .describe(
      "Required on every chain (EVM / Solana / TRON). The agent sets this to the literal " +
        "\"send\" AFTER presenting the CHECKS PERFORMED block (EVM / Solana) or the " +
        "VERIFY-BEFORE-SIGNING block (TRON) and receiving the user's explicit 'send' reply. " +
        "Schema-enforced contract that the preview-time / prepare-time summary was surfaced to " +
        "the user, not skipped. Missing value → send_transaction refuses with a clear error."
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
      "Solana only, legacy-blockhash txs (currently just `nonce_init`). Block-height " +
        "ceiling for the tx's baked blockhash — returned by send_transaction for such " +
        "txs. When supplied and `getSignatureStatuses` returns null, the poller " +
        "compares against current block height and reports `dropped` if the window " +
        "has passed. Omit for EVM / TRON; ignored on those chains. For durable-nonce " +
        "Solana txs (every send this server builds except nonce_init), use " +
        "`durableNonce` instead — it's authoritative."
    ),
  durableNonce: z
    .object({
      noncePubkey: z.string(),
      nonceValue: z.string(),
    })
    .optional()
    .describe(
      "Solana only, durable-nonce txs (native_send, spl_send, nonce_close, " +
        "jupiter_swap, all marginfi_* actions). Returned by send_transaction on these " +
        "flows. When supplied and `getSignatureStatuses` returns null, the poller " +
        "reads the on-chain nonce account: if the nonce rotated past `nonceValue` " +
        "(or the account was closed), the tx can never land and is reported as " +
        "`dropped` with diagnostic fields `nonceAccount` / `bakedNonce` / " +
        "`currentNonce`. Without this field the poller reports `pending` forever " +
        "for dropped durable-nonce txs — a known Phase 2 UX gap."
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
export type PrepareMarinadeStakeArgs = z.infer<typeof prepareMarinadeStakeInput>;
export type PrepareMarinadeUnstakeImmediateArgs = z.infer<
  typeof prepareMarinadeUnstakeImmediateInput
>;
export type PrepareNativeStakeDelegateArgs = z.infer<
  typeof prepareNativeStakeDelegateInput
>;
export type PrepareNativeStakeDeactivateArgs = z.infer<
  typeof prepareNativeStakeDeactivateInput
>;
export type PrepareNativeStakeWithdrawArgs = z.infer<
  typeof prepareNativeStakeWithdrawInput
>;
export type GetMarginfiPositionsArgs = z.infer<typeof getMarginfiPositionsInput>;
export type GetSolanaStakingPositionsArgs = z.infer<typeof getSolanaStakingPositionsInput>;
export type GetSolanaSetupStatusArgs = z.infer<typeof getSolanaSetupStatusInput>;
export type PrepareSolanaLifiSwapArgs = z.infer<typeof prepareSolanaLifiSwapInput>;
export type PrepareTronLifiSwapArgs = z.infer<typeof prepareTronLifiSwapInput>;

/**
 * Kamino lending — first-time setup. Creates the user lookup table +
 * userMetadata PDA + obligation PDA in a single tx. Required prerequisite
 * before any prepare_kamino_supply / borrow / withdraw / repay call.
 *
 * Refuses if the wallet already has Kamino userMetadata. Use
 * prepare_kamino_supply directly for initialized wallets.
 */
export const prepareKaminoInitUserInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — funds the LUT (~0.014 SOL rent) + obligation PDA " +
      "(~0.012 SOL rent) + userMetadata PDA (~0.002 SOL rent). Must have an " +
      "initialized durable-nonce account (prepare_solana_nonce_init)."
  ),
});

/**
 * Kamino lending — supply liquidity to a reserve. The wallet MUST have
 * already run prepare_kamino_init_user (the builder refuses on missing
 * userMetadata or obligation with a clear error pointing at init).
 */
export const prepareKaminoSupplyInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — funds the deposit + tx fee. Must have already " +
      "run prepare_kamino_init_user."
  ),
  mint: solanaAddressSchema.describe(
    "Base58 SPL mint address of the asset to supply. Must be listed on Kamino's " +
      "main market — refuses otherwise. Common Kamino reserves: USDC, USDT, SOL, " +
      "JitoSOL, mSOL, JLP, JUP, BONK."
  ),
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable amount to supply (e.g. "100" for 100 USDC, "0.5" for 0.5 SOL). ' +
        "Decimals are resolved from the reserve's mint metadata; pass the human value, " +
        "not raw base units."
    ),
});

export type PrepareKaminoInitUserArgs = z.infer<typeof prepareKaminoInitUserInput>;
export type PrepareKaminoSupplyArgs = z.infer<typeof prepareKaminoSupplyInput>;
export type GetVaultPilotConfigStatusArgs = z.infer<typeof getVaultPilotConfigStatusInput>;
export type GetLedgerDeviceInfoArgs = z.infer<typeof getLedgerDeviceInfoInput>;
