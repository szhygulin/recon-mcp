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
 * Resolve the RPC URL for a given chain based on env vars (highest priority)
 * then the user's ~/.recon-mcp/config.json.
 */
export function resolveRpcUrl(chain: SupportedChain, userConfig: UserConfig | null): string {
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
