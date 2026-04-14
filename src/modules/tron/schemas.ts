import { z } from "zod";

const tronAddress = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "expected base58 TRON mainnet address (prefix T, 34 chars)");

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

export const prepareTronClaimRewardsInput = z.object({
  from: tronAddress.describe(
    "Base58 TRON address to claim accumulated voting rewards for. TRON enforces a 24h cooldown between claims."
  ),
});

export type PrepareTronClaimRewardsArgs = z.infer<typeof prepareTronClaimRewardsInput>;
