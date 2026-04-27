import { mainnet, arbitrum, polygon, base, optimism } from "viem/chains";
import type { Chain } from "viem";
import type { RpcProvider, SupportedChain, UserConfig } from "../types/index.js";
import { getRuntimeSolanaRpc } from "../data/runtime-rpc-overrides.js";

export const VIEM_CHAINS: Record<SupportedChain, Chain> = {
  ethereum: mainnet,
  arbitrum,
  polygon,
  base,
  optimism,
};

/** URL path segment per provider + chain. */
const PROVIDER_URL_TEMPLATES: Record<Exclude<RpcProvider, "custom">, Record<SupportedChain, (key: string) => string>> = {
  infura: {
    ethereum: (k) => `https://mainnet.infura.io/v3/${k}`,
    arbitrum: (k) => `https://arbitrum-mainnet.infura.io/v3/${k}`,
    polygon: (k) => `https://polygon-mainnet.infura.io/v3/${k}`,
    base: (k) => `https://base-mainnet.infura.io/v3/${k}`,
    optimism: (k) => `https://optimism-mainnet.infura.io/v3/${k}`,
  },
  alchemy: {
    ethereum: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
    arbitrum: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}`,
    polygon: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}`,
    base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
    optimism: (k) => `https://opt-mainnet.g.alchemy.com/v2/${k}`,
  },
};

const ENV_URL_VAR: Record<SupportedChain, string> = {
  ethereum: "ETHEREUM_RPC_URL",
  arbitrum: "ARBITRUM_RPC_URL",
  polygon: "POLYGON_RPC_URL",
  base: "BASE_RPC_URL",
  optimism: "OPTIMISM_RPC_URL",
};

/**
 * PublicNode free-tier fallbacks, used when the user has neither configured
 * a provider nor set per-chain env vars. Lets the zero-config install work
 * end-to-end for portfolio reads without the user signing up for any
 * provider. Shared public endpoints are rate-limited — a user who plans to
 * use the server heavily will want their own Infura / Alchemy key — but for
 * first-contact + light use these are enough.
 *
 * PublicNode is maintained by Pokt Network (https://www.publicnode.com/),
 * publicly documented, and exposes HTTPS (so our `validateRpcUrl` still
 * accepts them). Optimism doesn't appear in the plan doc but is covered by
 * the same template; include it so the zero-config path is uniform across
 * all SUPPORTED_CHAINS.
 */
const PUBLIC_NODE_FALLBACK: Record<SupportedChain, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
};

/**
 * Public Solana mainnet endpoint. Aggressively rate-limited (429s under
 * mild fan-out) but ships as the zero-config fallback so `get_portfolio_summary`
 * with a `solanaAddress` works on first install. Upgrading to a Helius /
 * QuickNode / Triton endpoint is one env var away (SOLANA_RPC_URL) when the
 * user hits throttling.
 */
const SOLANA_PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

/** Whether `resolveRpcUrlRaw` has already warned about using the public fallback this process. */
const warnedPublicFallback: Partial<Record<SupportedChain, boolean>> = {};
let warnedSolanaPublicFallback = false;

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
 * etc.) can opt out with VAULTPILOT_ALLOW_INSECURE_RPC=1 (legacy alias
 * RECON_ALLOW_INSECURE_RPC is still honored for one release).
 */
