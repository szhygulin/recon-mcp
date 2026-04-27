/**
 * Reservoir API client. Read-only. Used by the three NFT tools
 * (`get_nft_portfolio`, `get_nft_collection`, `get_nft_history`) to
 * pull holdings, collection metadata, and per-wallet activity across
 * EVM chains.
 *
 * Reservoir hosts one base URL per chain (the chain id is part of the
 * subdomain). The free tier serves anonymous requests but rate-limits
 * at a ceiling that doesn't survive multi-chain portfolio fan-out;
 * configuring `RESERVOIR_API_KEY` avoids 429s. The `RateLimitedError`
 * carries a structured `setupHint` so the agent can tell the user
 * exactly what to do when limits hit.
 *
 * No retry-on-429 here — Reservoir's `Retry-After` header would tell
 * us how long to back off, but multi-chain fan-out means a 429 on one
 * chain shouldn't stall the others. The handlers gather results via
 * `Promise.allSettled` so per-chain failures degrade rather than abort.
 */

import { fetchWithTimeout } from "../../data/http.js";
import {
  resolveReservoirApiKey,
  readUserConfig,
} from "../../config/user-config.js";
import type { SupportedChain } from "../../types/index.js";

/** Match the existing per-API guardrail. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Reservoir's per-chain hostnames. The chain selector is encoded in
 * the subdomain rather than a query param, mirroring Reservoir's own
 * API docs. Optimism is `optimism`, not `op`. Avalanche is intentionally
 * NOT in the supported set yet — vaultpilot's chain enum doesn't carry
 * it, and adding it is out of scope until the rest of the EVM stack
 * does.
 */
const RESERVOIR_HOSTS: Record<SupportedChain, string> = {
  ethereum: "api.reservoir.tools",
  arbitrum: "api-arbitrum.reservoir.tools",
  polygon: "api-polygon.reservoir.tools",
  base: "api-base.reservoir.tools",
  optimism: "api-optimism.reservoir.tools",
};

/**
 * Public — agent-facing setup hint for any rate-limit / auth surface.
 * Kept short; the agent surfaces it verbatim to the user.
 */
export const RESERVOIR_SETUP_HINT =
  "Reservoir rate-limited the request. Free anonymous tier is generous " +
  "but multi-chain fan-out can hit the ceiling. Set RESERVOIR_API_KEY in " +
  "the MCP server env (free key at https://reservoir.tools/) and retry.";

export class ReservoirRateLimitedError extends Error {
  readonly setupHint: string;
  constructor(public readonly chain: SupportedChain, public readonly path: string) {
    super(`Reservoir ${chain} ${path} returned 429 (rate limited)`);
    this.name = "ReservoirRateLimitedError";
    this.setupHint = RESERVOIR_SETUP_HINT;
  }
}

export class ReservoirHttpError extends Error {
  constructor(
    public readonly chain: SupportedChain,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(
      `Reservoir ${chain} ${path} returned ${status}: ${body.slice(0, 200)}`,
    );
    this.name = "ReservoirHttpError";
  }
}

/**
 * GET against the chain's Reservoir host. Throws structured errors on
 * HTTP non-2xx; passes through JSON-parse errors unchanged. The query
 * params are appended verbatim — caller is responsible for properly
 * encoding any addresses / contract IDs.
 *
 * Reservoir endpoints accept addresses with or without a `0x` prefix
 * and are case-insensitive. We pass them through as-given; no
 * normalization here.
 */
export async function reservoirFetch<T>(args: {
  chain: SupportedChain;
  path: string;
  query?: Record<string, string | number | undefined>;
}): Promise<T> {
  const apiKey = resolveReservoirApiKey(readUserConfig());
  const headers: Record<string, string> = {
    accept: "*/*",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  const params = new URLSearchParams();
  if (args.query) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  const url = `https://${RESERVOIR_HOSTS[args.chain]}${args.path}${qs ? "?" + qs : ""}`;

  const res = await fetchWithTimeout(url, { headers });
  if (res.status === 429) {
    throw new ReservoirRateLimitedError(args.chain, args.path);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ReservoirHttpError(args.chain, args.path, res.status, body);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Reservoir ${args.chain} ${args.path} response exceeds ${MAX_RESPONSE_BYTES} bytes (got ${text.length}). ` +
        `Reduce the requested page size.`,
    );
  }
  return JSON.parse(text) as T;
}

// ---- Response shapes used by the handlers ------------------------------
//
// Stripped to the fields we actually surface. Reservoir's own response
// envelopes carry many more fields; using a narrow projection means a
// future Reservoir field rename only matters if we touch THIS file.

export interface ReservoirUserToken {
  token: {
    contract: string;
    tokenId: string;
    name?: string;
    image?: string;
    media?: string;
    collection: {
      id: string;
      name?: string;
      slug?: string;
      imageUrl?: string;
      floorAskPrice?: { amount?: { decimal?: number; usd?: number }; currency?: { symbol?: string } };
    };
  };
  ownership: {
    tokenCount: string;
    onSaleCount?: string;
    floorAsk?: {
      price?: { amount?: { decimal?: number; usd?: number } };
    };
    acquiredAt?: string;
  };
}

export interface ReservoirUserTokensResponse {
  tokens: ReservoirUserToken[];
  continuation?: string;
}

export interface ReservoirCollection {
  id: string;
  name?: string;
  slug?: string;
  symbol?: string;
  description?: string;
  image?: string;
  banner?: string;
  primaryContract?: string;
  tokenCount?: string;
  onSaleCount?: string;
  ownerCount?: number;
  floorAsk?: {
    price?: {
      amount?: { decimal?: number; usd?: number };
      currency?: { symbol?: string };
    };
  };
  topBid?: {
    price?: {
      amount?: { decimal?: number; usd?: number };
      currency?: { symbol?: string };
    };
  };
  volume?: {
    "1day"?: number;
    "7day"?: number;
    "30day"?: number;
    allTime?: number;
  };
  royalties?: {
    bps?: number;
    recipient?: string;
  };
  creator?: string;
  rank?: { "1day"?: number; "7day"?: number; "30day"?: number; allTime?: number };
}

export interface ReservoirCollectionsResponse {
  collections: ReservoirCollection[];
}

export interface ReservoirActivityItem {
  type: string; // "mint" | "sale" | "transfer" | "ask" | "bid" | "ask_cancel" | ...
  fromAddress?: string;
  toAddress?: string;
  price?: {
    amount?: { decimal?: number; usd?: number };
    currency?: { symbol?: string };
  };
  amount?: number;
  timestamp: number;
  contract?: string;
  token?: {
    tokenId?: string;
    tokenName?: string;
    tokenImage?: string;
  };
  collection?: {
    collectionId?: string;
    collectionName?: string;
    collectionImage?: string;
  };
  txHash?: string;
}

export interface ReservoirUsersActivityResponse {
  activities: ReservoirActivityItem[];
  continuation?: string;
}
