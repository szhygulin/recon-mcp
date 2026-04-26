import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS, TRON_ADDRESS, SOLANA_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

const walletSchema = z
  .string()
  .regex(EVM_ADDRESS)
  .describe("0x-prefixed EVM wallet address (40 hex chars).");

const tronAddressSchema = z
  .string()
  .regex(TRON_ADDRESS)
  .describe("Base58 TRON mainnet address (prefix T, 34 chars).");

const solanaAddressSchema = z
  .string()
  .regex(SOLANA_ADDRESS)
  .describe("Base58 Solana mainnet address (ed25519 pubkey, 43 or 44 chars).");

const bitcoinAddressSchema = z
  .string()
  .min(26)
  .max(64)
  .describe(
    "Bitcoin mainnet address. Accepts legacy (1...), P2SH (3...), native " +
      "segwit (bc1q...), and taproot (bc1p...). Testnet/signet not supported."
  );

const litecoinAddressSchema = z
  .string()
  .min(26)
  .max(64)
  .describe(
    "Litecoin mainnet address. Accepts legacy (L...), P2SH (M.../3...), " +
      "native segwit (ltc1q...), and taproot (ltc1p...). Testnet/MWEB not supported."
  );

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
      "Single TRON mainnet address. With a single `wallet`: TRX + TRC-20 + " +
        "TRON staking are folded into the same per-wallet totals (`breakdown.tron`, " +
        "`tronUsd`, `tronStakingUsd`). With multi-wallet `wallets[]`: surfaced as " +
        "a parallel sibling slice on the response — see `nonEvm.tron` (issue #201). " +
        "Mutually exclusive with `tronAddresses`."
    ),
  tronAddresses: z
    .array(tronAddressSchema)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Multiple TRON addresses (Ledger account 0, 1, 2, …). Each is fetched " +
        "in parallel; the per-address slices are surfaced in `nonEvm.tron[]` " +
        "with rolled-up `tronUsd` / `tronStakingUsd` totals. 1-10 entries. " +
        "Mutually exclusive with `tronAddress`."
    ),
  solanaAddress: solanaAddressSchema
    .optional()
    .describe(
      "Single Solana mainnet address (base58, 43-44 chars). With a single " +
        "`wallet`: SOL + SPL + MarginFi + Kamino + Solana staking are folded into " +
        "per-wallet totals. With multi-wallet `wallets[]`: surfaced as a parallel " +
        "sibling slice (`nonEvm.solana`, issue #201). Mutually exclusive with " +
        "`solanaAddresses`. Requires `SOLANA_RPC_URL` or `solanaRpcUrl` user config."
    ),
  solanaAddresses: z
    .array(solanaAddressSchema)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Multiple Solana mainnet addresses. Each gets its own balances + " +
        "MarginFi + Kamino + staking subreaders fanned out in parallel. Per-" +
        "address slices in `nonEvm.solana[]` with rolled-up USD totals. 1-5 " +
        "entries (Solana subreaders are RPC-heavy — keep this lean). Mutually " +
        "exclusive with `solanaAddress`."
    ),
  bitcoinAddress: bitcoinAddressSchema
    .optional()
    .describe(
      "Single Bitcoin mainnet address. With a single `wallet`: BTC balance × " +
        "USD price is folded into per-wallet totals (`breakdown.bitcoin`, " +
        "`bitcoinUsd`). With multi-wallet `wallets[]`: surfaced in `nonEvm.bitcoin` " +
        "(issue #201). Mutually exclusive with `bitcoinAddresses`."
    ),
  bitcoinAddresses: z
    .array(bitcoinAddressSchema)
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Multiple Bitcoin addresses (e.g. legacy + segwit + taproot for the " +
        "same Ledger account, or several account-level scans). 1-20 entries; " +
        "per-address fetch errors degrade via `coverage.bitcoin`. Multi-wallet " +
        "mode aggregates ALL passed addresses into a single `nonEvm.bitcoin` " +
        "slice. Mutually exclusive with `bitcoinAddress`."
    ),
  litecoinAddress: litecoinAddressSchema
    .optional()
    .describe(
      "Single Litecoin mainnet address. Mirrors `bitcoinAddress`: with a " +
        "single `wallet`, LTC balance × USD price folds into per-wallet totals " +
        "(`breakdown.litecoin`, `litecoinUsd`); with `wallets[]`, surfaced in " +
        "`nonEvm.litecoin`. Mutually exclusive with `litecoinAddresses`. " +
        "Issue #274."
    ),
  litecoinAddresses: z
    .array(litecoinAddressSchema)
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Multiple Litecoin addresses (e.g. legacy + segwit + taproot for the " +
        "same Ledger account). 1-20 entries; per-address fetch errors degrade " +
        "via `coverage.litecoin`. Multi-wallet mode aggregates ALL passed " +
        "addresses into a single `nonEvm.litecoin` slice. Mutually exclusive " +
        "with `litecoinAddress`."
    ),
});

export type GetPortfolioSummaryArgs = z.infer<typeof getPortfolioSummaryInput>;
