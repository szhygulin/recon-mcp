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

export const pairLedgerBitcoinInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Ledger Bitcoin account slot. One call enumerates ALL FOUR address types " +
        "for the given index (legacy at `44'/0'/<n>'/...`, p2sh-segwit at " +
        "`49'/0'/<n>'/...`, native segwit at `84'/0'/<n>'/...`, taproot at " +
        "`86'/0'/<n>'/...`) AND walks both the receive (`/0/i`) and change " +
        "(`/1/i`) chains using BIP44 gap-limit scanning so a previously-used " +
        "wallet's later-index funds aren't missed. 0 = first Bitcoin account, " +
        "1 = second, etc. Omit for the default (index 0). Call again with a " +
        "different index to expose more accounts; calling with the same index " +
        "refreshes the cache."
    ),
  gapLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "BIP44 gap limit — stop walking each (type, chain) after this many " +
        "consecutive addresses with zero on-chain history. Default 20 (matches " +
        "Electrum / Sparrow / Trezor Suite / Ledger Live). Lower values speed " +
        "the scan up but risk missing funds across larger gaps; raise it for " +
        "wallets that may have skipped indices. Capped at 100."
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

/**
 * Jito stake-pool deposit. Mirrors the Marinade-stake schema shape but
 * uses the SPL stake-pool program directly via raw `StakePoolInstruction`
 * builders (no ephemeral keypair — Ledger-compatible). Withdraw flows
 * are not yet exposed; see `src/modules/solana/jito.ts` doc-comment for
 * the rationale.
 */
export const prepareJitoStakeInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana wallet that funds the deposit and receives jitoSOL. Must have an " +
      "initialized durable-nonce account (prepare_solana_nonce_init) and enough " +
      "SOL to cover the deposit + jitoSOL ATA rent (~0.002 SOL if the ATA " +
      "doesn't exist yet) + tx fee.",
  ),
  amountSol: z
    .string()
    .max(50)
    .describe(
      'Human-readable SOL amount to stake (e.g. "1.5"). Decimals are SOL-native ' +
        "(9 dec); the builder rounds down to lamport precision.",
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

/**
 * `prepare_revoke_approval` — build an `approve(spender, 0)` tx that
 * sets the allowance `wallet` previously granted `spender` on `token`
 * back to zero. Read-side counterpart is the planned
 * `get_token_allowances`. Refuses when the current allowance is
 * already 0 — that call would be a no-op gas burn.
 */
export const prepareRevokeApprovalInput = z.object({
  wallet: walletSchema.describe(
    "EVM wallet that owns the existing allowance. Must be the address that " +
      "originally called approve(spender, value); only the owner can set the " +
      "allowance back to zero."
  ),
  chain: chainEnum.default("ethereum"),
  token: addressSchema.describe(
    "ERC-20 contract address. Must be the actual token contract — wrappers " +
      "and aTokens have their own approval surfaces and aren't supported here."
  ),
  spender: addressSchema.describe(
    "Address whose allowance to revoke. Typically a protocol contract " +
      "(Aave V3 Pool, Uniswap SwapRouter, etc.) or any EOA the user previously " +
      "approved. Get the live list via the read-side allowances tool."
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
    .enum([...SUPPORTED_CHAINS, "tron", "solana", "bitcoin"] as unknown as [
      string,
      ...string[],
    ])
    .describe("EVM chain, 'tron', 'solana', or 'bitcoin'."),
  txHash: z
    .string()
    .regex(/^(0x)?[a-fA-F0-9]{64}$|^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
    .describe(
      "Transaction identifier. EVM: 32-byte hex (0x-prefixed or bare). TRON: 32-byte bare hex. " +
        "Solana: 64-byte signature as base58 (86–88 chars). Bitcoin: 32-byte bare hex. " +
        "All four forms are accepted."
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
export type PairLedgerBitcoinArgs = z.infer<typeof pairLedgerBitcoinInput>;
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
export type PrepareRevokeApprovalArgs = z.infer<typeof prepareRevokeApprovalInput>;
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
export type PrepareJitoStakeArgs = z.infer<typeof prepareJitoStakeInput>;
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

/**
 * Kamino borrow / withdraw / repay share the same arg shape as supply
 * (wallet + mint + amount); we keep them as separate schemas so the
 * tool descriptions can document the per-action constraints (LTV gate,
 * existing-deposit / existing-debt requirements, on-chain revert
 * conditions) inline.
 */
export const prepareKaminoBorrowInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — must already have Kamino userMetadata + obligation."
  ),
  mint: solanaAddressSchema.describe(
    "Base58 SPL mint of the asset to borrow against the obligation's collateral."
  ),
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable amount to borrow (e.g. "100" for 100 USDC). Decimals are ' +
        "resolved from the reserve's mint metadata. The on-chain program enforces " +
        "the borrow LTV gate; if the borrow would push the obligation over the " +
        "liquidation limit, the tx reverts (caught by the simulation gate)."
    ),
});

export const prepareKaminoWithdrawInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — must already have a Kamino deposit in the named reserve."
  ),
  mint: solanaAddressSchema,
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable amount to withdraw. The reserve must have an active deposit ' +
        "from this wallet — the builder refuses with a clear error otherwise. " +
        "Health-factor gated on-chain: a withdraw that would leave the obligation " +
        "under-collateralized for outstanding debt reverts."
    ),
});

