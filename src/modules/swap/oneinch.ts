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

export interface OneInchSwapRequest extends OneInchQuoteRequest {
  fromAddress: `0x${string}`;
  /** Slippage in basis points (1..500). Converted to 1inch's percentage on-wire. */
  slippageBps: number;
}

export interface OneInchSwapRaw {
  dstAmount: string;
  srcToken: { address: string; symbol: string; decimals: number; name?: string };
  dstToken: { address: string; symbol: string; decimals: number; name?: string };
  tx: {
    from: string;
    to: string;
    data: string;
    /** Wei value as decimal string. "0" for ERC-20 inputs. */
    value: string;
    gas?: number | string;
    gasPrice?: string;
  };
}

/**
 * 1inch v6 `/swap` endpoint — returns signable calldata against the
 * Aggregation Router V6 (`tx.to` is also the spender for ERC-20 inputs).
 * Used as a same-chain fallback inside `prepareSwap` when LiFi's 1inch
 * integration can't satisfy a route filter (issue #615 — stETH→ETH).
 *
 * `disableEstimate=true` skips 1inch's own eth_estimateGas pre-check;
 * without it, the call fails for first-time approve+swap chains because
 * the user hasn't yet granted allowance to the router.
 */
export async function fetchOneInchSwap(req: OneInchSwapRequest): Promise<OneInchSwapRaw> {
  const chainId = CHAIN_IDS[req.chain];
  const src = req.fromToken === "native" ? ONEINCH_NATIVE : req.fromToken;
  const dst = req.toToken === "native" ? ONEINCH_NATIVE : req.toToken;

  const url = new URL(`https://api.1inch.dev/swap/v6.0/${chainId}/swap`);
  url.searchParams.set("src", src);
  url.searchParams.set("dst", dst);
  url.searchParams.set("amount", req.fromAmount);
  url.searchParams.set("from", req.fromAddress);
  // 1inch slippage is a percentage (0..50). 50 bps → 0.5.
  url.searchParams.set("slippage", (req.slippageBps / 100).toString());
  url.searchParams.set("includeTokensInfo", "true");
  url.searchParams.set("includeGas", "true");
  url.searchParams.set("disableEstimate", "true");

  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`1inch swap ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as OneInchSwapRaw;
}
