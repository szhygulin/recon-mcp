import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * 1inch Aggregation API v6.0 client. Used for intra-chain swap comparison against LiFi.
 *
 * 1inch is intra-chain only (no bridges), so cross-chain routes skip this entirely.
 * The public API requires a Bearer token from https://portal.1inch.dev — when no
 * key is configured, callers should skip the comparison silently rather than error.
 */

/** 1inch uses this sentinel for the chain's native asset. */
const ONEINCH_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface OneInchQuoteRequest {
  chain: SupportedChain;
  fromToken: `0x${string}` | "native";
  toToken: `0x${string}` | "native";
  /** Raw integer amount as string (e.g. "1000000" for 1 USDC). */
  fromAmount: string;
  apiKey: string;
}

export interface OneInchQuoteRaw {
  dstAmount: string;
  srcToken?: { address: string; symbol: string; decimals: number };
  dstToken?: { address: string; symbol: string; decimals: number };
  /** Estimated gas (units) for the swap, if `includeGas=true` was requested. */
  gas?: number;
  protocols?: unknown[];
}

export async function fetchOneInchQuote(req: OneInchQuoteRequest): Promise<OneInchQuoteRaw> {
  const chainId = CHAIN_IDS[req.chain];
  const src = req.fromToken === "native" ? ONEINCH_NATIVE : req.fromToken;
  const dst = req.toToken === "native" ? ONEINCH_NATIVE : req.toToken;

  const url = new URL(`https://api.1inch.dev/swap/v6.0/${chainId}/quote`);
  url.searchParams.set("src", src);
  url.searchParams.set("dst", dst);
  url.searchParams.set("amount", req.fromAmount);
  url.searchParams.set("includeTokensInfo", "true");
  url.searchParams.set("includeGas", "true");

  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`1inch quote ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as OneInchQuoteRaw;
}