export const prepareKaminoRepayInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet — must already have outstanding debt in the named reserve."
  ),
  mint: solanaAddressSchema,
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable amount to repay. The on-chain program clamps repayment at ' +
        "outstanding debt; over-repaying just doesn't burn the excess (no funds " +
        "lost). Refuses with a clear error if the wallet has no debt in the reserve."
    ),
});

export const getKaminoPositionsInput = z.object({
  wallet: solanaAddressSchema.describe(
    "Solana base58 wallet to enumerate Kamino positions for. Returns the wallet's " +
      "obligation on Kamino's main market, with per-reserve deposits + borrows + " +
      "USD valuations + health factor. Returns an empty list when the wallet has " +
      "no Kamino userMetadata (= never used Kamino)."
  ),
});

export type PrepareKaminoBorrowArgs = z.infer<typeof prepareKaminoBorrowInput>;
export type PrepareKaminoWithdrawArgs = z.infer<typeof prepareKaminoWithdrawInput>;
export type PrepareKaminoRepayArgs = z.infer<typeof prepareKaminoRepayInput>;
export type GetKaminoPositionsArgs = z.infer<typeof getKaminoPositionsInput>;

/**
 * Bitcoin (Phase 1) — read-only schemas.
 *
 * Address validation is deliberately a string-with-format-check rather
 * than a tight regex schema: Bitcoin has 4 distinct mainnet address
 * shapes (P2PKH `1...`, P2SH `3...`, native segwit `bc1q...`, taproot
 * `bc1p...`) of varying lengths, so the runtime validator in
 * `src/modules/btc/address.ts` is the source of truth.
 */
const bitcoinAddressSchema = z
  .string()
  .min(26)
  .max(64)
  .describe(
    "Bitcoin mainnet address. Accepts legacy (1...), P2SH (3...), native " +
      "segwit (bc1q...), and taproot (bc1p...). Testnet/signet not supported."
  );

export const getBitcoinBalanceInput = z.object({
  address: bitcoinAddressSchema,
});

export const getBitcoinBalancesInput = z.object({
  addresses: z
    .array(bitcoinAddressSchema)
    .min(1)
    .max(20)
    .describe(
      "1-20 Bitcoin addresses to fetch in parallel. Per-address errors are " +
        "surfaced as `errored` entries rather than failing the whole call."
    ),
});

export const getBitcoinFeeEstimatesInput = z.object({});

export const getBitcoinBlockTipInput = z.object({});

export const getLitecoinBlockTipInput = z.object({});

export const getBitcoinBlocksRecentInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(144)
    .describe(
      "How many recent blocks to fetch, newest-first. Default 144 (~one day on BTC). Capped at 200 to bound HTTP fan-out on free-tier indexers."
    ),
});

export const getLitecoinBlocksRecentInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(144)
    .describe(
      "How many recent blocks to fetch, newest-first. Default 144 (~6h on LTC at 2.5-min blocks). Capped at 200 to bound HTTP fan-out on litecoinspace.org's tighter free tier."
    ),
});

