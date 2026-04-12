import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed EVM address");

export const getStakingPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export const getStakingRewardsInput = z.object({
  wallet: walletSchema,
  period: z.enum(["7d", "30d", "90d", "1y"]).optional().default("30d"),
});

export const estimateStakingYieldInput = z.object({
  protocol: z.enum(["lido", "eigenlayer"]),
  amount: z.number().positive(),
});

export type GetStakingPositionsArgs = z.infer<typeof getStakingPositionsInput>;
export type GetStakingRewardsArgs = z.infer<typeof getStakingRewardsInput>;
export type EstimateStakingYieldArgs = z.infer<typeof estimateStakingYieldInput>;
