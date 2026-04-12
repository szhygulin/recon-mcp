import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

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

export type CheckContractSecurityArgs = z.infer<typeof checkContractSecurityInput>;
export type CheckPermissionRisksArgs = z.infer<typeof checkPermissionRisksInput>;
export type GetProtocolRiskScoreArgs = z.infer<typeof getProtocolRiskScoreInput>;