// ---------- Issue #248: optional bitcoind / litecoind RPC-tier tools ----------
// Schemas for 6 forensic-tier tools (3 per chain) that require an
// RPC endpoint. When the endpoint isn't configured, each tool returns
// a structured `unavailable` shape — never silently fails. See
// `src/data/jsonrpc.ts` and `src/modules/utxo/rpc-client.ts`.

export const getBitcoinChainTipsInput = z.object({});
export const getLitecoinChainTipsInput = z.object({});

const blockStatsHashOrHeight = z
  .union([
    z.string().regex(/^[0-9a-fA-F]{64}$/, {
      message: "block hash must be 64 hex chars",
    }),
    z.number().int().min(0).max(20_000_000),
  ])
  .describe(
    "Either a 64-hex block hash OR a block height. The RPC method `getblockstats` accepts both forms — pick whichever the agent already has on hand."
  );

export const getBitcoinBlockStatsInput = z.object({
  hashOrHeight: blockStatsHashOrHeight,
});
export const getLitecoinBlockStatsInput = z.object({
  hashOrHeight: blockStatsHashOrHeight,
});

export const getBitcoinMempoolSummaryInput = z.object({});
export const getLitecoinMempoolSummaryInput = z.object({});

export const getBitcoinAccountBalanceInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "Ledger Bitcoin account slot to aggregate. Must have been paired via " +
        "`pair_ledger_btc` first — the tool fans out across every cached " +
        "USED address (txCount > 0 at scan time) for this accountIndex, sums " +
        "their on-chain balances, and surfaces the per-address breakdown so the " +
        "agent can show which legs hold the funds. Empty cached addresses are " +
        "skipped to keep the response tight; if you suspect the cache is stale, " +
        "call `rescan_btc_account` (indexer-only, no Ledger needed)."
    ),
});

export const rescanBitcoinAccountInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "Ledger Bitcoin account slot to rescan. Must already be paired (call " +
        "`pair_ledger_btc` first). Re-queries the indexer for the live " +
        "`txCount` of every cached address under this account and updates " +
        "the persisted cache — useful after the user has received funds or " +
        "the indexer was stale at original scan time. Pure indexer-side: no " +
        "Ledger / USB interaction. Returns: `needsExtend: true` when the " +
        "trailing empty address on any cached chain now has history (re-pair " +
        "to extend the walked window); `unverifiedChains: [...]` when the " +
        "tail probe ITSELF rejected (transient indexer hiccup, status " +
        "indeterminate — re-run `rescan_btc_account` rather than re-pairing)."
    ),
});

export const prepareBitcoinNativeSendInput = z.object({
  wallet: z
    .union([bitcoinAddressSchema, z.array(bitcoinAddressSchema).min(1).max(20)])
    .describe(
      "One paired Bitcoin source address (string), OR an array of 1-20 paired " +
        "source addresses for multi-input consolidation (issue #264). All " +
        "addresses must belong to the SAME Ledger account (same accountIndex + " +
        "addressType) — Phase 1 mixed-type sends (segwit + taproot in one tx) " +
        "are out of scope. UTXOs are fetched in parallel for every listed " +
        "source and merged into one coin-selection pool. \"max\" sweeps every " +
        "UTXO from every listed wallet into a single output. Phase 1 sends only " +
        "support native segwit (`bc1q...`) and taproot (`bc1p...`) sources; " +
        "legacy (`1...`) and P2SH-wrapped (`3...`) sends are deferred."
    ),
  to: bitcoinAddressSchema.describe(
    "Bitcoin recipient address. Any of the four mainnet types is accepted as " +
      "a destination — the restriction is only on the source side."
  ),
  amount: z
    .string()
    .max(50)
    .regex(/^(max|\d+(\.\d{1,8})?)$/)
    .describe(
      'Decimal BTC string (up to 8 fractional digits, e.g. "0.001") or "max" ' +
        "to sweep the full balance minus fees. \"max\" picks the fee-aware amount " +
        "after coin-selection so the user doesn't have to subtract fees by hand."
    ),
  feeRateSatPerVb: z
    .number()
    .positive()
    .max(10000)
    .optional()
    .describe(
      "Fee rate in sat/vB. Optional — when omitted, uses mempool.space's " +
        "`halfHourFee` recommendation (~3-block confirm target). Override for " +
        "priority sends through congestion. Capped at 10000 sat/vB for safety."
    ),
  rbf: z
    .boolean()
    .optional()
    .describe(
      "BIP-125 Replace-By-Fee. Default true → sequence 0xFFFFFFFD on every " +
        "input, marking the tx replaceable so the user can fee-bump if it stalls. " +
        "Set false → 0xFFFFFFFE (final, not replaceable). RBF is the default for " +
        "every modern wallet."
    ),
  allowHighFee: z
    .boolean()
    .optional()
    .describe(
      "Override the fee-cap guard. The cap is `max(10 × feeRate × vbytes, 2% " +
        "of total output value)`. Legitimate priority sends through heavy " +
        "congestion can exceed it; pass true after confirming with the user."
    ),
});