export function validateRpcUrl(chainLabel: string, url: string): void {
  if (
    process.env.VAULTPILOT_ALLOW_INSECURE_RPC === "1" ||
    process.env.RECON_ALLOW_INSECURE_RPC === "1"
  ) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Do NOT echo the URL back — configured RPC URLs often contain a provider
    // API key in the path (e.g. .../v3/<key>). A malformed URL may still carry
    // one, and error messages end up in logs / stderr where keys leak.
    throw new RpcConfigError(
      `RPC URL for ${chainLabel} is not a valid URL. Fix it via \`vaultpilot-mcp-setup\` or the relevant env var.`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new RpcConfigError(
      `RPC URL for ${chainLabel} must use https (got ${parsed.protocol}//). ` +
        `Plaintext RPCs leak wallet addresses to anyone on the network path. ` +
        `Set VAULTPILOT_ALLOW_INSECURE_RPC=1 only if you're pointing at a local anvil/hardhat fork.`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    throw new RpcConfigError(
      `RPC URL for ${chainLabel} points at a private/loopback host (${host}). ` +
        `This is almost always a mis-pasted config. ` +
        `Set VAULTPILOT_ALLOW_INSECURE_RPC=1 if you intend to hit a local fork.`
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
 * then the user's ~/.vaultpilot-mcp/config.json.
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
      // Fall through to the public fallback rather than throwing — makes
      // zero-config installs work and doesn't punish a user who configured
      // one chain's custom URL but not another.
    } else if (provider === "infura" || provider === "alchemy") {
      if (apiKey) return PROVIDER_URL_TEMPLATES[provider][chain](apiKey);
      // Missing apiKey — also fall through to public fallback.
    }
  }

  // Zero-config / incomplete-config fallback: shared public endpoint.
  // Emits a one-time per-chain warning to stderr so the user knows their
  // reads are going through a rate-limited public RPC (explains any
  // intermittent 429s) but doesn't fail the operation outright.
  if (!warnedPublicFallback[chain]) {
    warnedPublicFallback[chain] = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[vaultpilot] No RPC provider configured for ${chain} — using shared public ` +
        `endpoint (${PUBLIC_NODE_FALLBACK[chain]}). Rate-limited; set ${ENV_URL_VAR[chain]} ` +
        `or run \`vaultpilot-mcp-setup\` to upgrade.`,
    );
  }
  return PUBLIC_NODE_FALLBACK[chain];
}

/**
 * Resolve the Solana mainnet RPC URL. Priority:
 *   1. SOLANA_RPC_URL env var (pastes cleanly from any provider's dashboard).
 *   2. `solanaRpcUrl` in user config (set by `vaultpilot-mcp-setup`).
 *   3. Public mainnet fallback (`api.mainnet-beta.solana.com`) with a
 *      one-time stderr warning. Previously this layer threw; that hard-
 *      gated the zero-config install for portfolio reads. Falling back
 *      lets a first-time user see their Solana balance without signing up
 *      for Helius first, at the cost of likely 429s under load — the
 *      warning tells them exactly which env var to set when that bites.
 *
 * The returned URL passes through `validateRpcUrl` (https-only, no loopback)
 * before being handed to `Connection` — same safety bar as EVM RPCs.
 */
export function resolveSolanaRpcUrl(userConfig: UserConfig | null): string {
  // Issue #371 follow-up: a runtime override (set via `set_helius_api_key`
  // in demo mode) takes precedence over env/config/public-fallback. The
  // override is constructed by the override module from a validated
  // bare API key, so we skip validateRpcUrl here — the URL has already
  // passed shape validation and is hardcoded to the canonical Helius
  // mainnet endpoint.
  const override = getRuntimeSolanaRpc();
  if (override) return override;
  const envUrl = process.env.SOLANA_RPC_URL;
  if (envUrl) {
    validateRpcUrl("solana", envUrl);
    return envUrl;
  }
  const configUrl = userConfig?.solanaRpcUrl;
  if (configUrl) {
    validateRpcUrl("solana", configUrl);
    return configUrl;
  }
  if (!warnedSolanaPublicFallback) {
    warnedSolanaPublicFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[vaultpilot] No Solana RPC configured — using public mainnet ` +
        `(${SOLANA_PUBLIC_MAINNET}). Rate-limited; set SOLANA_RPC_URL to a ` +
        `Helius / QuickNode / Triton URL for real use.`,
    );
  }
  return SOLANA_PUBLIC_MAINNET;
}
