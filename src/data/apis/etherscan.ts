import { cache } from "../cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { resolveEtherscanApiKey, readUserConfig } from "../../config/user-config.js";
import type { SupportedChain } from "../../types/index.js";

const API_BASE: Record<SupportedChain, string> = {
  ethereum: "https://api.etherscan.io/api",
  arbitrum: "https://api.arbiscan.io/api",
  polygon: "https://api.polygonscan.com/api",
  base: "https://api.basescan.org/api",
};

export interface ContractInfo {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  /**
   * Etherscan-reported contract name. This is attacker-controllable at deploy
   * time — a malicious contract can set ContractName = "Aave V3 Pool" or bury
   * prompt-injection payloads in it. We sanitize to a short, safe subset
   * (alphanumerics / dots / underscores / dashes, ≤64 chars) and callers
   * should NOT display this field without that sanitization.
   */
  contractName?: string;
  compilerVersion?: string;
  abi?: unknown[];
}

/**
 * Sanitize a free-form name from Etherscan for agent/user display. Strips
 * anything that could carry a newline or steer the model (markdown fences,
 * angle brackets, braces, quotes) and caps length. We never want the raw
 * string hitting the agent transcript — it's attacker-controlled.
 */
export function sanitizeContractName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9._\-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
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

  // Bound the response before JSON-parsing. Etherscan has been well-behaved,
  // but the response is cached 24h in memory — an unbounded blob is both a
  // memory-pressure vector and gives a MITM with a broken TLS setup room to
  // inject a huge payload. 2MB covers the largest verified contracts we've
  // seen (fully-resolved imports of flattened DeFi protocols top out ~1MB)
  // with a comfortable margin.
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Etherscan response for ${address} on ${chain} exceeds ${MAX_RESPONSE_BYTES} bytes (got ${text.length}). Refusing to parse.`
    );
  }
  const body = JSON.parse(text) as EtherscanResponse<EtherscanSourceCodeItem[]>;

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
      const parsed = JSON.parse(item.ABI);
      // Cap ABI length. 5000 items is ~10× the largest proxy ABIs we've seen
      // (LiFi Diamond is ~1000 entries); anything bigger is either a pathological
      // contract or a hostile response trying to blow up memory on scan paths.
      const MAX_ABI_ITEMS = 5000;
      if (Array.isArray(parsed) && parsed.length <= MAX_ABI_ITEMS) {
        abi = parsed;
      } else {
        abi = undefined;
      }
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
    contractName: sanitizeContractName(item.ContractName),
    // Restrict compiler version to the safe pattern (e.g. v0.8.17+commit.8df45f5f)
    // so an attacker can't embed control characters or URLs in this field either.
    compilerVersion:
      item.CompilerVersion && /^[A-Za-z0-9.+_\-]+$/.test(item.CompilerVersion)
        ? item.CompilerVersion
        : undefined,
    abi,
    // sourceCode is attacker-controllable and huge; we never hand it to the
    // agent. Dropped entirely at the source rather than hoping downstream
    // code remembers not to surface it.
  };

  cache.set(key, info, CACHE_TTL.SECURITY_VERIFICATION);
  return info;
}
