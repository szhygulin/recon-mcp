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

function dataByteLen(data: string): number {
  const normalized = data.startsWith("0x") ? data.slice(2) : data;
  return Math.floor(normalized.length / 2);
}

/**
 * Collapse embedded hex blobs inside a rendered arg. Nested struct args
 * (e.g. LiFi `_swapData[].callData`) carry the wrapped-DEX calldata as a
 * 0x… hex run — a single struct-arg can be 2 KB of hex. stringifyArg
 * emits it verbatim; we replace those runs with a head…tail (N bytes)
 * preview so the chat stays scannable.
 *
 * Threshold is 32 bytes (66 chars including "0x"): addresses are 42 chars
 * (already short), bytes32 hashes fit in 66, and anything longer is
 * almost certainly a nested calldata / encoded-params blob the user
 * doesn't want to eyeball here anyway.
 */
const HEX_BLOB_RE = /0x[0-9a-fA-F]{67,}/g;
function truncateNestedHex(s: string): string {
  return s.replace(HEX_BLOB_RE, (m) => {
    const byteLen = Math.floor((m.length - 2) / 2);
    return `${m.slice(0, 14)}…${m.slice(-8)} (${byteLen} bytes)`;
  });
}

function formatArgs(v: TxVerification): string[] {
  if (v.humanDecode.source === "none") {
    // No local ABI — lean on swiss-knife. Skip the "Args:" line entirely
    // (already covered by the decoder URL below).
    return [];
  }
  if (v.humanDecode.args.length === 0) {
    return ["  Args:    (none)"];
  }
  return [
    "  Args:",
    ...v.humanDecode.args.map((a) => `    - ${a.name}: ${truncateNestedHex(a.valueHuman ?? a.value)}`),
  ];
}

function formatCall(v: TxVerification): string {
  if (v.humanDecode.source === "none") {
    return "  Call:    (decoded by swiss-knife only — open the link above)";
  }
  return `  Call:    ${v.humanDecode.signature ?? v.humanDecode.functionName}`;
}

/**
 * Markdown-style clickable link for the decoder URL. Keeps the chat short
 * (4 KB URLs no longer render as a wall of hex) while still exposing the
 * raw URL inside the parens so non-markdown clients stay readable.
 */
function formatDecoder(v: TxVerification): string {
  if (v.decoderUrl) {
    return `  Decoder: [open in swiss-knife](${v.decoderUrl})`;
  }
  return `  Decoder: (paste manually) ${v.decoderPasteInstructions}`;
}

export function renderVerificationBlock(
  tx: Pick<UnsignedTx, "chain" | "to" | "value" | "data"> & { verification: TxVerification },
): string {
  const v = tx.verification;
  const chainId = CHAIN_IDS[tx.chain];
  // When we have a local decode, the decoded Args ARE the calldata's content —
  // repeating the hex preview is just visual noise (and wraps awkwardly in
  // narrow terminals). Keep only the byte length as sizing context. When the
  // decode is "source: none", show a short hex preview so the user has *some*
  // local signal before opening the decoder URL.
  const dataLine =
    v.humanDecode.source === "none"
      ? `  chainId=${chainId} ${tx.chain}  to=${tx.to}  value=${tx.value} wei  data=${truncateHex(tx.data, true)}`
      : `  chainId=${chainId} ${tx.chain}  to=${tx.to}  value=${tx.value} wei  (${dataByteLen(tx.data)} calldata bytes)`;
  return [
    "VERIFY BEFORE SIGNING — check the decoded call below matches what you",
    "asked for, and REJECT on Ledger if it doesn't.",
    formatDecoder(v),
    formatCall(v),
    ...formatArgs(v),
    dataLine,
    `  Hash: ${v.payloadHash}  (short ${v.payloadHashShort}, echoed at send time)`,
  ].join("\n");
}

/**
 * Per-tx instructions for the orchestrator agent — deliberately short, with the
 * 4-byte selector pre-filled so the agent doesn't have to compute it. Returned
 * as a SEPARATE content block so the agent processes it as a directive while
 * the user-facing verification block stays clean.
 *
 * Why this lives in the response (not just the server-level instructions field):
 * server-level instructions load once at session start and tend to be ignored
 * after a few hundred tokens of unrelated turns. Per-call task hints arrive
 * adjacent to the data they describe, so the model is far more likely to act
 * on them. We accept the per-call token cost as the price of reliability.
 *
 * NOTE: ERC-20 approvals suppress this block too — the signature is universally
 * known, the cross-check would be noise, and the verification block itself is
 * suppressed (Ledger clear-signs approves natively).
 */
