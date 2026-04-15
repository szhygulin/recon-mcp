import { CHAIN_IDS } from "../types/index.js";
import type { SupportedChain, TxVerification, UnsignedTronTx, UnsignedTx } from "../types/index.js";

/**
 * Render the VERIFY-BEFORE-SIGNING text block that every `prepare_*` tool
 * ends with. Returned as a separate MCP content element; the server-level
 * `instructions` field tells orchestrator agents to forward it verbatim.
 */

/**
 * ERC-20 `approve(address,uint256)` selector. Ledger's Ethereum app
 * clear-signs approvals natively (showing spender + amount on-device), so
 * the swiss-knife cross-check adds no security here and just lengthens
 * the chat. The send-time payload-hash guard still runs — only the
 * user-visible block is suppressed.
 */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/** Returns false for txs whose verification block should be suppressed. */
export function shouldRenderVerificationBlock(
  tx: Pick<UnsignedTx, "data">,
): boolean {
  return !tx.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR);
}

function truncateHex(data: string, bytelenLabel: boolean): string {
  const normalized = data.startsWith("0x") ? data : `0x${data}`;
  if (normalized.length <= 26) return normalized;
  const head = normalized.slice(0, 14);
  const tail = normalized.slice(-8);
  const byteLen = Math.floor((normalized.length - 2) / 2);
  return bytelenLabel ? `${head}…${tail} (${byteLen} bytes)` : `${head}…${tail}`;
}

function formatArgs(v: TxVerification): string {
  if (v.humanDecode.args.length === 0) {
    if (v.humanDecode.source === "none") {
      return "    (unknown destination — the decoder URL is your only decode)";
    }
    return "    (no arguments)";
  }
  return v.humanDecode.args
    .map((a) => `    - ${a.name}: ${a.valueHuman ?? a.value}`)
    .join("\n");
}

export function renderVerificationBlock(
  tx: Pick<UnsignedTx, "chain" | "to" | "value" | "data"> & { verification: TxVerification },
): string {
  const v = tx.verification;
  const chainId = CHAIN_IDS[tx.chain];
  const decoder = v.decoderUrl ?? `(paste manually) ${v.decoderPasteInstructions}`;
  const call = v.humanDecode.signature ?? v.humanDecode.functionName;
  return [
    "VERIFY BEFORE SIGNING — open the decoder URL, confirm it decodes to the",
    "same call shown below, and REJECT on Ledger if they differ.",
    `  Decoder: ${decoder}`,
    `  Call:    ${call}`,
    "  Args:",
    formatArgs(v),
    `  chainId=${chainId} ${tx.chain}  to=${tx.to}  value=${tx.value} wei  data=${truncateHex(tx.data, true)}`,
    `  Hash: ${v.payloadHash}  (short ${v.payloadHashShort}, echoed at send time)`,
  ].join("\n");
}

export function renderTronVerificationBlock(tx: UnsignedTronTx & { verification: TxVerification }): string {
  const v = tx.verification;
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL; confirm the",
    "action + args below match what you intended, else REJECT on Ledger.",
    `  Action:  ${tx.action}`,
    `  Call:    ${v.humanDecode.functionName}`,
    "  Args:",
    formatArgs(v),
    `  from=${tx.from}  txID=${tx.txID}  rawData=${truncateHex(tx.rawDataHex, true)}`,
    `  Hash: ${v.payloadHash}  (short ${v.payloadHashShort}, echoed at send time)`,
    "  After signing, paste txID into https://tronscan.org to cross-check.",
  ].join("\n");
}

export type { SupportedChain };
