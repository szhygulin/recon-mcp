import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed EVM wallet address (40 hex chars).");

const tronAddressSchema = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/)
  .describe("Base58 TRON mainnet address (prefix T, 34 chars).");

const solanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  .describe("Base58 Solana mainnet address (ed25519 pubkey, 43 or 44 chars).");

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
  tronAddress: tronAddressSchema
    .optional()
    .describe(
      "TRON mainnet address. When provided alongside a single `wallet`, TRX + TRC-20 balances and TRON staking are folded into the same portfolio total (`breakdown.tron`, `tronUsd`, `tronStakingUsd`). Multi-wallet mode + tronAddress is ambiguous and throws — call once per EVM wallet in that case."
    ),
  solanaAddress: solanaAddressSchema
    .optional()
    .describe(
      "Solana mainnet address (base58, 43 or 44 chars). When provided, SOL + enumerated SPL token balances are folded into the same portfolio total (`breakdown.solana`, `solanaUsd`). Multi-wallet mode + solanaAddress is ambiguous and throws — call once per EVM wallet in that case. Requires SOLANA_RPC_URL or `solanaRpcUrl` user config (Helius recommended; public mainnet RPC is rate-limited)."
    ),
});

export type GetPortfolioSummaryArgs = z.infer<typeof getPortfolioSummaryInput>;