export const prepareBitcoinRbfBumpInput = z.object({
  wallet: bitcoinAddressSchema.describe(
    "Paired Bitcoin source address that signed the original tx. Phase 1 " +
      "scope: native segwit (`bc1q...`) and taproot (`bc1p...`) only. " +
      "Multi-source RBF (replacing a tx whose inputs span several wallets) " +
      "is out of scope — every input on the original tx must come from this " +
      "single address."
  ),
  txid: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .describe(
      "64-hex txid of the stuck mempool tx to replace. Must currently be " +
        "unconfirmed and BIP-125 RBF-eligible (sequence < 0xFFFFFFFE on at " +
        "least one input — true by default for every tx `prepare_btc_send` " +
        "produces). Already-confirmed and final-marked txs are refused."
    ),
  newFeeRate: z
    .number()
    .positive()
    .max(10_000)
    .describe(
      "New fee rate in sat/vB. Must satisfy BIP-125 rule 4: the new absolute " +
        "fee must be at least the old absolute fee plus 1 sat/vB × new vsize. " +
        "The replacement preserves every recipient verbatim and shrinks the " +
        "change output to absorb the bump — refused if the bump would push " +
        "change below the dust threshold (546 sats)."
    ),
  allowHighFee: z
    .boolean()
    .optional()
    .describe(
      "Override the fee-cap guard. The cap is `max(10 × newFeeRate × vbytes, " +
        "2% of recipient output value)`. Legitimate priority bumps through " +
        "heavy congestion can exceed it; pass true after confirming with the " +
        "user."
    ),
});

export const registerBitcoinMultisigWalletInput = z.object({
  name: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[\x20-\x7e]+$/)
    .describe(
      "User-chosen label for the multi-sig setup, e.g. \"Family vault\". Must be " +
        "printable ASCII, ≤ 16 bytes (Ledger BTC app caps wallet-policy names at " +
        "16 bytes). Surfaces on-device during the registration approval flow and " +
        "is the lookup key for `sign_btc_multisig_psbt`. Must be unique within the " +
        "registered wallet set."
    ),
  threshold: z
    .number()
    .int()
    .min(1)
    .max(15)
    .describe(
      "M in M-of-N. Must be ≥ 1 and ≤ cosigner count. Phase 2 hard-caps at 15 (the " +
        "Ledger BTC app's wallet-policy limit)."
    ),
  cosigners: z
    .array(
      z.object({
        xpub: z
          .string()
          .min(1)
          .describe(
            "BIP-32 extended public key (xpub / Ypub / Zpub form) for this signer slot. " +
              "Round-trips through @scure/bip32 for checksum validation — a typo silently " +
              "registers a wrong wallet that can never sign, so we hard-validate."
          ),
        masterFingerprint: z
          .string()
          .regex(/^[0-9a-fA-F]{8}$/)
          .describe(
            "4-byte master fingerprint as 8 hex chars (lowercase preferred but case-insensitive). " +
              "Each cosigner gets it from `getmasterfingerprint` on their wallet (Ledger / " +
              "Sparrow / Specter all expose it)."
          ),
        derivationPath: z
          .string()
          .min(1)
          .describe(
            "BIP-32 derivation path leading to `xpub`, NO leading `m/`. Standard BIP-48 " +
              "P2WSH multisig: \"48'/0'/0'/2'\" (account 0). The wildcard suffix `/<change>/<index>` " +
              "is appended at signing time via the descriptor template — supply only the account-level " +
              "path here."
          ),
      })
    )
    .min(2)
    .max(15)
    .describe(
      "Cosigner slots in the order they should appear in the descriptor's `@N` slots. " +
        "Slot order is part of the descriptor identity — every cosigner must agree on " +
        "the same ordering or they'll register different wallets. Exactly one entry's " +
        "fingerprint+xpub must match the connected Ledger; the device flags it `isOurs` " +
        "and uses it for signing. Phase 2 requires ≥ 2 cosigners (1-of-1 is single-sig)."
    ),
  scriptType: z
    .literal("wsh")
    .describe(
      "Script type for the multi-sig wrapper. Phase 2 supports \"wsh\" only (P2WSH " +
        "native segwit, `bc1q...`-style addresses). Taproot multi-sig and P2SH-wrapped " +
        "multi-sig are deferred."
    ),
});

