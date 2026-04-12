import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
]);

const baseSwapSchema = z.object({
  wallet: walletSchema,
  fromChain: chainEnum,
  toChain: chainEnum,
  fromToken: tokenSchema,
  toToken: tokenSchema,
  /** Human-readable amount (e.g. "1.5"); the tool will resolve decimals. */
  amount: z.string(),
  /** Fallback decimals in case the tool can't resolve them (rare — native is 18). */
  fromTokenDecimals: z.number().int().min(0).max(36).optional(),
  slippageBps: z.number().int().min(1).max(5000).optional(),
});

export const getSwapQuoteInput = baseSwapSchema;
export const prepareSwapInput = baseSwapSchema;

export type GetSwapQuoteArgs = z.infer<typeof getSwapQuoteInput>;
export type PrepareSwapArgs = z.infer<typeof prepareSwapInput>;
