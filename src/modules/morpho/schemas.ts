import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const marketIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

export const getMorphoPositionsInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  /** Morpho Blue market IDs (bytes32 each) to check. Discover via the Morpho app or subgraph. */
  marketIds: z.array(marketIdSchema).min(1),
});

const baseMarketAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  marketId: marketIdSchema,
  /** Human-readable amount. "max" supported for withdraw/repay. */
  amount: z.string(),
});

export const prepareMorphoSupplyInput = baseMarketAction;
export const prepareMorphoWithdrawInput = baseMarketAction;
export const prepareMorphoBorrowInput = baseMarketAction;
export const prepareMorphoRepayInput = baseMarketAction;
export const prepareMorphoSupplyCollateralInput = baseMarketAction;
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
