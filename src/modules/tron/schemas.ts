import { z } from "zod";
import { TRON_ADDRESS } from "../../shared/address-patterns.js";

const tronAddress = z
  .string()
  .regex(TRON_ADDRESS, "expected base58 TRON mainnet address (prefix T, 34 chars)");

const amountString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "expected a positive decimal number (e.g. \"1.5\")");

export const getTronStakingInput = z.object({
  address: tronAddress.describe(
    "Base58 TRON mainnet address (prefix T) — the wallet to read staking state for."
  ),
});

export type GetTronStakingArgs = z.infer<typeof getTronStakingInput>;

export const prepareTronNativeSendInput = z.object({
  from: tronAddress.describe("Base58 TRON sender address (prefix T)."),
  to: tronAddress.describe("Base58 TRON recipient address (prefix T)."),
  amount: amountString.describe("TRX amount as a human-readable decimal string (e.g. \"12.5\")."),
});

export type PrepareTronNativeSendArgs = z.infer<typeof prepareTronNativeSendInput>;

export const prepareTronTokenSendInput = z.object({
  from: tronAddress.describe("Base58 TRON sender address (prefix T)."),
  to: tronAddress.describe("Base58 TRON recipient address (prefix T)."),
  token: tronAddress.describe(
    "Base58 TRC-20 contract address. Phase 2 only supports the canonical set (USDT, USDC, USDD, TUSD); other TRC-20s are rejected."
  ),
  amount: amountString.describe(
    "Token amount as a human-readable decimal string (decimals are resolved from the canonical table: 6 for USDT/USDC, 18 for USDD/TUSD)."
  ),
  feeLimitTrx: amountString
    .optional()
    .describe("Optional fee-limit override in TRX. Defaults to 100 TRX — Ledger Live / TronLink standard."),
});

export type PrepareTronTokenSendArgs = z.infer<typeof prepareTronTokenSendInput>;

/**
 * TRC-20 `approve(spender, amount)` — sets ERC-20-style allowance on a
 * TRC-20 contract so a third-party (typically the LiFi Diamond on TRON
 * for `prepare_tron_lifi_swap` flows) can pull tokens via transferFrom.
 *
 * Unlike `prepare_tron_token_send`, this tool accepts ANY TRC-20 contract
 * — not just the canonical set — because LiFi's routing graph covers
 * many tokens we don't list canonically. When the token isn't in the
 * canonical table, `decimals` MUST be passed; otherwise the builder
 * rejects (we won't fall back to assuming 6 or 18 — silent decimals
 * mismatch would mean an off-by-orders-of-magnitude allowance).
 */
export const prepareTronTrc20ApproveInput = z.object({
  from: tronAddress.describe("Base58 TRON owner address — the wallet that holds the tokens."),
  token: tronAddress.describe(
    "Base58 TRC-20 contract address. Any TRC-20 is accepted; non-canonical tokens require `decimals`."
  ),
  spender: tronAddress.describe(
    "Base58 TRON address authorized to pull tokens via transferFrom. Typical use: the LiFi Diamond on TRON (TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt) for `prepare_tron_lifi_swap` flows."
  ),
  amount: amountString.describe(
    "Allowance amount as a human-readable decimal string. Pass exactly the amount you intend to swap, NOT \"max\" / unbounded — TRC-20 unbounded approvals are a known griefing vector and we don't expose them by default."
  ),
  decimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe(
      "Token decimals. OPTIONAL when `token` is in the canonical TRC-20 set (USDT/USDC=6, USDD/TUSD=18 — auto-resolved). REQUIRED for any other TRC-20 contract; we refuse to guess decimals when an off-by-power-of-ten allowance could authorize a 10^12-fold larger spend than intended."
    ),
  feeLimitTrx: amountString
    .optional()
    .describe("Optional fee-limit override in TRX. Defaults to 100 TRX (TronLink/Ledger Live standard)."),
});

export type PrepareTronTrc20ApproveArgs = z.infer<typeof prepareTronTrc20ApproveInput>;

export const prepareTronClaimRewardsInput = z.object({
  from: tronAddress.describe(
    "Base58 TRON address to claim accumulated voting rewards for. TRON enforces a 24h cooldown between claims."
  ),
});

export type PrepareTronClaimRewardsArgs = z.infer<typeof prepareTronClaimRewardsInput>;

const tronResource = z
  .enum(["bandwidth", "energy"])
  .describe(
    "Which Stake 2.0 resource to freeze/unfreeze TRX for. `bandwidth` fuels plain transactions; `energy` fuels smart-contract calls."
  );

export const prepareTronFreezeInput = z.object({
  from: tronAddress.describe("Base58 TRON owner address (prefix T)."),
  amount: amountString.describe(
    "TRX amount to freeze as a human-readable decimal string (converted to SUN internally)."
  ),
  resource: tronResource,
});

export type PrepareTronFreezeArgs = z.infer<typeof prepareTronFreezeInput>;

export const prepareTronUnfreezeInput = z.object({
  from: tronAddress.describe("Base58 TRON owner address (prefix T)."),
  amount: amountString.describe(
    "TRX amount to unfreeze. Must not exceed the currently-frozen amount for the given resource — TronGrid rejects otherwise."
  ),
  resource: tronResource,
});

export type PrepareTronUnfreezeArgs = z.infer<typeof prepareTronUnfreezeInput>;

export const prepareTronWithdrawExpireUnfreezeInput = z.object({
  from: tronAddress.describe(
    "Base58 TRON owner address. Sweeps all unfreezes whose 14-day cooldown has elapsed (see `pendingUnfreezes[].unlockAt` from `get_tron_staking`) back to liquid TRX."
  ),
});

export type PrepareTronWithdrawExpireUnfreezeArgs = z.infer<
  typeof prepareTronWithdrawExpireUnfreezeInput
>;

export const listTronWitnessesInput = z.object({
  address: tronAddress
    .optional()
    .describe(
      "Optional base58 TRON address. When provided, the response also includes the wallet's current vote allocation, total TRON Power (frozenV2 sum in whole TRX), and remaining available votes — diff these against your target allocation before building `prepare_tron_vote`."
    ),
  includeCandidates: z
    .boolean()
    .optional()
    .describe(
      "Include SR candidates (rank > 27) alongside the active top 27. Candidates don't produce blocks so their voter APR is 0. Defaults to false."
    ),
});

export type ListTronWitnessesArgs = z.infer<typeof listTronWitnessesInput>;

export const prepareTronVoteInput = z.object({
  from: tronAddress.describe("Base58 TRON owner address (prefix T)."),
  votes: z
    .array(
      z.object({
        address: tronAddress.describe("Base58 SR or candidate address to vote for."),
        count: z
          .number()
          .int()
          .positive()
          .describe("Integer vote count — 1 vote consumes 1 TRX of TRON Power."),
      })
    )
    .describe(
      "Full vote allocation. VoteWitness REPLACES all prior votes atomically — pass every SR you intend to back, not just the delta. An empty array clears all votes. Sum of counts must not exceed the wallet's available TRON Power (see `list_tron_witnesses` → `availableVotes`); TronGrid rejects otherwise."
    ),
});

export type PrepareTronVoteArgs = z.infer<typeof prepareTronVoteInput>;
