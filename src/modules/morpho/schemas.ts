import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z
  .string()
  .regex(EVM_ADDRESS)
  .describe("0x-prefixed EVM wallet address (40 hex chars) that will execute this action.");
const marketIdSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .describe(
    "Morpho Blue market id — 32-byte hex (0x + 64 hex chars). Identifies the market's (loanToken, collateralToken, oracle, irm, lltv) tuple. Discover via get_morpho_positions."
  );

export const getMorphoPositionsInput = z.object({
  wallet: walletSchema,
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain Morpho Blue is deployed on. Currently only ethereum is enabled."),
  marketIds: z
    .array(marketIdSchema)
    .optional()
    .describe(
      "Morpho Blue market ids (bytes32 each) to check. If omitted, the server auto-discovers the wallet's markets by scanning Morpho Blue event logs (Supply / Borrow / SupplyCollateral with onBehalf == wallet). Pass explicitly as a fast path — cold discovery walks from Morpho's deploy block to head in ~10k-block chunks and can take several seconds."
    ),
});

const baseMarketAction = z.object({
  wallet: walletSchema,
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain Morpho Blue is deployed on. Currently only ethereum is enabled."),
  marketId: marketIdSchema,
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. ' +
        'Example: "10" for 10 USDC. Pass "max" for full-balance withdraw/repay.'
    ),
});

export const prepareMorphoSupplyInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoWithdrawInput = baseMarketAction;
export const prepareMorphoBorrowInput = baseMarketAction;
export const prepareMorphoRepayInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoSupplyCollateralInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoWithdrawCollateralInput = baseMarketAction;

export type GetMorphoPositionsArgs = z.infer<typeof getMorphoPositionsInput>;
export type PrepareMorphoSupplyArgs = z.infer<typeof prepareMorphoSupplyInput>;
export type PrepareMorphoWithdrawArgs = z.infer<typeof prepareMorphoWithdrawInput>;
export type PrepareMorphoBorrowArgs = z.infer<typeof prepareMorphoBorrowInput>;
export type PrepareMorphoRepayArgs = z.infer<typeof prepareMorphoRepayInput>;
export type PrepareMorphoSupplyCollateralArgs = z.infer<typeof prepareMorphoSupplyCollateralInput>;
export type PrepareMorphoWithdrawCollateralArgs = z.infer<
  typeof prepareMorphoWithdrawCollateralInput
>;
