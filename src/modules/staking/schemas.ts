import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed EVM address")
  .describe("0x-prefixed EVM wallet address (40 hex chars) to inspect.");

export const getStakingPositionsInput = z.object({
  wallet: walletSchema,
  chains: z
    .array(chainEnum)
    .optional()
    .describe(
      "Subset of chains to scan. Omit to scan all chains where staking is supported (Lido: ethereum + arbitrum; EigenLayer: ethereum only)."
    ),
});

export const getStakingRewardsInput = z.object({
  wallet: walletSchema,
  period: z
    .enum(["7d", "30d", "90d", "1y"])
    .optional()
    .default("30d")
    .describe("Lookback window for aggregating accrued rewards. Defaults to 30d."),
});

export const estimateStakingYieldInput = z.object({
  protocol: z
    .enum(["lido", "eigenlayer"])
    .describe(
      'Which staking protocol to project yield for. "lido" = native ETH liquid staking (stETH APR); "eigenlayer" = restaking (LST deposit APR, protocol-dependent).'
    ),
  amount: z
    .number()
    .positive()
    .describe(
      "Human-readable decimal amount of the staked asset (ETH for lido, LST for eigenlayer). Example: 1.5 for 1.5 ETH."
    ),
});

export type GetStakingPositionsArgs = z.infer<typeof getStakingPositionsInput>;
export type GetStakingRewardsArgs = z.infer<typeof getStakingRewardsInput>;
export type EstimateStakingYieldArgs = z.infer<typeof estimateStakingYieldInput>;