export function renderAgentTaskBlock(
  tx: Pick<UnsignedTx, "data" | "handle"> & { verification: TxVerification },
): string | null {
  if (!shouldRenderVerificationBlock(tx)) return null;
  const shortHash = tx.verification.payloadHashShort;
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `Replace the VERIFY-BEFORE-SIGNING block above with a COMPACT bullet`,
    `summary — do NOT relay it verbatim to the user. The raw block is a wall`,
    `of hex/struct data that drowns the sentence that actually matters. The`,
    `user sees the server-side cross-check (the "summary" field) and the`,
    `Ledger short hash; that's the real security story.`,
    ``,
    `Do this, in order:`,
    `  1. Call the MCP tool verify_tx_decode with { handle: "<the handle`,
    `     field from this same prepared-tx response>" }. The server runs the`,
    `     same algorithm swiss-knife uses in-browser (fetch the function`,
    `     signature from 4byte.directory, decode via viem, re-encode to prove`,
    `     bytes round-trip losslessly) but server-side, so the user sees the`,
    `     result in chat without opening a browser. Do NOT script your own`,
    `     WebFetch to 4byte or swiss-knife here; always call this tool so the`,
    `     check runs through one auditable code path.`,
    `  2. Copy the tool's "summary" field VERBATIM as the FIRST line(s) of`,
    `     your reply. Keep the "✓" / "✗" prefix unchanged. If status is`,
    `     "mismatch", say "DO NOT SEND" and stop. If status is "error",`,
    `     "no-signature", or "not-applicable", still relay the summary — it`,
    `     tells the user why no independent check was possible — then proceed.`,
    `  3. Produce a COMPACT bullet summary of the prepared tx, NOT a verbatim`,
    `     relay of the VERIFY-BEFORE-SIGNING block. Required shape:`,
    `       - Headline: "Prepared <action> — <one-line human summary>"`,
    `       - From: <sender address>`,
    `       - To: <to address> (<label if known, e.g. "LiFi diamond", "Aave`,
    `         pool", "Lido stETH">)`,
    `       - Value: <human> (<wei>)`,
    `       - Function: <function name / signature>`,
    `       - Short hash: ${shortHash}`,
    `     Then append the tx-specific field that actually matters for THIS`,
    `     flow (pick the right one — not all flows are swaps):`,
    `       - swaps: "Min out: <human amount>"`,
    `       - supplies / withdraws / deposits: "Amount: <human amount>"`,
    `       - sends: "Amount: <human amount>"`,
    `       - approves (when rendered): "Spender: <addr> / Cap: <amount>"`,
    `     Do NOT dump the raw "VERIFY BEFORE SIGNING" hex/struct block.`,
    `     Do NOT echo the handle UUID — it is opaque internal state used only`,
    `     by send_transaction / verify_tx_decode. Just say "Reply 'send' to`,
    `     forward to Ledger" or similar.`,
    `  4. After the bullet summary, OFFER the user a further check in a`,
    `     trust boundary outside the MCP server. The MCP's verify_tx_decode`,
    `     and the local ABI decode both run on the same server code, so a`,
    `     compromised server could in principle lie in both. Present THREE`,
    `     options the user can pick from — do NOT perform any of them`,
    `     unprompted:`,
    `       (a) Open the swiss-knife URL in their own browser (runs the`,
    `           same algorithm in a context they control).`,
    `       (b) Ask you to decode the calldata yourself from your built-in`,
    `           ABI knowledge (model weights are a separate trust boundary`,
    `           from server code — any disagreement is a real signal).`,
    `       (c) Ask you to fetch the swiss-knife URL yourself with WebFetch`,
    `           and report what you can see there. Be honest up front that`,
    `           swiss-knife is a client-side Next.js SPA: the HTTP response`,
    `           is the JS shell, not the decoded output, so WebFetch won't`,
    `           show the user-visible rendering. What you CAN do after`,
    `           fetching: pull the calldata parameter out of the URL query`,
    `           string and decode it yourself against the function signature`,
    `           you recognize — a weaker check than (b) done on a URL the`,
    `           user named, but still a different code path. If the user`,
    `           picks (c), state the limitation before doing the fetch so`,
    `           they can redirect to (b) if they prefer.`,
    `  5. End your reply with the final Ledger-match reminder. You can't`,
    `     know in advance which mode Ledger will use — blind-sign (shows a`,
    `     hash) vs. clear-sign (shows decoded fields via an app/plugin like`,
    `     Lido, Aave, 1inch, LiFi, etc.) — so cover BOTH cases in one`,
    `     sentence. Use this exact shape (substitute the short hash and the`,
    `     one or two fields that matter most for this flow — the function`,
    `     name plus the same key amount you put in the bullet summary):`,
    `       "Before approving on Ledger: if the device shows a hash, it must`,
    `        be ${shortHash}; if it clear-signs with decoded fields, confirm`,
    `        <function> + <key field, e.g. 'Min out 0.04 ETH' for a swap or`,
    `        'Spender + Cap' for an approve>. Reject on-device if neither`,
    `        matches."`,
    `     This is the final tamper check — the bytes we previewed are the`,
    `     bytes we will forward to WalletConnect, and send_transaction`,
    `     re-derives the hash from those exact bytes before broadcasting.`,
  ];
  return lines.join("\n");
}

export function renderTronVerificationBlock(tx: UnsignedTronTx & { verification: TxVerification }): string {
  const v = tx.verification;
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL; confirm the",
    "action + args below match what you intended, else REJECT on Ledger.",
    `  Action:  ${tx.action}`,
    `  Call:    ${v.humanDecode.functionName}`,
    ...formatArgs(v),
    `  from=${tx.from}  txID=${tx.txID}  rawData=${truncateHex(tx.rawDataHex, true)}`,
    `  Hash: ${v.payloadHash}  (short ${v.payloadHashShort}, echoed at send time)`,
    "  After signing, paste txID into https://tronscan.org to cross-check.",
  ].join("\n");
}

export type { SupportedChain };
