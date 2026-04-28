import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS, SOLANA_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(EVM_ADDRESS, "must be a 0x-prefixed EVM address");
const solanaWalletSchema = z
  .string()
  .regex(SOLANA_ADDRESS, "must be a base58 Solana address (43–44 chars)");

export const getLendingPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export const getLpPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export const getHealthAlertsInput = z.object({
  /**
   * EVM wallet (Aave V3 / Compound V3 / Morpho Blue coverage). Optional
   * since a user may hold lending positions only on Solana — but at least
   * one of `wallet` / `solanaWallet` MUST be provided.
   */
  wallet: walletSchema.optional(),
  /**
   * Solana wallet (MarginFi + Kamino coverage). Optional but mirrors the
   * EVM wallet rule: at least one address must be supplied.
   */
  solanaWallet: solanaWalletSchema.optional(),
  threshold: z.number().min(1).max(10).optional().default(1.5),
});

export const simulatePositionChangeInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.optional().default("ethereum"),
  action: z.enum(["add_collateral", "remove_collateral", "borrow", "repay"]),
  asset: z.string().regex(EVM_ADDRESS),
  /** Amount in USD (base currency) — we approximate since asset price lookups are cheap. */
  amountUsd: z.number().positive(),
  /**
   * Which lending protocol this simulation targets. Defaults to "aave-v3".
   * When "compound-v3", pass `market` (Comet address). When "morpho-blue",
   * pass `marketId` (bytes32).
   */
  protocol: z
    .enum(["aave-v3", "compound-v3", "morpho-blue"])
    .optional()
    .default("aave-v3"),
  /** Compound V3 Comet market address (required when protocol="compound-v3"). */
  market: z
    .string()
    .regex(EVM_ADDRESS)
    .optional(),
  /** Morpho Blue market id (required when protocol="morpho-blue"). */
  marketId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
});

export type GetLendingPositionsArgs = z.infer<typeof getLendingPositionsInput>;
export type GetLpPositionsArgs = z.infer<typeof getLpPositionsInput>;
export type GetHealthAlertsArgs = z.infer<typeof getHealthAlertsInput>;
export type SimulatePositionChangeArgs = z.infer<typeof simulatePositionChangeInput>;
