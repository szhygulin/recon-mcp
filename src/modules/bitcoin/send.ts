import {
  SEGWIT_OVERHEAD_VBYTES,
  LEGACY_OVERHEAD_VBYTES,
  VBYTES,
  detectScriptType,
  dustThreshold,
  selectUtxos,
  type BitcoinScriptType,
  type Utxo,
} from "./utxo.js";
import type {
  PrepareBitcoinSendArgs,
  BroadcastBitcoinTxArgs,
} from "./schemas.js";

/**
 * Prepare an unsigned Bitcoin send: fetch UTXOs, run consolidation selection,
 * and return a structured plan (not a PSBT, not a serialized tx). The caller
 * signs it with their preferred tool (Sparrow, Electrum, hardware wallet) and
 * broadcasts the resulting hex via `broadcast_bitcoin_tx`.
 *
 * Why no PSBT / no serialized unsigned hex:
 *   - PSBT requires pulling in bitcoinjs-lib and carries complexity we don't
 *     need for a dev-facing MCP tool.
 *   - Returning a pure selection plan + vsize + fee lets any wallet build the
 *     actual tx. It's the data contract that matters, not the binary layout.
 *
 * Selection strategy lives in ./utxo.ts — spend every spendable UTXO to
 * minimize the post-confirmation UTXO count in the source wallet.
 */

const MEMPOOL_API = "https://mempool.space/api";

interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

interface MempoolFeeRec {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

async function fetchUtxos(address: string): Promise<MempoolUtxo[]> {
  const res = await fetch(`${MEMPOOL_API}/address/${encodeURIComponent(address)}/utxo`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mempool.space UTXO ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as MempoolUtxo[];
}

async function fetchFeeRecommendations(): Promise<MempoolFeeRec> {
  const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
  if (!res.ok) {
    throw new Error(`mempool.space fee rec ${res.status}`);
  }
  return (await res.json()) as MempoolFeeRec;
}

function resolveFeeRate(
  input: PrepareBitcoinSendArgs["feeRate"],
  recs: MempoolFeeRec
): { satVb: number; source: string } {
  if (typeof input === "number") return { satVb: input, source: "user" };
  switch (input) {
    case "fastest":
      return { satVb: recs.fastestFee, source: "fastest (mempool.space)" };
    case "halfhour":
      return { satVb: recs.halfHourFee, source: "halfhour (mempool.space)" };
    case "hour":
    case undefined:
      return { satVb: recs.hourFee, source: "hour (mempool.space)" };
    case "economy":
      return { satVb: recs.economyFee, source: "economy (mempool.space)" };
    case "minimum":
      return { satVb: recs.minimumFee, source: "minimum (mempool.space)" };
  }
}

export interface PreparedBitcoinSend {
  chain: "bitcoin";
  from: string;
  to: string;
  amountSats: string;
  amountBtc: string;
  inputs: {
    txid: string;
    vout: number;
    valueSats: string;
    confirmed: boolean;
  }[];
  outputs: (
    | { role: "recipient"; address: string; valueSats: string; valueBtc: string }
    | { role: "change"; address: string; valueSats: string; valueBtc: string }
  )[];
  fee: {
    sats: string;
    btc: string;
    rateSatVb: number;
    rateSource: string;
    effectiveRateSatVb: number;
    vsize: number;
  };
  /** Script type of the source — determines input witness sizing. */
  sourceScriptType: BitcoinScriptType;
  /**
   * Plain-English summary of what the user will sign. Shown by default so the
   * agent has something human-readable to relay before any external signer sees
   * the tx.
   */
  description: string;
}

function satsToBtc(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = sats % 100_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

export async function prepareBitcoinSend(
  args: PrepareBitcoinSendArgs
): Promise<PreparedBitcoinSend> {
  const sourceScriptType = detectScriptType(args.from);
  const recipientScriptType = detectScriptType(args.to);
  const changeScriptType = sourceScriptType; // Always return change to the sender.
  const isSegwitSource =
    sourceScriptType === "p2wpkh" ||
    sourceScriptType === "p2wsh" ||
    sourceScriptType === "p2tr" ||
    sourceScriptType === "p2sh"; // P2SH-P2WPKH is the practical case.
  const overhead = isSegwitSource ? SEGWIT_OVERHEAD_VBYTES : LEGACY_OVERHEAD_VBYTES;

  const [utxos, feeRecs] = await Promise.all([
    fetchUtxos(args.from),
    fetchFeeRecommendations(),
  ]);

  if (utxos.length === 0) {
    throw new Error(`Address ${args.from} has no UTXOs.`);
  }

  const feeRate = resolveFeeRate(args.feeRate, feeRecs);

  const targetSats = BigInt(args.amountSats);
  if (targetSats <= 0n) {
    throw new Error("amountSats must be a positive integer.");
  }

  const selection = selectUtxos({
    utxos: utxos.map<Utxo>((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status.confirmed,
    })),
    targetSats,
    feeRateSatVb: feeRate.satVb,
    inputVbytes: VBYTES[sourceScriptType].input,
    outputVbytesRecipient: VBYTES[recipientScriptType].output,
    outputVbytesChange: VBYTES[changeScriptType].output,
    overheadVbytes: overhead,
    dustSats: dustThreshold(changeScriptType),
    includeUnconfirmed: args.includeUnconfirmed ?? false,
  });

  const outputs: PreparedBitcoinSend["outputs"] = [
    {
      role: "recipient",
      address: args.to,
      valueSats: targetSats.toString(),
      valueBtc: satsToBtc(targetSats),
    },
  ];
  if (selection.changeSats > 0n) {
    outputs.push({
      role: "change",
      address: args.from,
      valueSats: selection.changeSats.toString(),
      valueBtc: satsToBtc(selection.changeSats),
    });
  }

  return {
    chain: "bitcoin",
    from: args.from,
    to: args.to,
    amountSats: targetSats.toString(),
    amountBtc: satsToBtc(targetSats),
    inputs: selection.chosen.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueSats: u.value.toString(),
      confirmed: u.confirmed,
    })),
    outputs,
    fee: {
      sats: selection.feeSats.toString(),
      btc: satsToBtc(selection.feeSats),
      rateSatVb: feeRate.satVb,
      rateSource: feeRate.source,
      effectiveRateSatVb:
        Math.round(selection.effectiveFeeRateSatVb * 100) / 100,
      vsize: selection.vbytes,
    },
    sourceScriptType,
    description:
      `Send ${satsToBtc(targetSats)} BTC from ${args.from} to ${args.to}. ` +
      `Consumes ${selection.chosen.length} UTXO(s) totaling ${satsToBtc(selection.totalInSats)} BTC. ` +
      `Fee ${selection.feeSats} sats (${satsToBtc(selection.feeSats)} BTC) at ${feeRate.satVb} sat/vB (${feeRate.source}). ` +
      (selection.changeSats > 0n
        ? `Change ${satsToBtc(selection.changeSats)} BTC returned to sender.`
        : `No change output — dust absorbed into fee.`),
  };
}

/**
 * POST a signed raw Bitcoin transaction hex to mempool.space, which forwards it
 * into the mempool. Returns the txid on success. The caller is responsible for
 * producing a correctly signed tx (this tool doesn't validate it).
 */
export async function broadcastBitcoinTx(
  args: BroadcastBitcoinTxArgs
): Promise<{ txid: string; chain: "bitcoin" }> {
  const res = await fetch(`${MEMPOOL_API}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: args.hex,
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Broadcast failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return { txid: body.trim(), chain: "bitcoin" };
}
