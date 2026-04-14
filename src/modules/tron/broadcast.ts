import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import type { UnsignedTronTx } from "../../types/index.js";

/**
 * `/wallet/broadcasttransaction` response. TronGrid encodes failures as
 * `{code: "SIGERROR" | "CONTRACT_VALIDATE_ERROR" | ..., message: hex-utf8}` —
 * note `message` is hex-encoded UTF-8, not plain text. Success is
 * `{result: true, txid}`.
 */
interface BroadcastResponse {
  result?: boolean;
  txid?: string;
  code?: string;
  message?: string;
}

/** Decode TronGrid's hex-encoded UTF-8 error message into plain text. */
function decodeHexMessage(hex: string): string {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return hex;
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return hex;
  }
}

/**
 * Broadcast a signed TRON transaction via TronGrid.
 *
 * The signature is appended to the raw tx envelope in the `signature[]`
 * field. TronGrid multi-sig would use multiple entries; for single-sig
 * (the only flow we support) it's always exactly one.
 *
 * Returns the on-chain txID on success. Throws with the decoded error
 * message on validation / signature failures.
 */
export async function broadcastTronTx(
  tx: UnsignedTronTx,
  signatureHex: string
): Promise<{ txID: string }> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const body = {
    txID: tx.txID,
    raw_data: tx.rawData,
    raw_data_hex: tx.rawDataHex,
    signature: [signatureHex],
    visible: true,
  };

  const res = await fetch(`${TRONGRID_BASE_URL}/wallet/broadcasttransaction`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid /wallet/broadcasttransaction returned ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as BroadcastResponse;
  if (data.result === true) {
    return { txID: data.txid ?? tx.txID };
  }
  const decoded = data.message ? decodeHexMessage(data.message) : "unknown error";
  throw new Error(
    `TronGrid broadcast rejected the transaction: ${data.code ?? "unknown code"} — ${decoded}`
  );
}
