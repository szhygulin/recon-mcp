import { CHAIN_IDS } from "../types/index.js";
import type { SupportedChain, TxVerification, UnsignedTronTx, UnsignedTx } from "../types/index.js";

/**
 * Render the VERIFY-BEFORE-SIGNING text block that every `prepare_*` tool
 * ends with. Returned as a separate MCP content element so the prose is
 * visible to the user verbatim — we don't rely on the model to re-summarize
 * it and accidentally drop the URL, the hash, or the nudge.
 */

function truncateCalldata(data: `0x${string}`): string {
  if (data.length <= 26) return data;
  const head = data.slice(0, 14);
  const tail = data.slice(-8);
  const byteLen = (data.length - 2) / 2;
  return `${head}…${tail}  (${byteLen} bytes)`;
}

function formatArgs(v: TxVerification): string {
  if (v.humanDecode.args.length === 0) {
    if (v.humanDecode.source === "none") {
      return "  (destination not in local registry — decoder URL is the only decode you have)";
    }
    return "  (no arguments)";
  }
  return v.humanDecode.args
    .map((a) => `  - ${a.name} (${a.type}) = ${a.valueHuman ?? a.value}`)
    .join("\n");
}

export function renderVerificationBlock(
  tx: Pick<UnsignedTx, "chain" | "to" | "value" | "data"> & { verification: TxVerification },
): string {
  const v = tx.verification;
  const chainId = CHAIN_IDS[tx.chain];
  const decoderLine = v.decoderUrl
    ? `  URL:         ${v.decoderUrl}`
    : `  URL:         (paste-only) ${v.decoderPasteInstructions}`;
  const funcLine = v.humanDecode.signature
    ? `  Function:    ${v.humanDecode.signature}`
    : `  Function:    ${v.humanDecode.functionName}`;

  return [
    "VERIFY BEFORE SIGNING — please open the decoder URL in your browser and",
    "compare its decoded output against what's shown below. Approve on your",
    "Ledger only if the function + arguments match.",
    "",
    decoderLine,
    funcLine,
    "  Arguments:",
    formatArgs(v),
    "  Raw:",
    `    chainId = ${chainId} (${tx.chain})`,
    `    to      = ${tx.to}`,
    `    value   = ${tx.value} wei`,
    `    data    = ${truncateCalldata(tx.data)}`,
    `  Fingerprint: ${v.payloadHash}`,
    `  Short:       ${v.payloadHashShort}  (first 8 hex chars — echoed at send time)`,
    "",
    "If the decode at swiss-knife differs from the arguments above, REJECT on",
    "your Ledger. The on-device screen shows the destination and value; the",
    "calldata itself is not human-readable there, which is exactly why this",
    "cross-check matters.",
  ].join("\n");
}

export function renderTronVerificationBlock(tx: UnsignedTronTx & { verification: TxVerification }): string {
  const v = tx.verification;
  const argsBlock = formatArgs(v);
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL is available for",
    "TRON; please read the decoded action + arguments below carefully and",
    "approve on your Ledger only if they match what you intended.",
    "",
    `  Action:      ${tx.action}`,
    `  Function:    ${v.humanDecode.functionName}`,
    "  Arguments:",
    argsBlock,
    "  Raw:",
    `    from        = ${tx.from}`,
    `    txID        = ${tx.txID}`,
    `    rawDataHex  = ${truncateRawHex(tx.rawDataHex)}`,
    `  Fingerprint: ${v.payloadHash}`,
    `  Short:       ${v.payloadHashShort}  (first 8 hex chars — echoed at send time)`,
    "",
    "After signing you can paste the txID into https://tronscan.org to cross-",
    "check the network's interpretation of the call.",
  ].join("\n");
}

function truncateRawHex(hex: string): string {
  const normalized = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (normalized.length <= 26) return normalized;
  const head = normalized.slice(0, 14);
  const tail = normalized.slice(-8);
  const byteLen = Math.floor((normalized.length - 2) / 2);
  return `${head}…${tail}  (${byteLen} bytes)`;
}

// SupportedChain re-exported only for the chain annotation in the block.
export type { SupportedChain };
