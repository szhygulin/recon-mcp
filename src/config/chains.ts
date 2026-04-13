import { mainnet, arbitrum, polygon } from "viem/chains";
import type { Chain } from "viem";
import type { RpcProvider, SupportedChain, UserConfig } from "../types/index.js";

export const VIEM_CHAINS: Record<SupportedChain, Chain> = {
  ethereum: mainnet,
  arbitrum,
  polygon,
};

/** URL path segment per provider + chain. */
const PROVIDER_URL_TEMPLATES: Record<Exclude<RpcProvider, "custom">, Record<SupportedChain, (key: string) => string>> = {
  infura: {
    ethereum: (k) => `https://mainnet.infura.io/v3/${k}`,
    arbitrum: (k) => `https://arbitrum-mainnet.infura.io/v3/${k}`,
    polygon: (k) => `https://polygon-mainnet.infura.io/v3/${k}`,
  },
  alchemy: {
    ethereum: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
    arbitrum: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}`,
    polygon: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}`,
  },
};

const ENV_URL_VAR: Record<SupportedChain, string> = {
  ethereum: "ETHEREUM_RPC_URL",
  arbitrum: "ARBITRUM_RPC_URL",
  polygon: "POLYGON_RPC_URL",
};

export class RpcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcConfigError";
  }
}

/**
 * Reject RPC URLs that are obviously unsafe to talk to:
 *  - non-https (http plaintext leaks your wallet query pattern to anything on
 *    the network path)
 *  - loopback / private / link-local hosts (RFC1918, 127/8, ::1, *.local).
 *    Private-range URLs in a shared config are a strong indicator something
 *    got mis-pasted (e.g. a neighbour's dev box) and we'd rather fail loud
 *    than exfiltrate wallet addresses to an unexpected host.
 * Callers who intentionally want to hit a local forked node (anvil, hardhat,
 * etc.) can opt out with RECON_MCP_ALLOW_INSECURE_RPC=1.
 */
export function validateRpcUrl(chain: SupportedChain, url: string): void {
  if (process.env.RECON_MCP_ALLOW_INSECURE_RPC === "1") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RpcConfigError(
      `RPC URL for ${chain} is not a valid URL: ${url}. Fix it via \`recon-mcp-setup\` or the relevant env var.`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new RpcConfigError(
      `RPC URL for ${chain} must use https (got ${parsed.protocol}//). ` +
        `Plaintext RPCs leak wallet addresses to anyone on the network path. ` +
        `Set RECON_MCP_ALLOW_INSECURE_RPC=1 only if you're pointing at a local anvil/hardhat fork.`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    throw new RpcConfigError(
      `RPC URL for ${chain} points at a private/loopback host (${host}). ` +
        `This is almost always a mis-pasted config. ` +
        `Set RECON_MCP_ALLOW_INSECURE_RPC=1 if you intend to hit a local fork.`
    );
  }
}

function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // IPv4 literals.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map((x) => Number(x));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
  }
  return false;
}

/**
 * Resolve the RPC URL for a given chain based on env vars (highest priority)
 * then the user's ~/.recon-mcp/config.json.
 */
export function resolveRpcUrl(chain: SupportedChain, userConfig: UserConfig | null): string {
  const url = resolveRpcUrlRaw(chain, userConfig);
  validateRpcUrl(chain, url);
  return url;
}

function resolveRpcUrlRaw(chain: SupportedChain, userConfig: UserConfig | null): string {
  // Env overrides — per-chain full URL beats everything.
  const envChainUrl = process.env[ENV_URL_VAR[chain]];
  if (envChainUrl) return envChainUrl;

  // Env provider + key.
  const envProvider = process.env.RPC_PROVIDER?.toLowerCase() as RpcProvider | undefined;
  const envKey = process.env.RPC_API_KEY;
  if (envProvider && envProvider !== "custom" && envKey) {
    if (envProvider !== "infura" && envProvider !== "alchemy") {
      throw new RpcConfigError(`Unknown RPC_PROVIDER: ${envProvider}`);
    }
    return PROVIDER_URL_TEMPLATES[envProvider][chain](envKey);
  }

  // User config file.
  if (userConfig) {
    const { provider, apiKey, customUrls } = userConfig.rpc;
    if (provider === "custom") {
      const url = customUrls?.[chain];
      if (url) return url;
      throw new RpcConfigError(
        `No custom RPC URL configured for chain "${chain}". Re-run \`recon-mcp-setup\`.`
      );
    }
    if (provider === "infura" || provider === "alchemy") {
      if (!apiKey) {
        throw new RpcConfigError(
          `Missing API key for RPC provider "${provider}". Re-run \`recon-mcp-setup\`.`
        );
      }
      return PROVIDER_URL_TEMPLATES[provider][chain](apiKey);
    }
  }

  throw new RpcConfigError(
    `No RPC provider configured for chain "${chain}". ` +
      `Run \`recon-mcp-setup\` to configure Infura, Alchemy, or a custom endpoint.`
  );
}
