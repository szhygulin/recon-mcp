import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

export const getMarketIncidentStatusInput = z.object({
  protocol: z
    .enum(["compound-v3"])
    .describe(
      "Lending protocol to scan. Currently only compound-v3 is supported. Aave V3 pauses are per-reserve; Morpho Blue has no core-protocol pause."
    ),
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain to scan. Defaults to ethereum."),
});

export type GetMarketIncidentStatusArgs = z.infer<typeof getMarketIncidentStatusInput>;
