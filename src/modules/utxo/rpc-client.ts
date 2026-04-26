/**
 * Typed wrappers for the Bitcoin Core / Litecoin Core JSON-RPC methods
 * we use for forensic-tier reads. Issue #248.
 *
 * Bitcoin Core and Litecoin Core speak an identical JSON-RPC dialect
 * (Litecoin Core is a Bitcoin Core fork; the RPC method names, param
 * shapes, and response shapes match across both). This module is
 * chain-agnostic — callers pass a `JsonRpcClientConfig` that already
 * names the right endpoint + auth, and get typed responses back.
 *
 * Method coverage (RPC method → response shape source citation):
 *   - getbestblockhash            Bitcoin Core RPC reference
 *   - getblockhash(height)        Bitcoin Core RPC reference
 *   - getblock(hash, verbosity)   Bitcoin Core RPC reference (verbosity 1)
 *   - getchaintips                Bitcoin Core RPC reference (THE
 *                                 fork-detection primitive — Esplora
 *                                 indexers cannot expose this)
 *   - getmempoolinfo              Bitcoin Core RPC reference
 *   - getblockstats(hash, ...)    Bitcoin Core RPC reference (RPC-only;
 *                                 indexer block endpoint exposes block
 *                                 size/tx_count but NOT fee percentiles)
 *
 * Source: https://developer.bitcoin.org/reference/rpc/  (per-method pages).
 * Litecoin Core preserves these surfaces verbatim — no doc maintains a
 * canonical Litecoin RPC reference, but the method/response equivalence
 * is verifiable by running `litecoin-cli help <method>` against any
 * recent litecoind release.
 */
import {
  jsonRpcCall,
  type JsonRpcClientConfig,
} from "../../data/jsonrpc.js";

export interface ChainTip {
  /** Tip height. */
  height: number;
  /** Block hash. */
  hash: string;
  /** Number of blocks from the most recent common ancestor with the
   * active chain. 0 for the active tip. */
  branchlen: number;
  /** "active" | "valid-fork" | "valid-headers" | "headers-only" | "invalid".
   * "valid-fork" is the deep-reorg signal we care about: it's a tip the
   * node fully validated but didn't pick (because it had less work). */
  status:
    | "active"
    | "valid-fork"
    | "valid-headers"
    | "headers-only"
    | "invalid";
}

export interface MempoolInfo {
  /** Whether the daemon is loaded (false during startup). */
  loaded: boolean;
  /** Current tx count in mempool. */
  size: number;
  /** Sum of all virtual transaction sizes. */
  bytes: number;
  /** Total memory usage in bytes (includes pre-allocated overhead). */
  usage: number;
  /** Current minimum mempool fee for tx admission, in BTC/kvB. */
  mempoolminfee: number;
  /** Minimum relay feerate for tx, in BTC/kB. */
  minrelaytxfee: number;
  /** Maximum mempool size in bytes (configured). */
  maxmempool: number;
  /** Total fees of all txs in mempool, in BTC. */
  total_fee?: number;
}

/**
 * `getblockstats` response. We request a subset of fields via the
 * `stats` param to keep responses small. Field names match Bitcoin Core's
 * documented output; types are int unless otherwise noted.
 */
export interface BlockStats {
  /** Block hash. */
  blockhash: string;
  /** Block height. */
  height: number;
  /** Number of transactions (excludes coinbase counting). */
  txs: number;
  /** Total weight (Bitcoin Core 0.17+). */
  total_weight?: number;
  /** Sum of all tx fees in satoshis. */
  totalfee?: number;
  /** Average fee in satoshis. */
  avgfee?: number;
  /** Average feerate in sat/vB. */
  avgfeerate?: number;
  /** Min/max feerate in sat/vB. */
  minfeerate?: number;
  maxfeerate?: number;
  /** 10/25/50/75/90 percentile feerates in sat/vB. */
  feerate_percentiles?: [number, number, number, number, number];
  /** Total satoshis output (excluding coinbase). */
  totaloutput?: number;
  /** Number of inputs (across all txs). */
  ins?: number;
  /** Number of outputs (across all txs). */
  outs?: number;
  /** Block size in bytes. */
  total_size?: number;
}

export interface GetBlockVerbose {
  hash: string;
  /** Number of confirmations of this block on the canonical chain.
   * `-1` indicates the block is on a side chain (not in active chain). */
  confirmations: number;
  height: number;
  version: number;
  versionHex: string;
  merkleroot: string;
  /** Block timestamp (Unix seconds). */
  time: number;
  /** Median time past — chains-of-11 median, used for soft-fork timing. */
  mediantime: number;
  nonce: number;
  bits: string;
  /** Difficulty as a number (1e14+ for current Bitcoin mainnet). */
  difficulty: number;
  /** Hash of the previous block; absent for genesis. */
  previousblockhash?: string;
  /** Hash of the next block; absent for tip. */
  nextblockhash?: string;
  /** Total tx count in block. */
  nTx: number;
  /** Block size in bytes. */
  size: number;
  /** Block weight (BIP-141 weight units). */
  weight: number;
  /** With verbosity 1 this is an array of txids; with verbosity 2 it's
   * full tx objects. We use verbosity 1 by default. */
  tx?: string[];
}

export async function getBestBlockHash(
  config: JsonRpcClientConfig,
): Promise<string> {
  return jsonRpcCall<string>(config, "getbestblockhash");
}

export async function getBlockHash(
  config: JsonRpcClientConfig,
  height: number,
): Promise<string> {
  return jsonRpcCall<string>(config, "getblockhash", [height]);
}

export async function getBlockVerbose(
  config: JsonRpcClientConfig,
  blockhash: string,
  verbosity: 1 | 2 = 1,
): Promise<GetBlockVerbose> {
  return jsonRpcCall<GetBlockVerbose>(config, "getblock", [blockhash, verbosity]);
}

export async function getChainTips(
  config: JsonRpcClientConfig,
): Promise<ChainTip[]> {
  return jsonRpcCall<ChainTip[]>(config, "getchaintips");
}

export async function getMempoolInfo(
  config: JsonRpcClientConfig,
): Promise<MempoolInfo> {
  return jsonRpcCall<MempoolInfo>(config, "getmempoolinfo");
}

/**
 * `getblockstats(hash_or_height, stats?)`. The `stats` param trims the
 * response to only the requested fields — for `block_stats` tools we
 * request the fee-related fields; for `mempool_anomaly` baseline we'd
 * request size + tx count. Pass `null` to get all stats (large response).
 */
export async function getBlockStats(
  config: JsonRpcClientConfig,
  hashOrHeight: string | number,
  stats?: ReadonlyArray<keyof BlockStats>,
): Promise<BlockStats> {
  const params: unknown[] = [hashOrHeight];
  if (stats !== undefined) params.push(stats);
  return jsonRpcCall<BlockStats>(config, "getblockstats", params);
}

/**
 * `getrawmempool(verbose=false)` — txid array form. Used as a sanity
 * check for `getmempoolinfo.size` (they should match) and as input to
 * mempool-anomaly baseline trends. Verbose mode (per-tx info) is much
 * larger and not currently used.
 */
export async function getRawMempool(
  config: JsonRpcClientConfig,
): Promise<string[]> {
  return jsonRpcCall<string[]>(config, "getrawmempool", [false]);
}
