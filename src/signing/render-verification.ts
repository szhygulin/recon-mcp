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
  tx: Pick<UnsignedTx, "data">,
): string | null {
  if (!shouldRenderVerificationBlock(tx)) return null;
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `Replace the VERIFY-BEFORE-SIGNING block above with a COMPACT bullet`,
    `summary — do NOT relay it verbatim to the user. The raw block is a wall`,
    `of hex/struct data that drowns the sentence that actually matters. The`,
    `user sees the server-side cross-check (the "summary" field) and the`,
    `Ledger short hash; that's the real security story.`,
    ``,
    `Do this, in order:`,
    `  1. The server already ran the independent 4byte.directory cross-check`,
    `     and emitted a block marked "[CROSS-CHECK SUMMARY — RELAY VERBATIM`,
    `     TO USER ...]" above. Copy that summary VERBATIM as the FIRST line(s)`,
    `     of your reply. Keep the "✓" / "✗" prefix unchanged. If it says`,
    `     "DO NOT SEND" (mismatch), stop and do not produce the bullet summary`,
    `     — refusing is the correct action. If it says "error", "no-signature",`,
    `     or "not-applicable", still relay it so the user knows why there is no`,
    `     independent check this turn — then proceed. Do NOT skip this relay;`,
    `     do NOT script your own WebFetch to 4byte or swiss-knife to duplicate`,
    `     the check; do NOT fabricate a "✓ cross-check passed" line.`,
    `  2. Produce a COMPACT bullet summary of the prepared tx, NOT a verbatim`,
    `     relay of the VERIFY-BEFORE-SIGNING block. Required shape:`,
    `       - Headline: "Prepared <action> — <one-line human summary>"`,
    `       - From: <sender address>`,
    `       - To: <to address> (<label if known, e.g. "LiFi diamond", "Aave`,
    `         pool", "Lido stETH">)`,
    `       - Value: <human> (<wei>)`,
    `       - Function: <function name / signature>`,
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
    `  3. After the bullet summary, OFFER the user a further check in a`,
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
    `  4. End your reply with the Ledger-screen reminder. DO NOT tell the`,
    `     user "the hash on Ledger must be <shortHash>" — our payloadHash is`,
    `     over {chain, to, value, data} only, but Ledger's blind-sign hash`,
    `     is over the full RLP including nonce + fee fields that Ledger Live`,
    `     chooses at send time. Those hashes will not match, and claiming`,
    `     they will train the user to rubber-stamp a real mismatch. Instead,`,
    `     cover both on-device modes honestly in one sentence:`,
    `       "On the Ledger screen: if the device clear-signs with decoded`,
    `        fields (Aave / Lido / 1inch / LiFi / approve plugin), confirm`,
    `        <function> + <key field, e.g. 'Min out 0.04 ETH' for a swap or`,
    `        'Spender + Cap' for an approve>. If the device blind-signs`,
    `        (shows only a hash), the hash is not pre-computable here — the`,
    `        checks you CAN do on-screen are: To = <to address> and Value =`,
    `        <human native amount>. Reject on-device if either doesn't match."`,
    `     Fill in <to address> and <human native amount> from the bullet`,
    `     summary above so the user has exact values to eyeball.`,
  ];
  return lines.join("\n");
}

/**
 * Emitted as a second content block on every successful `send_transaction`
 * response. Tells the agent to poll `get_transaction_status` itself instead
 * of asking the user to type "next" — waiting on human turn-taking for a
 * routine inclusion poll is UX friction the user has to break out of.
 *
 * The cadence (~5s between polls, ~2min total) matches typical L1/L2
 * inclusion times without paging the RPC unnecessarily. If inclusion is
 * slow, the agent reports `pending` and the user can decide to keep waiting.
 *
 * For approve→action chains (`nextHandle` present), the agent must wait for
 * the approval receipt BEFORE re-simulating or sending the next step —
 * otherwise the dependent simulation fails with "insufficient allowance"
 * against pre-inclusion state.
 */
export function renderPostSendPollBlock(args: {
  chain: string;
  txHash: string;
  nextHandle?: string;
}): string {
  const { chain, txHash, nextHandle } = args;
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `The tx was forwarded to Ledger and broadcast; a txHash is above. Do NOT`,
    `stop and ask the user to type "next" or "check status" — poll inclusion`,
    `yourself and only speak again when you have a real outcome.`,
    ``,
    `Do this, in order:`,
    `  1. Call get_transaction_status({ chain: "${chain}", txHash: "${txHash}" })`,
    `     every ~5 seconds until status is "success" or "failed", or until`,
    `     you have polled for ~2 minutes (~24 polls). If status stays`,
    `     "pending" / "unknown" past that budget, stop polling and tell the`,
    `     user the tx is still pending with the hash so they can watch it`,
    `     on a block explorer.`,
    `  2. On "success": one short line to the user — what confirmed, the`,
    `     short hash or an explorer link, and (if relevant) the updated`,
    `     state (e.g. new allowance, new supplied balance). Do NOT re-dump`,
    `     the full tx bullet summary.`,
    `  3. On "failed": one short line naming the failure and the hash, then`,
    `     stop — do not auto-retry.`,
    nextHandle
      ? `  4. On "success", a follow-up tx is queued (nextHandle=${nextHandle}).` +
        ` Proceed with the normal prepare/send flow for that handle — the` +
        ` approval is now on-chain so the dependent simulation will pass.` +
        ` Do NOT send the nextHandle before confirmation; a pre-inclusion` +
        ` simulate reverts with "insufficient allowance".`
      : `  4. No follow-up tx is queued; end your turn after reporting.`,
    ``,
    `Between polls, stay silent — no "still waiting..." chatter. The user`,
    `only needs to hear from you when the status actually changes.`,
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
