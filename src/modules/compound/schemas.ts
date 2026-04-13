import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

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
  /** Comet market address (e.g. cUSDCv3) — use get_compound_positions or the contract registry to find these. */
  market: addressSchema,
  asset: addressSchema,
  /** Human-readable amount, or "max" for withdraw. */
  amount: z.string(),
});

export const prepareCompoundSupplyInput = baseCometAction;
export const prepareCompoundWithdrawInput = baseCometAction;

/** Convenience wrappers — borrow = withdraw(baseToken); repay = supply(baseToken). */
export const prepareCompoundBorrowInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  market: addressSchema,
  amount: z.string(),
});
export const prepareCompoundRepayInput = prepareCompoundBorrowInput;

export type GetCompoundPositionsArgs = z.infer<typeof getCompoundPositionsInput>;
export type PrepareCompoundSupplyArgs = z.infer<typeof prepareCompoundSupplyInput>;
export type PrepareCompoundWithdrawArgs = z.infer<typeof prepareCompoundWithdrawInput>;
export type PrepareCompoundBorrowArgs = z.infer<typeof prepareCompoundBorrowInput>;
export type PrepareCompoundRepayArgs = z.infer<typeof prepareCompoundRepayInput>;
