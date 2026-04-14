import { mainnet, arbitrum, polygon, base } from "viem/chains";
import type { Chain } from "viem";
import type { RpcProvider, SupportedChain, UserConfig } from "../types/index.js";

export const VIEM_CHAINS: Record<SupportedChain, Chain> = {
  ethereum: mainnet,
  arbitrum,
  polygon,
  base,
};

/** URL path segment per provider + chain. */
const PROVIDER_URL_TEMPLATES: Record<Exclude<RpcProvider, "custom">, Record<SupportedChain, (key: string) => string>> = {
  infura: {
    ethereum: (k) => `https://mainnet.infura.io/v3/${k}`,
    arbitrum: (k) => `https://arbitrum-mainnet.infura.io/v3/${k}`,
    polygon: (k) => `https://polygon-mainnet.infura.io/v3/${k}`,
    base: (k) => `https://base-mainnet.infura.io/v3/${k}`,
  },
  alchemy: {
    ethereum: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
    arbitrum: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}`,
    polygon: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}`,
    base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
  },
};

const ENV_URL_VAR: Record<SupportedChain, string> = {
  ethereum: "ETHEREUM_RPC_URL",
  arbitrum: "ARBITRUM_RPC_URL",
  polygon: "POLYGON_RPC_URL",
  base: "BASE_RPC_URL",
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
 * etc.) can opt out with RECON_ALLOW_INSECURE_RPC=1.
 */
export function validateRpcUrl(chain: SupportedChain, url: string): void {
  if (process.env.RECON_ALLOW_INSECURE_RPC === "1") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RpcConfigError(
      `RPC URL for ${chain} is not a valid URL: ${url}. Fix it via \`recon-crypto-mcp-setup\` or the relevant env var.`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new RpcConfigError(
      `RPC URL for ${chain} must use https (got ${parsed.protocol}//). ` +
        `Plaintext RPCs leak wallet addresses to anyone on the network path. ` +
        `Set RECON_ALLOW_INSECURE_RPC=1 only if you're pointing at a local anvil/hardhat fork.`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    throw new RpcConfigError(
      `RPC URL for ${chain} points at a private/loopback host (${host}). ` +
        `This is almost always a mis-pasted config. ` +
        `Set RECON_ALLOW_INSECURE_RPC=1 if you intend to hit a local fork.`
    );
  }
}

export function isPrivateOrLoopbackHost(host: string): boolean {
  // Strip IPv6 bracket form. The URL parser can return hostnames like "[::1]"
  // or "[fe80::1]"; normalise to the bare address for matching.
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.toLowerCase();

  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return true;

  // IPv4 literal.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && isPrivateOrLoopbackIPv4(Number(v4[1]), Number(v4[2]))) {
    return true;
  }

  // IPv4-mapped IPv6, e.g. ::ffff:10.0.0.1 or ::ffff:c0a8:0001.
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mapped && isPrivateOrLoopbackIPv4(Number(mapped[1]), Number(mapped[2]))) {
    return true;
  }

  // IPv6 literals. We match on prefix rather than fully parsing the address
  // because the forms we care about all have a fixed high-order signature:
  //   ::1             loopback
  //   fc00::/7        ULA (matches fc.. and fd.. as first hex pair)
  //   fe80::/10       link-local (fe8., fe9., fea., feb.)
  //   ::              unspecified
  if (h === "::1" || h === "::") return true;
  // Hex-pair prefix — first group before ':' or string end.
  const firstGroup = h.split(":")[0];
  if (/^fc[0-9a-f]{0,2}$/.test(firstGroup) || /^fd[0-9a-f]{0,2}$/.test(firstGroup)) {
    return true;
  }
  if (/^fe[89ab][0-9a-f]?$/.test(firstGroup)) {
    return true;
  }

  return false;
}

function isPrivateOrLoopbackIPv4(a: number, b: number): boolean {
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true;
  return false;
}

/**
 * Resolve the RPC URL for a given chain based on env vars (highest priority)
 * then the user's ~/.recon-crypto-mcp/config.json.
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
        `No custom RPC URL configured for chain "${chain}". Re-run \`recon-crypto-mcp-setup\`.`
      );
    }
    if (provider === "infura" || provider === "alchemy") {
      if (!apiKey) {
        throw new RpcConfigError(
          `Missing API key for RPC provider "${provider}". Re-run \`recon-crypto-mcp-setup\`.`
        );
      }
      return PROVIDER_URL_TEMPLATES[provider][chain](apiKey);
    }
  }

  throw new RpcConfigError(
    `No RPC provider configured for chain "${chain}". ` +
      `Run \`recon-crypto-mcp-setup\` to configure Infura, Alchemy, or a custom endpoint.`
  );
}
