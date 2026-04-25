import { fetchWithTimeout } from "../../data/http.js";
import { BITCOIN_DEFAULT_INDEXER_URL } from "../../config/btc.js";
import { readUserConfig } from "../../config/user-config.js";

/**
 * Bitcoin indexer abstraction. Single interface, mempool.space (default)
 * + any Esplora-compatible endpoint as the impl. Self-hosted Esplora /
 * Electrs all expose the same REST surface — mempool.space's API is a
 * fork of Blockstream Esplora's, with a few additions (fee
 * recommendations, mempool stats) that we use.
 *
 * URL resolution priority (highest first):
 *   1. `BITCOIN_INDEXER_URL` env var
 *   2. `userConfig.bitcoinIndexerUrl`
 *   3. `BITCOIN_DEFAULT_INDEXER_URL` (mempool.space)
 *
 * Phase 1 scope: read-only. PR3 adds `getUtxos` + `getRawTx` for
 * coin-selection and PSBT input population, plus `broadcastTx` for the
 * send path.
 */

/**
 * Esplora address-stats payload. Both confirmed and mempool stats are
 * present; we sum them to surface a "total balance" alongside the
 * confirmed-only number. mempool.space prefers `chain_stats` /
 * `mempool_stats` field naming (forked from Blockstream).
 */
interface EsploraAddressStats {
  /** Address — echoed back. */
  address: string;
  /** Confirmed: funds that have at least 1 confirmation. */
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  /** Unconfirmed: funds in mempool, not yet mined. */
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

/**
 * Bitcoin balance for a single address. Confirmed + unconfirmed reported
 * separately so the caller can decide UX (typically: show confirmed as
 * the headline, surface unconfirmed only when non-zero).
 */
export interface BitcoinAddressBalance {
  address: string;
  /** Confirmed funded - confirmed spent, in sats. Always ≥ 0. */
  confirmedSats: bigint;
  /** Mempool funded - mempool spent, in sats. Can be negative when funds are in-flight as spent. */
  mempoolSats: bigint;
  /** Confirmed + mempool. Convenience field. */
  totalSats: bigint;
  /** Total tx count this address has been involved in (confirmed + mempool). */
  txCount: number;
}

/**
 * Fee-rate estimates in sat/vB. Returned by mempool.space's
 * `/v1/fees/recommended` endpoint — these match the labels the mempool.space
 * UI shows ("High Priority" / "Medium Priority" / etc.) so users see
 * familiar terminology.
 */
export interface BitcoinFeeEstimates {
  /** ~next-block target. */
  fastestFee: number;
  /** ~3 blocks (~30 min). */
  halfHourFee: number;
  /** ~6 blocks (~1 hour). */
  hourFee: number;
  /** Lowest fee miners are still including. */
  economyFee: number;
  /** Floor below which a tx is unlikely to ever confirm. */
  minimumFee: number;
}

/**
 * Tx history entry. Subset of the Esplora `/address/<addr>/txs` payload
 * we surface — enough for portfolio history rendering without forcing
 * callers to learn the full SAT/RBF/witness shape.
 */
export interface BitcoinTxHistoryEntry {
  txid: string;
  /** Sum of vouts that pay this address (the funding side). Sats. */
  receivedSats: bigint;
  /** Sum of vins that come from this address (the spending side). Sats. */
  sentSats: bigint;
  /** Tx fee from the Esplora payload (sats). Useful UX context. */
  feeSats: bigint;
  /** Block height — undefined when still in mempool. */
  blockHeight?: number;
  /** Unix timestamp of the block — undefined for mempool. */
  blockTime?: number;
  /** True when sequence < 0xFFFFFFFE on at least one input (BIP-125). */
  rbfEligible: boolean;
}

/**
 * Esplora vin/vout shapes we destructure. Trimmed to fields we read.
 */
interface EsploraVin {
  txid: string;
  vout: number;
  prevout?: { scriptpubkey_address?: string; value?: number };
  sequence?: number;
}

interface EsploraVout {
  scriptpubkey_address?: string;
  value?: number;
}

interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
}

/**
 * UTXO entry. Esplora returns these from `/address/<addr>/utxo`.
 * `scriptPubKey` is NOT in the Esplora payload directly — we derive it
 * from the address at PSBT-build time (cheaper than a per-UTXO lookup
 * since all UTXOs for one address share the same scriptPubKey).
 */
export interface BitcoinUtxo {
  txid: string;
  vout: number;
  /** UTXO value in sats. */
  value: number;
  /** Block height of the funding tx. Undefined for mempool UTXOs. */
  blockHeight?: number;
  /** True when the UTXO is in mempool (not yet confirmed). */
  unconfirmed: boolean;
}

