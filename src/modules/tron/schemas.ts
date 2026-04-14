import { z } from "zod";

const tronAddress = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "expected base58 TRON mainnet address (prefix T, 34 chars)");

export const getTronStakingInput = z.object({
  address: tronAddress.describe(
    "Base58 TRON mainnet address (prefix T) — the wallet to read staking state for."
  ),
});

export type GetTronStakingArgs = z.infer<typeof getTronStakingInput>;
