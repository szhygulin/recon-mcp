import { z } from "zod";
import { ALL_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(ALL_CHAINS as unknown as [string, ...string[]]);
/**
 * Either an EVM 0x address or a TRON mainnet base58 address. The handler
 * cross-checks that the address shape matches the chain, since MCP needs
 * the raw ZodObject here (can't use .refine at the schema root).
 */
const walletSchema = z.union([
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
]);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
]);

export const getTokenBalanceInput = z.object({
  wallet: walletSchema,
  /**
   * "native" for the chain's native coin (ETH / MATIC / TRX). Otherwise an
   * ERC-20 address on EVM chains or a base58 TRC-20 contract on TRON.
   */
  token: tokenSchema,
  chain: chainEnum.default("ethereum"),
});

export const resolveNameInput = z.object({
  name: z.string().min(3),
});

export const reverseResolveInput = z.object({
  address: walletSchema,
});

export type GetTokenBalanceArgs = z.infer<typeof getTokenBalanceInput>;
export type ResolveNameArgs = z.infer<typeof resolveNameInput>;
export type ReverseResolveArgs = z.infer<typeof reverseResolveInput>;
