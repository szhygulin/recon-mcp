import { CHAIN_IDS } from "../../types/index.js";
import type { SupportedChain } from "../../types/index.js";
import { resolveEtherscanApiKey, readUserConfig } from "../../config/user-config.js";
import { fetchWithTimeout } from "../http.js";

/**
 * Etherscan V2 unified client.
 *
 * V1 per-chain endpoints (api.etherscan.io, api.arbiscan.io, ...) were
 * deprecated and now return `{status:"0",message:"NOTOK",result:"...V1 deprecated..."}`
 * for every call. V2 consolidates all chains behind a single host with a
 * `chainid` query param and requires an API key (no anonymous tier).
 *
 * One key now covers ETH/Arbitrum/Polygon/Base — set ETHERSCAN_API_KEY in the
 * server env or run `vaultpilot-mcp-setup` to stash it in the user config.
 */

const V2_BASE = "https://api.etherscan.io/v2/api";

/** Match `etherscan.ts`'s existing guardrail. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface EtherscanEnvelope<T> {
  status: string;
  message: string;
  result: T | string;
}

export class EtherscanApiKeyMissingError extends Error {
  constructor() {
    super(
      "ETHERSCAN_API_KEY is not set. Etherscan V2 requires an API key — " +
        "get a free one at https://etherscan.io/apis and set ETHERSCAN_API_KEY " +
        "in the MCP server env, or run `vaultpilot-mcp-setup` to store it in " +
        "~/.vaultpilot/config.json."
    );
    this.name = "EtherscanApiKeyMissingError";
  }
}

/** Structured signal for "Etherscan accepted the call but has no data". */
export class EtherscanNoDataError extends Error {
  constructor(action: string) {
    super(`Etherscan ${action}: no records`);
    this.name = "EtherscanNoDataError";
  }
}

/**
 * Issue a V2 request and return the parsed `result` array. Throws on:
 *  - missing API key (EtherscanApiKeyMissingError)
 *  - HTTP error
 *  - oversized response (>2MB)
 *  - NOTOK with non-"no records" message (surfaces the `result` field so the
 *    caller/agent can see the real reason, e.g. rate limit or deprecation)
 *
 * Returns [] for the benign "no transactions found" shape.
 */
export async function etherscanV2Fetch<T>(
  chain: SupportedChain,
  params: Record<string, string>
): Promise<T[]> {
  const apiKey = resolveEtherscanApiKey(readUserConfig());
  if (!apiKey) throw new EtherscanApiKeyMissingError();

  const qs = new URLSearchParams({
    chainid: String(CHAIN_IDS[chain]),
    ...params,
    apikey: apiKey,
  });

  const res = await fetchWithTimeout(`${V2_BASE}?${qs.toString()}`);
  if (!res.ok) {
    // Don't include the URL — it carries apikey. Surface status only.
    throw new Error(`Etherscan V2 ${chain} ${params.action} returned ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Etherscan V2 ${chain} ${params.action} response exceeds ${MAX_RESPONSE_BYTES} bytes (got ${text.length})`
    );
  }
  const body = JSON.parse(text) as EtherscanEnvelope<T[]>;
  if (body.status !== "1") {
    const resultStr = typeof body.result === "string" ? body.result : "";
    const combined = `${body.message || ""} ${resultStr}`.toLowerCase();
    if (combined.includes("no transactions") || combined.includes("no records")) {
      return [];
    }
    // Surface the `result` field: it carries the user-useful reason
    // ("Missing/Invalid API Key", "Max calls per sec rate limit reached", etc.).
    const detail = resultStr || body.message || "unknown";
    throw new Error(`Etherscan V2 ${chain} ${params.action}: ${detail}`);
  }
  return Array.isArray(body.result) ? body.result : [];
}

/**
 * Lower-level variant for endpoints that return a single object, not an
 * array (e.g. some contract-level queries). Same error semantics.
 */
export async function etherscanV2FetchRaw<T>(
  chain: SupportedChain,
  params: Record<string, string>
): Promise<T> {
  const apiKey = resolveEtherscanApiKey(readUserConfig());
  if (!apiKey) throw new EtherscanApiKeyMissingError();

  const qs = new URLSearchParams({
    chainid: String(CHAIN_IDS[chain]),
    ...params,
    apikey: apiKey,
  });

  const res = await fetchWithTimeout(`${V2_BASE}?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`Etherscan V2 ${chain} ${params.action} returned ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Etherscan V2 ${chain} ${params.action} response exceeds ${MAX_RESPONSE_BYTES} bytes (got ${text.length})`
    );
  }
  const body = JSON.parse(text) as EtherscanEnvelope<T>;
  if (body.status !== "1") {
    const resultStr = typeof body.result === "string" ? body.result : "";
    const detail = resultStr || body.message || "unknown";
    throw new Error(`Etherscan V2 ${chain} ${params.action}: ${detail}`);
  }
  return body.result as T;
}
