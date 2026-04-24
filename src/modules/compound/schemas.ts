import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z
  .string()
  .regex(EVM_ADDRESS)
  .describe("0x-prefixed EVM wallet address (40 hex chars) that will execute this action.");
const addressSchema = z.string().regex(EVM_ADDRESS);

export const getCompoundPositionsInput = z.object({
  wallet: walletSchema,
  chains: z
    .array(chainEnum)
    .optional()
    .describe(
      "Subset of chains to scan for Compound V3 markets. Omit to scan all supported chains."
    ),
});

const baseCometAction = z.object({
  wallet: walletSchema,
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain the Comet market lives on. Defaults to ethereum."),
  market: addressSchema.describe(
    "Comet market address (e.g. cUSDCv3). Discover via get_compound_positions or the Compound registry."
  ),
  asset: addressSchema.describe(
    "ERC-20 token address being supplied or withdrawn — either the market's base token or a listed collateral token."
  ),
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount of `asset`, NOT raw wei/base units. ' +
        'Example: "10" for 10 USDC. Pass "max" for full-balance withdraw.'
    ),
});

export const prepareCompoundSupplyInput = baseCometAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareCompoundWithdrawInput = baseCometAction;

/** Convenience wrappers — borrow = withdraw(baseToken); repay = supply(baseToken). */
export const prepareCompoundBorrowInput = z.object({
  wallet: walletSchema,
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain the Comet market lives on. Defaults to ethereum."),
  market: addressSchema.describe(
    "Comet market address (e.g. cUSDCv3). The base token is resolved on-chain."
  ),
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount of the market base token, NOT raw wei/base units. Example: "100" for 100 USDC.'
    ),
});
export const prepareCompoundRepayInput = prepareCompoundBorrowInput.extend({
  approvalCap: approvalCapSchema,
});

export const getCompoundMarketInfoInput = z.object({
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain the Comet market lives on. Defaults to ethereum."),
  market: addressSchema.describe(
    "Comet market address (e.g. cUSDCv3 at 0xc3d688B66703497DAA19211EEdff47f25384cdc3 on Ethereum)."
  ),
});

export type GetCompoundMarketInfoArgs = z.infer<typeof getCompoundMarketInfoInput>;

export type GetCompoundPositionsArgs = z.infer<typeof getCompoundPositionsInput>;
export type PrepareCompoundSupplyArgs = z.infer<typeof prepareCompoundSupplyInput>;
export type PrepareCompoundWithdrawArgs = z.infer<typeof prepareCompoundWithdrawInput>;
export type PrepareCompoundBorrowArgs = z.infer<typeof prepareCompoundBorrowInput>;
export type PrepareCompoundRepayArgs = z.infer<typeof prepareCompoundRepayInput>;