export interface BitcoinIndexer {
  getBalance(address: string): Promise<BitcoinAddressBalance>;
  getFeeEstimates(): Promise<BitcoinFeeEstimates>;
  /**
   * Fetch the tx history for an address. `limit` clamps how many entries
   * to walk (we paginate via the Esplora `/txs/chain/<last_seen>` cursor
   * pattern; mempool.space honors the same convention). Returns only
   * confirmed + mempool txs, oldest-first within each segment.
   */
  getAddressTxs(
    address: string,
    opts?: { limit?: number },
  ): Promise<BitcoinTxHistoryEntry[]>;
  /**
   * Fetch the UTXO set for an address. Returned newest-first (block
   * height descending). Used as the input set for coin-selection on
   * `prepare_btc_send`.
   */
  getUtxos(address: string): Promise<BitcoinUtxo[]>;
  /**
   * Broadcast a fully-signed tx hex via the indexer's `/tx` endpoint.
   * Returns the on-chain txid on success. Throws with the indexer's
   * error body on failures (most commonly: "min relay fee not met"
   * when feeRate is below the mempool floor, or "txn-already-known"
   * when re-broadcasting a tx that's already in the mempool).
   */
  broadcastTx(rawTxHex: string): Promise<string>;
  /**
   * Fetch confirmation status for a txid. Used by
   * `get_transaction_status` BTC branch — returns the confirmation
   * count at current tip when the tx is mined; returns `confirmed: false`
   * for in-mempool txs; null when the tx isn't found at all (dropped
   * or never broadcast).
   */
  getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null>;
}

/**
 * Resolve the indexer base URL via env > config > default.
 */
function resolveIndexerUrl(): string {
  const fromEnv = process.env.BITCOIN_INDEXER_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const cfg = readUserConfig();
  if (cfg && cfg.bitcoinIndexerUrl && cfg.bitcoinIndexerUrl.trim().length > 0) {
    return cfg.bitcoinIndexerUrl.trim();
  }
  return BITCOIN_DEFAULT_INDEXER_URL;
}

/**
 * Convert an Esplora tx + the address it's queried for into our thin
 * history shape. The fee comes from the API directly; received/sent are
 * derived by walking vin/vout for entries that match the address.
 */
function summarizeTx(tx: EsploraTx, address: string): BitcoinTxHistoryEntry {
  let receivedSats = 0n;
  let sentSats = 0n;
  let rbfEligible = false;
  for (const v of tx.vin) {
    const seq = typeof v.sequence === "number" ? v.sequence : 0xffffffff;
    if (seq < 0xfffffffe) rbfEligible = true;
    if (v.prevout?.scriptpubkey_address === address && v.prevout.value !== undefined) {
      sentSats += BigInt(v.prevout.value);
    }
  }
  for (const v of tx.vout) {
    if (v.scriptpubkey_address === address && v.value !== undefined) {
      receivedSats += BigInt(v.value);
    }
  }
  return {
    txid: tx.txid,
    receivedSats,
    sentSats,
    feeSats: tx.fee !== undefined ? BigInt(tx.fee) : 0n,
    ...(tx.status?.block_height !== undefined ? { blockHeight: tx.status.block_height } : {}),
    ...(tx.status?.block_time !== undefined ? { blockTime: tx.status.block_time } : {}),
    rbfEligible,
  };
}

class EsploraIndexer implements BitcoinIndexer {
  constructor(private readonly baseUrl: string) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Bitcoin indexer ${path} returned ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  async getBalance(address: string): Promise<BitcoinAddressBalance> {
    const stats = await this.getJson<EsploraAddressStats>(`/address/${address}`);
    const confirmedSats =
      BigInt(stats.chain_stats.funded_txo_sum) -
      BigInt(stats.chain_stats.spent_txo_sum);
    const mempoolSats =
      BigInt(stats.mempool_stats.funded_txo_sum) -
      BigInt(stats.mempool_stats.spent_txo_sum);
    return {
      address,
      confirmedSats,
      mempoolSats,
      totalSats: confirmedSats + mempoolSats,
      txCount: stats.chain_stats.tx_count + stats.mempool_stats.tx_count,
    };
  }

