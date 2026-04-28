import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const addressSchema = z.string().regex(EVM_ADDRESS);

export const checkContractSecurityInput = z.object({
  address: addressSchema,
  chain: chainEnum,
});

export const checkPermissionRisksInput = z.object({
  address: addressSchema,
  chain: chainEnum,
});

export const getProtocolRiskScoreInput = z.object({
  protocol: z.string().min(1),
});

export const getContractAbiInput = z.object({
  address: addressSchema.describe(
    "EVM contract address to fetch the ABI for. Etherscan V2 covers Ethereum + Arbitrum + " +
      "Polygon + Base + Optimism (the same five chains the rest of this MCP supports)."
  ),
  chain: chainEnum.describe(
    "Which chain the contract is deployed on. The same address can map to different contracts " +
      "on different chains; this arg disambiguates."
  ),
  followProxy: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "When the target is a proxy with a resolvable implementation, follow once to the " +
        "implementation's verified ABI (typical caller intent — you want the function selectors " +
        "the proxy delegates to, not the proxy's own admin surface). Set to false to inspect " +
        "the proxy's own ABI (e.g. when calling `upgradeTo` on the proxy itself). " +
        "`abiSource` in the response tells you which path was taken."
    ),
});

export type CheckContractSecurityArgs = z.infer<typeof checkContractSecurityInput>;
export type CheckPermissionRisksArgs = z.infer<typeof checkPermissionRisksInput>;
export type GetProtocolRiskScoreArgs = z.infer<typeof getProtocolRiskScoreInput>;
export type GetContractAbiArgs = z.infer<typeof getContractAbiInput>;