export const signBitcoinMultisigPsbtInput = z.object({
  walletName: z
    .string()
    .min(1)
    .max(16)
    .describe(
      "Name of a previously-registered multi-sig wallet (matches the `name` passed to " +
        "`register_btc_multisig_wallet`). Refused if no wallet is registered under " +
        "this name."
    ),
  psbtBase64: z
    .string()
    .min(1)
    .max(200_000)
    .describe(
      "Base64-encoded PSBT v0 from the initiator. Every input must carry a " +
        "`bip32_derivation` entry for our master fingerprint, or we refuse to forward " +
        "to the device. The Ledger app then walks every output (address + amount) " +
        "on-device and asks for confirmation; the user MUST verify the on-device walk " +
        "matches the chat-side verification block before approving. Cap of ~200 KB to " +
        "bound transport buffer + on-device parsing time."
    ),
});

export const getBitcoinTxHistoryInput = z.object({
  address: bitcoinAddressSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Max number of txs to return (newest-first). Default 25; capped at 50 " +
        "(one Esplora page). Pagination beyond this is a follow-up."
    ),
});

export type GetBitcoinBalanceArgs = z.infer<typeof getBitcoinBalanceInput>;
export type GetBitcoinBalancesArgs = z.infer<typeof getBitcoinBalancesInput>;
export type GetBitcoinFeeEstimatesArgs = z.infer<typeof getBitcoinFeeEstimatesInput>;
export type GetBitcoinBlockTipArgs = z.infer<typeof getBitcoinBlockTipInput>;
export type GetLitecoinBlockTipArgs = z.infer<typeof getLitecoinBlockTipInput>;
export type GetBitcoinBlocksRecentArgs = z.infer<typeof getBitcoinBlocksRecentInput>;
export type GetLitecoinBlocksRecentArgs = z.infer<typeof getLitecoinBlocksRecentInput>;
export type GetBitcoinChainTipsArgs = z.infer<typeof getBitcoinChainTipsInput>;
export type GetLitecoinChainTipsArgs = z.infer<typeof getLitecoinChainTipsInput>;
export type GetBitcoinBlockStatsArgs = z.infer<typeof getBitcoinBlockStatsInput>;
export type GetLitecoinBlockStatsArgs = z.infer<typeof getLitecoinBlockStatsInput>;
export type GetBitcoinMempoolSummaryArgs = z.infer<typeof getBitcoinMempoolSummaryInput>;
export type GetLitecoinMempoolSummaryArgs = z.infer<typeof getLitecoinMempoolSummaryInput>;
export type GetBitcoinAccountBalanceArgs = z.infer<
  typeof getBitcoinAccountBalanceInput
>;
export type RescanBitcoinAccountArgs = z.infer<
  typeof rescanBitcoinAccountInput
>;
export const signBtcMessageInput = z.object({
  wallet: bitcoinAddressSchema.describe(
    "Paired Bitcoin source address. Must already be in `pairings.bitcoin` " +
      "(call `pair_ledger_btc` first). Phase 1 message-signing supports legacy " +
      "(`1...`), P2SH-wrapped (`3...`), and native segwit (`bc1q...`); taproot " +
      "(`bc1p...`) is refused because BIP-322 — taproot's canonical scheme — " +
      "is not yet exposed by the Ledger BTC app."
  ),
  message: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "UTF-8 message to sign. Typical Sign-In-with-Bitcoin payloads are a " +
        "few hundred chars; capped at 10000 because the Ledger BTC app's " +
        "on-device review window chunks the message into 16-char segments " +
        "and a multi-KB string isn't realistically reviewable."
    ),
});

