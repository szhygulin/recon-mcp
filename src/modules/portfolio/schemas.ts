import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const getPortfolioSummaryInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

export type GetPortfolioSummaryArgs = z.infer<typeof getPortfolioSummaryInput>;