  async getFeeEstimates(): Promise<BitcoinFeeEstimates> {
    // mempool.space's recommended-fees endpoint lives under `/v1/`. Self-
    // hosted Esplora-only deployments may not have it; for those, the
    // per-block-target endpoint at `/fee-estimates` is the fallback. We
    // try the recommended-fees endpoint first (rich labels) and fall
    // back to deriving the four labels from the per-target map.
    try {
      const r = await this.getJson<BitcoinFeeEstimates>("/v1/fees/recommended");
      // Defensive: ensure the fields are numbers (some Esplora forks may
      // return strings or omit fields; clamp to the floor in that case).
      const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 1);
      return {
        fastestFee: num(r.fastestFee),
        halfHourFee: num(r.halfHourFee),
        hourFee: num(r.hourFee),
        economyFee: num(r.economyFee),
        minimumFee: num(r.minimumFee),
      };
    } catch {
      // Esplora fallback: per-target map keyed by block-count.
      const map = await this.getJson<Record<string, number>>("/fee-estimates");
      const at = (k: string, fallback: number) =>
        typeof map[k] === "number" && Number.isFinite(map[k]) ? map[k] : fallback;
      return {
        fastestFee: at("1", 20),
        halfHourFee: at("3", 10),
        hourFee: at("6", 5),
        economyFee: at("144", 2),
        minimumFee: at("1008", 1),
      };
    }
  }

  async getAddressTxs(
    address: string,
    opts: { limit?: number } = {},
  ): Promise<BitcoinTxHistoryEntry[]> {
    const limit = opts.limit ?? 25;
    // Esplora returns 50 confirmed txs per page (newest-first) +
    // mempool txs at the start. For a single page that's enough for
    // portfolio history rendering. Pagination cursor is `/txs/chain/<last_seen>`
    // — we don't paginate in PR1.
    const txs = await this.getJson<EsploraTx[]>(`/address/${address}/txs`);
    return txs.slice(0, limit).map((tx) => summarizeTx(tx, address));
  }

  async getUtxos(address: string): Promise<BitcoinUtxo[]> {
    interface EsploraUtxo {
      txid: string;
      vout: number;
      value: number;
      status?: { confirmed?: boolean; block_height?: number };
    }
    const utxos = await this.getJson<EsploraUtxo[]>(`/address/${address}/utxo`);
    return utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      unconfirmed: !u.status?.confirmed,
      ...(u.status?.block_height !== undefined
        ? { blockHeight: u.status.block_height }
        : {}),
    }));
  }

  async broadcastTx(rawTxHex: string): Promise<string> {
    const res = await fetchWithTimeout(`${this.baseUrl}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Bitcoin indexer /tx broadcast returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }
    // Esplora returns the txid as plain text.
    const txid = (await res.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `Bitcoin indexer /tx returned an unexpected response (not a 64-hex-char txid): "${txid.slice(0, 80)}"`,
      );
    }
    return txid;
  }

  async getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null> {
    interface EsploraTxStatus {
      confirmed: boolean;
      block_height?: number;
      block_hash?: string;
      block_time?: number;
    }
    interface EsploraTip {
      // mempool.space's `/blocks/tip/height` returns plain text
      // numeric. Esplora-pure returns the same. We fetch via getJson
      // since the Response.json() coerces a plain numeric body just
      // fine; for resilience we handle string parsing too.
      _height?: number;
    }
    void ({} as EsploraTip);
    let status: EsploraTxStatus;
    try {
      status = await this.getJson<EsploraTxStatus>(`/tx/${txid}/status`);
    } catch (err) {
      // Treat 404 as "tx not found" rather than a hard error — caller
      // surfaces the not-found case as a distinct "dropped" state.
      if (err instanceof Error && /returned 404/.test(err.message)) {
        return null;
      }
      throw err;
    }
    if (!status.confirmed) return { confirmed: false };
    // Confirmed → fetch the chain tip to compute confirmation count.
    const tipRes = await fetchWithTimeout(`${this.baseUrl}/blocks/tip/height`, {
      method: "GET",
    });
    if (!tipRes.ok) {
      // Tip fetch failed but we know it's confirmed; return without
      // a count rather than failing the whole call.
      return {
        confirmed: true,
        ...(status.block_height !== undefined ? { blockHeight: status.block_height } : {}),
      };
    }
    const tipText = (await tipRes.text()).trim();
    const tipHeight = Number(tipText);
    if (status.block_height !== undefined && Number.isFinite(tipHeight)) {
      return {
        confirmed: true,
        blockHeight: status.block_height,
        confirmations: Math.max(0, tipHeight - status.block_height + 1),
      };
    }
    return {
      confirmed: true,
      ...(status.block_height !== undefined ? { blockHeight: status.block_height } : {}),
    };
  }
}

let cached: { url: string; impl: BitcoinIndexer } | undefined;

/**
 * Get the singleton indexer. Re-resolved if the URL has changed (env or
 * config swap). Lazy — env vars / config files are read on first call.
 */
export function getBitcoinIndexer(): BitcoinIndexer {
  const url = resolveIndexerUrl();
  if (!cached || cached.url !== url) {
    cached = { url, impl: new EsploraIndexer(url) };
  }
  return cached.impl;
}

/** Test-only — drop the cached indexer so a fresh URL resolution runs. */
export function resetBitcoinIndexer(): void {
  cached = undefined;
}
