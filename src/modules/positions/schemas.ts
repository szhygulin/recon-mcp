import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed EVM address");

export const getLendingPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export const getLpPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export const getHealthAlertsInput = z.object({
  wallet: walletSchema,
  threshold: z.number().min(1).max(10).optional().default(1.5),
});

export const simulatePositionChangeInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.optional().default("ethereum"),
  action: z.enum(["add_collateral", "remove_collateral", "borrow", "repay"]),
  asset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** Amount in USD (base currency) — we approximate since asset price lookups are cheap. */
  amountUsd: z.number().positive(),
});

export type GetLendingPositionsArgs = z.infer<typeof getLendingPositionsInput>;
export type GetLpPositionsArgs = z.infer<typeof getLpPositionsInput>;
export type GetHealthAlertsArgs = z.infer<typeof getHealthAlertsInput>;
export type SimulatePositionChangeArgs = z.infer<typeof simulatePositionChangeInput>;
