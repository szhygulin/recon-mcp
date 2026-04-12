import { checkContractSecurity } from "./verification.js";
import { checkPermissionRisks } from "./permissions.js";
import { getProtocolRiskScore } from "./risk-score.js";
import type {
  CheckContractSecurityArgs,
  CheckPermissionRisksArgs,
  GetProtocolRiskScoreArgs,
} from "./schemas.js";
import type { SupportedChain } from "../../types/index.js";

export async function checkContractSecurityHandler(args: CheckContractSecurityArgs) {
  return checkContractSecurity(args.address as `0x${string}`, args.chain as SupportedChain);
}

export async function checkPermissionRisksHandler(args: CheckPermissionRisksArgs) {
  return checkPermissionRisks(args.address as `0x${string}`, args.chain as SupportedChain);
}

export async function getProtocolRiskScoreHandler(args: GetProtocolRiskScoreArgs) {
  return getProtocolRiskScore(args.protocol);
}
