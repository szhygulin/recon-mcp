import { cache } from "../cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { resolveEtherscanApiKey, readUserConfig } from "../../config/user-config.js";
import type { SupportedChain } from "../../types/index.js";

const API_BASE: Record<SupportedChain, string> = {
  ethereum: "https://api.etherscan.io/api",
  arbitrum: "https://api.arbiscan.io/api",
  polygon: "https://api.polygonscan.com/api",
};

export interface ContractInfo {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  contractName?: string;
  compilerVersion?: string;
  abi?: unknown[];
  sourceCode?: string;
}

interface EtherscanSourceCodeItem {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  Proxy: string;
  Implementation: string;
}

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

/**
 * Fetch contract verification info from Etherscan / Arbiscan.
 * Cached for 24 hours — verification state rarely changes.
 */
export async function getContractInfo(
  address: `0x${string}`,
  chain: SupportedChain
): Promise<ContractInfo> {
  const key = `etherscan:${chain}:${address.toLowerCase()}`;
  const hit = cache.get<ContractInfo>(key);
  if (hit) return hit;

  const apiKey = resolveEtherscanApiKey(readUserConfig());
  const params = new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
  });
  if (apiKey) params.set("apikey", apiKey);

  const url = `${API_BASE[chain]}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Etherscan request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as EtherscanResponse<EtherscanSourceCodeItem[]>;

  if (body.status !== "1" || !body.result?.[0]) {
    // Unverified contracts still return a valid response with empty SourceCode.
    const result: ContractInfo = {
      address,
      chain,
      isVerified: false,
      isProxy: false,
    };
    cache.set(key, result, CACHE_TTL.SECURITY_VERIFICATION);
    return result;
  }

  const item = body.result[0];
  const isVerified = item.SourceCode !== "";
  let abi: unknown[] | undefined;
  if (isVerified && item.ABI && item.ABI !== "Contract source code not verified") {
    try {
      abi = JSON.parse(item.ABI);
    } catch {
      abi = undefined;
    }
  }

  const info: ContractInfo = {
    address,
    chain,
    isVerified,
    isProxy: item.Proxy === "1",
    implementation: item.Implementation && /^0x[0-9a-fA-F]{40}$/.test(item.Implementation)
      ? (item.Implementation as `0x${string}`)
      : undefined,
    contractName: item.ContractName || undefined,
    compilerVersion: item.CompilerVersion || undefined,
    abi,
    sourceCode: isVerified ? item.SourceCode : undefined,
  };

  cache.set(key, info, CACHE_TTL.SECURITY_VERIFICATION);
  return info;
}