export type GetBitcoinTxHistoryArgs = z.infer<typeof getBitcoinTxHistoryInput>;
export type PrepareBitcoinNativeSendArgs = z.infer<typeof prepareBitcoinNativeSendInput>;
export type RegisterBitcoinMultisigWalletArgs = z.infer<
  typeof registerBitcoinMultisigWalletInput
>;
export type SignBitcoinMultisigPsbtArgs = z.infer<typeof signBitcoinMultisigPsbtInput>;
export type PrepareBitcoinRbfBumpArgs = z.infer<typeof prepareBitcoinRbfBumpInput>;
export type SignBtcMessageArgs = z.infer<typeof signBtcMessageInput>;
export type GetVaultPilotConfigStatusArgs = z.infer<typeof getVaultPilotConfigStatusInput>;
export type GetLedgerDeviceInfoArgs = z.infer<typeof getLedgerDeviceInfoInput>;

/**
 * Litecoin (initial release) — minimal core surface: pair, single-address
 * balance, send, and message-sign. Multi-address read, fee estimates,
 * block tip, account-level balance, rescan, tx-history, and portfolio
 * integration are deferred to a follow-up PR.
 */
const litecoinAddressSchema = z
  .string()
  .min(26)
  .max(64)
  .describe(
    "Litecoin mainnet address. Accepts legacy (L...), P2SH (M...), legacy " +
      "P2SH (3...), native segwit (ltc1q...), or taproot (ltc1p...). Note " +
      "that Litecoin Core has not activated Taproot on mainnet, so ltc1p... " +
      "outputs derive but are not yet spendable. Testnet (tltc1...) and " +
      "MWEB (ltcmweb1...) addresses are not supported."
  );

export const pairLedgerLitecoinInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Ledger Litecoin account slot. One call enumerates ALL FOUR address " +
        "types (legacy at `44'/2'/<n>'/...`, p2sh-segwit at `49'/2'/<n>'/...`, " +
        "native segwit at `84'/2'/<n>'/...`, taproot at `86'/2'/<n>'/...`) " +
        "AND walks both receive (`/0/i`) and change (`/1/i`) chains using " +
        "BIP44 gap-limit scanning. 0 = first Litecoin account, 1 = second, etc."
    ),
  gapLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "BIP44 gap limit — stop walking each (type, chain) after this many " +
        "consecutive addresses with zero on-chain history. Default 20."
    ),
});

export const getLitecoinBalanceInput = z.object({
  address: litecoinAddressSchema,
});

export const prepareLitecoinNativeSendInput = z.object({
  wallet: z
    .union([litecoinAddressSchema, z.array(litecoinAddressSchema).min(1).max(20)])
    .describe(
      "One paired Litecoin source address (string), OR an array of 1-20 paired " +
        "source addresses for multi-input consolidation (issue #264). All " +
        "addresses must belong to the SAME Ledger account (same accountIndex + " +
        "addressType). UTXOs are fetched in parallel and merged into one " +
        "coin-selection pool. Initial release sends only support native segwit " +
        "(`ltc1q...`) and taproot (`ltc1p...`) source addresses; legacy " +
        "(`L...`) and P2SH-wrapped (`M.../3...`) sends are deferred."
    ),
  to: litecoinAddressSchema.describe(
    "Litecoin recipient address. L/M/ltc1q/ltc1p accepted. Legacy 3-prefix " +
      "P2SH is rejected on send (it's read-supported only) — ask the recipient " +
      "for an M-prefix address."
  ),
  amount: z
    .string()
    .max(50)
    .regex(/^(max|\d+(\.\d{1,8})?)$/)
    .describe(
      'Decimal LTC string (up to 8 fractional digits, e.g. "0.001") or "max" ' +
        "to sweep the full balance minus fees."
    ),
  feeRateSatPerVb: z
    .number()
    .positive()
    .max(10000)
    .optional()
    .describe(
      "Fee rate in litoshi/vB. Optional — when omitted, uses the indexer's " +
        "halfHourFee recommendation."
    ),
  rbf: z.boolean().optional().describe("BIP-125 RBF. Default true."),
  allowHighFee: z.boolean().optional(),
});

export const signLtcMessageInput = z.object({
  wallet: litecoinAddressSchema.describe(
    "Paired Litecoin source address. Must already be in `pairings.litecoin`. " +
      "Taproot (`ltc1p...`) is refused — BIP-322 is not yet exposed by the " +
      "Ledger Litecoin app."
  ),
  message: z
    .string()
    .min(1)
    .max(10_000)
    .describe("UTF-8 message to sign."),
});

