import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed EVM wallet address (40 hex chars).");

/**
 * Raw shape — MCP requires a bare ZodObject (no .refine) so it can expose `.shape`
 * to build the JSON schema. Cross-field validation is enforced in the handler.
 */
export const getPortfolioSummaryInput = z.object({
  wallet: walletSchema
    .optional()
    .describe(
      "Single wallet address. Provide this OR `wallets` (not both). Use `wallets` for multi-wallet aggregated reports."
    ),
  wallets: z
    .array(walletSchema)
    .min(1)
    .optional()
    .describe(
      "Multiple wallet addresses to aggregate into one combined portfolio view. Mutually exclusive with `wallet`."
    ),
  chains: z
    .array(chainEnum)
    .optional()
    .describe(
      "Subset of supported chains to scan (ethereum, arbitrum, polygon, base). Omit to scan all supported chains."
    ),
});

export type GetPortfolioSummaryArgs = z.infer<typeof getPortfolioSummaryInput>;
