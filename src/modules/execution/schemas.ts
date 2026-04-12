import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const dataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const pairLedgerLiveInput = z.object({});

export const getLedgerStatusInput = z.object({});

const baseAaveAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  asset: addressSchema,
  amount: z.string(), // "1.5" human-readable, or "max" for withdraw/repay
});

export const prepareAaveSupplyInput = baseAaveAction;
export const prepareAaveWithdrawInput = baseAaveAction;
export const prepareAaveBorrowInput = baseAaveAction.extend({
  interestRateMode: z.enum(["stable", "variable"]).default("variable"),
});
export const prepareAaveRepayInput = baseAaveAction.extend({
  interestRateMode: z.enum(["stable", "variable"]).default("variable"),
});

export const prepareLidoStakeInput = z.object({
  wallet: walletSchema,
  amountEth: z.string(),
});
export const prepareLidoUnstakeInput = z.object({
  wallet: walletSchema,
  amountStETH: z.string(),
});

export const prepareEigenLayerDepositInput = z.object({
  wallet: walletSchema,
  strategy: addressSchema,
  token: addressSchema,
  amount: z.string(),
});

export const sendTransactionInput = z.object({
  chain: chainEnum,
  to: addressSchema,
  data: dataSchema,
  value: z.string().default("0"),
  from: walletSchema.optional(),
  /** Gate: the model must explicitly confirm on the user's behalf that the preview was acknowledged. */
  confirmed: z.literal(true),
});

export const getTransactionStatusInput = z.object({
  chain: chainEnum,
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export type PrepareAaveSupplyArgs = z.infer<typeof prepareAaveSupplyInput>;
export type PrepareAaveWithdrawArgs = z.infer<typeof prepareAaveWithdrawInput>;
export type PrepareAaveBorrowArgs = z.infer<typeof prepareAaveBorrowInput>;
export type PrepareAaveRepayArgs = z.infer<typeof prepareAaveRepayInput>;
export type PrepareLidoStakeArgs = z.infer<typeof prepareLidoStakeInput>;
export type PrepareLidoUnstakeArgs = z.infer<typeof prepareLidoUnstakeInput>;
export type PrepareEigenLayerDepositArgs = z.infer<typeof prepareEigenLayerDepositInput>;
export type SendTransactionArgs = z.infer<typeof sendTransactionInput>;
export type GetTransactionStatusArgs = z.infer<typeof getTransactionStatusInput>;