export const rescanLitecoinAccountInput = z.object({
  accountIndex: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "Ledger Litecoin account slot to rescan. Must already be paired (call " +
        "`pair_ledger_ltc` first). Re-queries the indexer for the live " +
        "`txCount` of every cached address under this account and updates " +
        "the persisted cache — useful after the user has received funds or " +
        "the indexer was stale at original scan time. Pure indexer-side: no " +
        "Ledger / USB interaction. Returns: `needsExtend: true` when the " +
        "trailing empty address on any cached chain now has history (re-pair " +
        "to extend the walked window); `unverifiedChains: [...]` when the " +
        "tail probe ITSELF rejected (transient indexer hiccup, status " +
        "indeterminate — re-run `rescan_ltc_account` rather than re-pairing)."
    ),
});

export type PairLedgerLitecoinArgs = z.infer<typeof pairLedgerLitecoinInput>;
export type GetLitecoinBalanceArgs = z.infer<typeof getLitecoinBalanceInput>;
export type PrepareLitecoinNativeSendArgs = z.infer<typeof prepareLitecoinNativeSendInput>;
export type SignLtcMessageArgs = z.infer<typeof signLtcMessageInput>;
export type RescanLitecoinAccountArgs = z.infer<typeof rescanLitecoinAccountInput>;

// Uniswap V3 LP — first slice of Milestone 1 in
// `claude-work/plan-dex-liquidity-provision.md`. v1: WETH-on-both-sides
// (no native-ETH refund-via-multicall — follow-up).
export const prepareUniswapV3MintInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  tokenA: addressSchema.describe(
    "First token in the LP pair. Pass either order; the builder canonically " +
      "sorts to (token0, token1) before submission. Native ETH is NOT supported " +
      "in v1 — wrap to WETH first via prepare_native_send to the WETH contract.",
  ),
  tokenB: addressSchema.describe(
    "Second token in the LP pair. Must differ from tokenA.",
  ),
  feeTier: z
    .union([z.literal(100), z.literal(500), z.literal(3000), z.literal(10000)])
    .describe(
      "Pool fee in hundredths of a bip: 100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%. " +
        "Each fee tier is a separate pool; pick the one that matches the pair's volatility.",
    ),
  tickLower: z
    .number()
    .int()
    .describe(
      "Lower tick of the position's price range. MUST align to the fee tier's " +
        "tickSpacing (100→1, 500→10, 3000→60, 10000→200) — mis-aligned ticks are rejected. " +
        "Use Uniswap UI or a tick-from-price helper to derive the value; passing arbitrary " +
        "ints risks creating a position at a price the user did not intend.",
    ),
  tickUpper: z
    .number()
    .int()
    .describe(
      "Upper tick. Must be > tickLower and aligned to tickSpacing.",
    ),
  amountADesired: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount of tokenA to deposit. Example: "100.5" for ' +
        '100.5 USDC. NOT raw wei. Pass "0" for a single-sided range deposit when ' +
        "the current price is outside the range and only the other token is needed.",
    ),
  amountBDesired: z
    .string()
    .max(50)
    .describe("Human-readable decimal amount of tokenB. Same shape as amountADesired."),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (1 bp = 0.01%). Default 50 bps (0.5%). " +
        "Hard ceiling 500 bps; soft cap 100 bps requires acknowledgeHighSlippage: true. " +
        "Higher slippage masks bad fills and is a sandwich-bait misconfiguration.",
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Required when slippageBps is in (100, 500]. Surface the trade-off to the user " +
        "before proceeding — wide slippage on an LP mint locks the unfavourable amounts.",
    ),
  deadlineSec: z
    .number()
    .int()
    .min(60)
    .max(3600)
    .optional()
    .describe(
      "Seconds from now until the on-chain `deadline` parameter expires. Default 1200 (20 min).",
    ),
  recipient: addressSchema
    .optional()
    .describe(
      "Address to receive the minted LP NFT. Default: wallet (the depositor).",
    ),
  approvalCap: approvalCapSchema,
});

export type PrepareUniswapV3MintArgs = z.infer<typeof prepareUniswapV3MintInput>;
