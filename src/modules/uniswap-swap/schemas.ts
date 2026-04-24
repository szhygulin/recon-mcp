import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(EVM_ADDRESS);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(EVM_ADDRESS),
]);

export const prepareUniswapSwapInput = z.object({
  wallet: walletSchema,
  chain: chainEnum,
  fromToken: tokenSchema,
  toToken: tokenSchema,
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. Example: "1.5" for ' +
        '1.5 USDC, "0.01" for 0.01 ETH. Interpreted as fromToken input by default; ' +
        'set `amountSide: "to"` for exact-out. The tool resolves decimals on-chain.'
    ),
  amountSide: z
    .enum(["from", "to"])
    .optional()
    .describe(
      'Which side of the swap `amount` refers to. "from" (default) = exact-in: ' +
        'spend exactly `amount` of fromToken, receive a variable output. "to" = ' +
        'exact-out: receive exactly `amount` of toToken, input sized to hit the target.'
    ),
  fromTokenDecimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe("Optional decimals hint for fromToken if on-chain lookup fails. Native is 18."),
  toTokenDecimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe("Optional decimals hint for toToken if on-chain lookup fails. Native is 18."),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%). Default 50. Hard-capped at 500 " +
        "(5%); > 100 requires `acknowledgeHighSlippage: true` to prevent MEV sandwiching."
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Opt-in flag required when slippageBps > 100. Forces explicit acknowledgement " +
        "of unusually-high slippage."
    ),
  feeTier: z
    .union([z.literal(100), z.literal(500), z.literal(3000), z.literal(10000)])
    .optional()
    .describe(
      "Optional fee-tier override (100 / 500 / 3000 / 10000 bps). When omitted, " +
        "QuoterV2 is queried across all four tiers and the best-pricing pool is picked."
    ),
});

export type PrepareUniswapSwapArgs = z.infer<typeof prepareUniswapSwapInput>;
