import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

/**
 * `get_nft_portfolio` — list NFTs the wallet owns across one or more
 * EVM chains, with per-collection floor and a rolled-up total floor
 * value. v1 read-only.
 *
 * Floor != liquidation: the floor is the lowest currently-listed ask.
 * Selling a held NFT typically means hitting an existing bid (a few
 * percent below floor) or accepting a sweep at a discount; the
 * rolled-up `totalFloorEth` is best read as "upper bound on
 * disposal proceeds before slippage", not "what I could sell for
 * right now". The handler's `notes[]` says so.
 */
export const getNftPortfolioInput = z.object({
  wallet: z
    .string()
    .regex(EVM_ADDRESS)
    .describe(
      "EVM wallet to enumerate. Reservoir is the source of truth; the " +
        "tool fans out one HTTP call per requested chain in parallel.",
    ),
  chains: z
    .array(chainEnum)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Subset of supported EVM chains to scan (ethereum / arbitrum / " +
        "polygon / base / optimism). Omit to scan all five. Per-chain " +
        "errors degrade rather than abort the whole call — the response's " +
        "`coverage` field flags which chains errored.",
    ),
  minFloorEth: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Drop NFTs whose collection floor is below this value (in the " +
        "chain's native asset). Useful for filtering out airdrop / spam / " +
        "scam collections that pollute the headline. Default: no filter.",
    ),
  collections: z
    .array(z.string().regex(EVM_ADDRESS))
    .max(50)
    .optional()
    .describe(
      "Whitelist a specific set of collection contract addresses. When " +
        "supplied, ALL other collections are dropped. Useful for spot-" +
        "checking a particular collection. Mutually composable with " +
        "`minFloorEth` (both filters apply).",
    ),
});

export type GetNftPortfolioArgs = z.infer<typeof getNftPortfolioInput>;

/**
 * `get_nft_collection` — wallet-less collection metadata (floor, top
 * bid, volume by window, holder count, royalty). For "what's this
 * collection's vitals?" lookups before deciding to add it.
 */
export const getNftCollectionInput = z.object({
  contractAddress: z
    .string()
    .regex(EVM_ADDRESS)
    .describe("EVM contract address of the NFT collection."),
  chain: chainEnum
    .default("ethereum")
    .describe(
      "EVM chain the collection is deployed on. Defaults to ethereum.",
    ),
});

export type GetNftCollectionArgs = z.infer<typeof getNftCollectionInput>;

/**
 * `get_nft_history` — recent NFT activity for the wallet (mints, buys,
 * sells, transfers, listings). Mirrors the EVM `get_transaction_history`
 * shape but limited to NFT-relevant events.
 */
export const getNftHistoryInput = z.object({
  wallet: z.string().regex(EVM_ADDRESS),
  chains: z
    .array(chainEnum)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Subset of supported EVM chains to scan. Omit for all five. " +
        "Multi-chain results are merged + sorted desc by timestamp.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe(
      "Max merged items to return (newest-first). Default 25, capped " +
        "at 100 to keep the cross-chain merge bounded.",
    ),
});

export type GetNftHistoryArgs = z.infer<typeof getNftHistoryInput>;

// ---- Result types ---------------------------------------------------

/**
 * One row per (collection, contractAddress) the wallet holds. Even
 * for ERC-1155 collections where the wallet holds multiple ids, the
 * row is per-collection — `tokenCount` aggregates across token IDs.
 * Flattening per-tokenId is out of scope for v1; the rollup is what
 * users actually need ("how much NFT exposure do I have?").
 */
export interface NftPortfolioRow {
  chain: string;
  contractAddress: string;
  collectionName?: string;
  collectionSlug?: string;
  collectionImage?: string;
  /** How many tokens the wallet holds in this collection (sum across token IDs). */
  tokenCount: number;
  /** Floor ask in the chain's native asset. Absent when the collection has no listings. */
  floorEth?: number;
  /** Floor ask in USD via Reservoir's own pricing. Absent when no listings. */
  floorUsd?: number;
  /**
   * Estimated total value: `floorEth * tokenCount`. Same caveat as
   * floor — a top-of-book approximation, not "what I'd net selling all".
   */
  totalFloorEth?: number;
  totalFloorUsd?: number;
  /** Currency symbol for the floor — typically "ETH" / "MATIC" / "ETH" (Base) etc. */
  floorCurrency?: string;
}

export interface NftPortfolioResult {
  wallet: string;
  chains: string[];
  /** Total floor value across every row, in USD (when priced). */
  totalFloorUsd: number;
  /** Number of NFT collections the wallet holds at least one token in. */
  collectionCount: number;
  /** Sum of `tokenCount` across rows (total NFTs held). */
  totalTokenCount: number;
  rows: NftPortfolioRow[];
  /** Per-chain coverage — `errored` flags which chains failed. */
  coverage: Array<{ chain: string; errored: boolean; reason?: string }>;
  notes: string[];
}

export interface NftCollectionInfo {
  chain: string;
  contractAddress: string;
  name?: string;
  slug?: string;
  symbol?: string;
  description?: string;
  image?: string;
  tokenCount?: number;
  ownerCount?: number;
  /** Lowest currently-listed ask, in native + USD. */
  floorEth?: number;
  floorUsd?: number;
  floorCurrency?: string;
  /** Highest currently-active offer (collection bid), in native + USD. */
  topBidEth?: number;
  topBidUsd?: number;
  /** Volume by window in native units. */
  volume24hEth?: number;
  volume7dEth?: number;
  volume30dEth?: number;
  volumeAllTimeEth?: number;
  /** Royalty in basis points (250 = 2.5%) — what the creator earns per secondary sale. */
  royaltyBps?: number;
  /** Royalty recipient address. */
  royaltyRecipient?: string;
  notes: string[];
}

export type NftHistoryItemType =
  | "mint"
  | "sale"
  | "transfer"
  | "ask"
  | "bid"
  | "ask_cancel"
  | "bid_cancel"
  | "other";

export interface NftHistoryItem {
  chain: string;
  type: NftHistoryItemType;
  /** Unix seconds. */
  timestamp: number;
  timestampIso: string;
  contractAddress?: string;
  collectionName?: string;
  tokenId?: string;
  tokenName?: string;
  fromAddress?: string;
  toAddress?: string;
  /** Sale / ask / bid price in native asset. Absent on transfers / mints without a recorded price. */
  priceEth?: number;
  priceUsd?: number;
  priceCurrency?: string;
  txHash?: string;
}

export interface NftHistoryResult {
  wallet: string;
  chains: string[];
  items: NftHistoryItem[];
  truncated: boolean;
  coverage: Array<{ chain: string; errored: boolean; reason?: string }>;
  notes: string[];
}
