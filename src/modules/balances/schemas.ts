import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
]);

export const getTokenBalanceInput = z.object({
  wallet: walletSchema,
  /** "native" for the chain's native coin, otherwise an ERC-20 contract address. */
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
