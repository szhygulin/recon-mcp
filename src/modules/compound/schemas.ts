import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const getCompoundPositionsInput = z.object({
  wallet: walletSchema,
  chains: z.array(chainEnum).optional(),
});

const baseCometAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  market: addressSchema.describe(
    "Comet market address (e.g. cUSDCv3). Discover via get_compound_positions or the Compound registry."
  ),
  asset: addressSchema,
  amount: z
    .string()
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
  chain: chainEnum.default("ethereum"),
  market: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of the market base token, NOT raw wei/base units. Example: "100" for 100 USDC.'
    ),
});
export const prepareCompoundRepayInput = prepareCompoundBorrowInput.extend({
  approvalCap: approvalCapSchema,
});

export type GetCompoundPositionsArgs = z.infer<typeof getCompoundPositionsInput>;
export type PrepareCompoundSupplyArgs = z.infer<typeof prepareCompoundSupplyInput>;
export type PrepareCompoundWithdrawArgs = z.infer<typeof prepareCompoundWithdrawInput>;
export type PrepareCompoundBorrowArgs = z.infer<typeof prepareCompoundBorrowInput>;
export type PrepareCompoundRepayArgs = z.infer<typeof prepareCompoundRepayInput>;
