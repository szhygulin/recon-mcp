import { CHAIN_IDS } from "../types/index.js";
import type {
  SupportedChain,
  TxVerification,
  UnsignedSolanaTx,
  UnsignedTronTx,
  UnsignedTx,
} from "../types/index.js";
import { solanaLedgerMessageHash } from "./verification.js";

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

/**
 * ERC-20 `transfer(address,uint256)` selector. Same reason as
 * `approve`: Ledger's Ethereum app + ERC-20 plugin clear-signs token
 * transfers on-device (shows recipient + amount + token symbol). The
 * blind-sign hash-match check never fires for these, and the
 * pair-consistency recompute adds no information that the clear-sign
 * screens don't already give the user.
 */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/** Returns false for txs whose verification block should be suppressed. */
export function shouldRenderVerificationBlock(
  tx: Pick<UnsignedTx, "data">,
): boolean {
  return !tx.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR);
}

/**
 * True for txs the Ledger Ethereum app is guaranteed to clear-sign —
 * native-value sends (empty calldata), ERC-20 `transfer`, and ERC-20
 * `approve`. For these, the CHECKS PERFORMED block should be trimmed:
 *
 *   - drop the PAIR-CONSISTENCY HASH line entirely (no value; clear-sign
 *     screens + 4byte-decode cover intent),
 *   - drop the BLIND-SIGN branch of the NEXT ON-DEVICE section (it
 *     never fires for these txs, so the instruction is noise under
 *     device-screen time pressure),
 *   - expand the CLEAR-SIGN branch to explicitly list native + ERC-20
 *     transfer + approve so the user sees their tx type named.
 *
 * DOES NOT change security guarantees — the server still pins the tuple,
 * computes the preSignHash, and enforces the payload-hash match at send
 * time. Only the user-facing render is simplified for the three cases
 * where extra lines create confusion rather than signal.
 */
export function isClearSignOnlyTx(tx: Pick<UnsignedTx, "data">): boolean {
  const data = tx.data.toLowerCase();
  // Empty calldata = native send (SystemProgram-equivalent). Any form of
  // "0x" / "" / "0x0" (some older paths emit without the prefix) counts.
  if (data === "" || data === "0x") return true;
  if (data.startsWith(ERC20_APPROVE_SELECTOR)) return true;
  if (data.startsWith(ERC20_TRANSFER_SELECTOR)) return true;
  return false;
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
    `of hex/struct data that drowns the sentence that actually matters.`,
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
    `     by send_transaction / verify_tx_decode.`,
    `  3. End your reply with ONE line directing the user at the next step:`,
    `       "Reply 'send' to continue — I'll run end-to-end integrity checks`,
    `        at that point and report the results before Ledger prompts you."`,
    `     Do NOT surface a menu of options here. The mandatory integrity`,
    `     checks (agent-side ABI decode + pair-consistency hash) run at`,
    `     preview_send time, unprompted, and you report them in a CHECKS`,
    `     PERFORMED block at that point. The swiss-knife decoder URL is`,
    `     already embedded in the VERIFY BEFORE SIGNING block above as a`,
    `     fallback the user can hit if your preview-time ABI decode is`,
    `     low-confidence — do NOT surface it as a prompted option now.`,
    `  4. When the user replies "send", call preview_send(handle) BEFORE`,
    `     calling send_transaction. preview_send pins nonce + EIP-1559 fees,`,
    `     computes the EIP-1559 pre-sign RLP hash the Ledger device will`,
    `     display in blind-sign mode, and returns an agent-task block telling`,
    `     you to auto-run the two mandatory integrity checks. Follow that`,
    `     block's CHECKS PERFORMED protocol before calling send_transaction.`,
    `     The LEDGER BLIND-SIGN HASH block emitted by preview_send is marked`,
    `     "RELAY VERBATIM TO USER; THEY MATCH ON-DEVICE" — the user reads it`,
    `     BEFORE the Ledger device prompts, so the hash is on-screen when the`,
    `     device prompt appears. On-device, verify  To = <to address>  and`,
    `     Value = <human native amount>; the device clear-signs for Aave /`,
    `     Lido / 1inch / LiFi / approve plugins, otherwise blind-signs with`,
    `     the hash from the LEDGER BLIND-SIGN HASH block.`,
  ];
  return lines.join("\n");
}

/**
 * User-facing block emitted on every successful EVM `preview_send`. Surfaces
 * the EIP-1559 pre-sign RLP hash we predict Ledger will display in blind-sign
 * mode, given the nonce/fee/gas fields the server pinned and will forward via
 * WalletConnect on the subsequent `send_transaction`. This closes the
 * calldata-integrity gap at the device boundary — in the old world the
 * on-device hash was unpredictable (Ledger Live picked nonce + fees) so the
 * user could only eyeball To + Value.
 *
 * Emitted at PREVIEW time (before send_transaction) so the user sees the hash
 * BEFORE the Ledger device prompt appears. Single MCP tool calls cannot
 * interleave content with the blocking device prompt, so the preview → send
 * split is the only way to guarantee ordering.
 *
 * Marked for VERBATIM relay to the user — the orchestrator agent must NOT
 * collapse this into its bullet summary. The "Edit gas / Edit fees" warning
 * is load-bearing: if the user taps that in Ledger Live, the hash diverges
 * and they should reject on-device and re-run preview_send + send_transaction.
 */
export function renderLedgerHashBlock(args: {
  preSignHash: string;
  to: string;
  valueWei: string;
}): string {
  return [
    "LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER; THEY MATCH ON-DEVICE",
    `  Hash: **\`${args.preSignHash}\`**`,
    "",
    "When you relay this block to the user, keep the \\`**`0x…`**\\` wrapper on",
    "the hash exactly as printed above — bold AND single-backtick inline code.",
    "Backticks alone render too subtly in some chat clients (users have missed",
    "them under device-screen time pressure); the bold+code combo reads with",
    "clear contrast in every client tested.",
    "",
    "Read this hash NOW, before you call send_transaction. When Ledger prompts",
    "on-device you will have seconds to compare — having the value on screen",
    "already saves a lot of squinting.",
    "",
    "If your Ledger device BLIND-SIGNS (shows only a hash), the hash on-device",
    "MUST equal the value above. Reject on the device if they differ.",
    "",
    "If your Ledger CLEAR-SIGNS (decoded fields via an Aave/Lido/1inch/LiFi/",
    "approve plugin), hash matching does not apply — confirm the decoded",
    "function + key field instead (as described in the prepare step).",
    "",
    `On-device you can always additionally verify:  To = ${args.to}   Value = ${args.valueWei} wei`,
    "",
    "If you tap \"Edit gas\" / \"Edit fees\" in Ledger Live, the hash WILL NOT",
    "match the value above (you changed a field that feeds the hash). You may",
    "still approve on-device if you accept that tradeoff — but the server's",
    "hash-match guarantee no longer applies, so you are signing without the",
    "end-to-end calldata-integrity check. If you want that check back, reject",
    "on-device and call preview_send again for a fresh pin + hash, then send.",
  ].join("\n");
}

/**
 * User-facing block listing the EXACT args the agent supplied to a
 * `prepare_*` tool. Raised against the "narrow prompt-injection / malicious
 * skill / compromised subagent" threat model: the agent freely composes the
 * bullet summary, so a narrowly-compromised agent can *display* benign args
 * ("Send 0.1 ETH to Alice") while having *called* MCP with malicious ones
 * ("to = 0xEvil"). Forcing these receipts through a labeled verbatim-relay
 * block makes invisible tampering harder — the attacker must also craft
 * instructions that strip/mutate this specific block, not just rewrite args.
 *
 * Caveats, stated honestly:
 *   - A fully-coordinated compromised agent can drop this block; the whole
 *     user view goes through it. This is defense-in-depth against common
 *     attacks (prompt injection, add-on misbehavior), NOT a hard second
 *     trust boundary like the Ledger device display.
 *   - The values here match what MCP received, not what MCP forwards to
 *     the device — MCP-side tampering is caught by the LEDGER BLIND-SIGN
 *     HASH block at preview time, not here.
 *
 * Values are rendered as `key: value`; objects/arrays fall back to JSON so
 * nested structures (e.g. Tron vote tuples) stay inspectable without hand-
 * rolled formatting per shape.
 */
export function renderPrepareReceiptBlock(args: {
  tool: string;
  args: Record<string, unknown>;
}): string {
  const lines = [
    "PREPARE RECEIPT — RELAY VERBATIM TO USER",
    `  Tool: ${args.tool}`,
    "  Args (as the agent supplied them to the MCP server — not the agent's retelling):",
  ];
  const entries = Object.entries(args.args);
  if (entries.length === 0) {
    lines.push("    (none)");
  } else {
    for (const [k, v] of entries) {
      const rendered =
        v === undefined || v === null
          ? String(v)
          : typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
            ? String(v)
            : JSON.stringify(v);
      lines.push(`    ${k}: ${rendered}`);
    }
  }
  lines.push("");
  lines.push("If these args don't match what you asked for, STOP — something between you");
  lines.push("and the MCP server (prompt injection, malicious skill, compromised sub-");
  lines.push("agent) rewrote the request. The bullet summary is the agent's retelling;");
  lines.push("these values are what actually hit the server.");
  return lines.join("\n");
}

/**
 * Agent-task block attached to every `preview_send` response. Flipped from
 * the original "offer two options, don't run either unprompted" shape to
 * "auto-run the two mandatory integrity checks and report results in a
 * CHECKS PERFORMED block". Rationale: four separate yes/no prompts (swiss-
 * knife URL, agent-ABI decode, pair-consistency hash, second-LLM) for
 * defenses the user almost always wants is ceremony, not safety — and all
 * three "anti-compromised-MCP" defenses (ABI decode + pair-consistency +
 * on-device hash match) can run automatically. The second-LLM check stays
 * user-prompted because it requires physical user action (paste to another
 * LLM) and is the only defense against a coordinated-agent compromise.
 *
 * The structured ChecksPayload JSON embedded below is the contract the
 * agent renders its CHECKS PERFORMED block from — server authors the
 * threat taxonomy + required keywords; agent paraphrases naturally but
 * must cover every listed threat.
 */
export function renderPreviewVerifyAgentTaskBlock(args: {
  chain: string;
  preSignHash: string;
  pinned: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gas: string;
  };
  to: string;
  valueWei: string;
  /**
   * Swiss-knife decoder URL carried from prepare-time verification. Spliced
   * into the ⚠ DECODE UNAVAILABLE branch of the CHECKS PERFORMED template so
   * the agent has no ambiguity about where it goes — when agents were told
   * "include the swiss-knife URL from the prepare block" they paraphrased
   * "see the earlier block" instead of actually rendering the URL, forcing
   * the user to scroll back.
   */
  decoderUrl?: string;
  /**
   * True when the tx is a Ledger clear-sign-only type (native send,
   * ERC-20 transfer, ERC-20 approve). When set, the CHECKS PERFORMED
   * template drops the PAIR-CONSISTENCY HASH line and the BLIND-SIGN
   * branch of NEXT ON-DEVICE — those are noise for clear-sign-only txs
   * (the Ledger shows decoded fields; no hash-match ever applies; the
   * on-device `to` + `value` + token-symbol read covers intent).
   * Computed server-side via `isClearSignOnlyTx(tx.data)` at preview
   * time. No security posture change — the server still pins fields and
   * checks the payload hash at send time.
   */
  clearSignOnly?: boolean;
}): string {
  const simple = args.clearSignOnly === true;
  const checksPayload = {
    abiDecode: {
      autoRun: true,
      threat: "MCP-side calldata tampering",
      keywords: ["calldata tampering"],
    },
    ...(simple
      ? {}
      : {
          pairConsistencyHash: {
            autoRun: true,
            threat:
              "MCP lying about the bytes it will forward to WalletConnect",
            keywords: ["bytes", "WalletConnect"],
          },
        }),
    secondLlm: {
      autoRun: false,
      threat: "coordinated agent compromise",
      keywords: ["coordinated", "agent"],
    },
  };
  const lines = [
    "[AGENT TASK — RUN THESE CHECKS NOW, DO NOT ASK THE USER]",
    ...(simple
      ? [
          "You MUST run the ABI DECODE integrity check UNPROMPTED and report",
          "the result in a prominent CHECKS PERFORMED block. The user already",
          "consented to verification by calling preview_send — do NOT surface",
          "a yes/no menu. This tx is a Ledger clear-sign type (native send,",
          "ERC-20 transfer, or ERC-20 approve), so the PAIR-CONSISTENCY HASH",
          "check is skipped: Ledger shows decoded fields on-device and the",
          "hash-match path never fires, so the recompute adds no information",
          "the user can act on.",
        ]
      : [
          "You MUST run BOTH of the following integrity checks UNPROMPTED and",
          "report results in a prominent CHECKS PERFORMED block. The user already",
          "consented to verification by calling preview_send — do NOT surface a",
          "yes/no menu for these two. They run every send, no exceptions.",
        ]),
    "",
    "CHECK 1 — AGENT-SIDE ABI DECODE",
    "  Protects against: MCP-side calldata tampering. If the server rewrote",
    "  the bytes, your model-weight decode disagrees with the compact summary",
    "  you showed at prepare time.",
    "",
    "  - Decode the `data` field of the prepared tx from first principles",
    "    using your built-in ABI knowledge of the target contract. Do NOT",
    "    re-read the server's humanDecode; the point is a reading from a",
    "    separate trust boundary (model weights, not server code).",
    "  - If you don't recognize the 4-byte selector or are low-confidence on",
    "    the arg decoding, mark this check ⚠ DECODE UNAVAILABLE in the",
    "    CHECKS PERFORMED block below. You MUST render the swiss-knife decoder",
    "    URL (spliced into the ⚠ render-shape template below) as a Markdown",
    "    hyperlink on its own line directly under the ABI DECODE threat clause",
    "    — a visible, clickable fallback the user can open in their browser",
    "    to decode the calldata against Etherscan's verified ABI. Render as",
    "    `[Open in swiss-knife decoder](<url>)`, NOT as a raw URL — swiss-knife",
    "    calldata URLs are multi-KB of hex and wrap the chat unreadably.",
    "    Do NOT paraphrase the URL away with \"see the earlier prepare block\"",
    "    — the user should not have to scroll up to find it. Do NOT fabricate",
    "    a decode when you aren't sure.",
    "  - If confident, compare your decode against the compact bullet summary",
    "    you showed at prepare time. Report ✓ MATCH or ✗ MISMATCH.",
    "",
    ...(simple
      ? []
      : [
          "CHECK 2 — PAIR-CONSISTENCY HASH",
          "  Protects against: the server reporting tuple T with preSignHash=hash(Y)",
          "  where Y≠T, then forwarding Y to WalletConnect. The on-device hash match",
          "  alone does NOT catch that (device sees hash(Y), chat sees hash(Y), they",
          "  agree); only a local recompute of hash(T) from the pinned tuple catches",
          "  the discrepancy.",
          "",
          "  Run in-process with viem. The per-call values are spliced in below so",
          "  you do not have to reconstruct them:",
          "",
          "    node -e \"const {keccak256,serializeTransaction}=require('viem');",
          "    console.log(keccak256(serializeTransaction({type:'eip1559',",
          `    chainId:<${args.chain}-id>,nonce:${args.pinned.nonce},`,
          `    maxFeePerGas:${args.pinned.maxFeePerGas}n,`,
          `    maxPriorityFeePerGas:${args.pinned.maxPriorityFeePerGas}n,`,
          `    gas:${args.pinned.gas}n,to:'${args.to}',value:${args.valueWei}n,`,
          "    data:'<data from the prepare_* result>'})))\"",
          "",
          `  Compare the output to ${args.preSignHash}. Report ✓ MATCH or ✗ MISMATCH.`,
          "",
        ]),
    "CHECKS PAYLOAD (the threat taxonomy + required keywords the user-facing",
    "block below MUST cover — paraphrase naturally but every listed keyword",
    "must appear verbatim somewhere in the matching line):",
    "",
    "```json",
    JSON.stringify(checksPayload, null, 2),
    "```",
    "",
    "After BOTH checks run, emit EXACTLY this block shape to the user — CAPS",
    "headers, ✓/✗/⚠/⏸ symbols, the keywords above embedded in each threat",
    "clause.",
    "",
    "NOTATION — READ THIS BEFORE COPYING THE BLOCK:",
    "  Placeholders you REPLACE in your output:",
    "    {✓|✗|⚠}            pick one symbol based on your verdict",
    "    {✓|⏸}              pick one symbol (⏸ only for the native-send skip)",
    "    <one-line verdict> your own prose describing the result",
    "  Literal characters you KEEP EXACTLY in your output (these are",
    "  Markdown rendering directives, NOT placeholders — stripping them",
    "  breaks the rendering and produces the live-run bug where the hash",
    "  appears as plain text and the swiss-knife link loses its URL):",
    "    `0x…`              hash in single backticks → inline-code color",
    "    [label](url)       Markdown hyperlink → clickable link",
    "  Do NOT \"clean up\" these Markdown characters for plain-text output.",
    "  The chat client renders them; leaving them as-is is the whole point.",
    "",
    "    ═══════ CHECKS PERFORMED ═══════",
    "    {✓|✗|⚠} ABI DECODE — <one-line verdict>.",
    "        (protects against MCP-side calldata tampering)",
    ...(args.decoderUrl
      ? [
          "        (On ⚠ only — add the line below VERBATIM, characters",
          "         and all. The [ ] ( ) are literal Markdown link syntax,",
          "         not placeholder notation. Do NOT strip them. Do NOT",
          "         paste the raw URL — swiss-knife calldata URLs are",
          "         multi-KB of hex and wrap the chat unreadably:)",
          `        Browser-side decode fallback: [Open in swiss-knife decoder](${args.decoderUrl})`,
        ]
      : [
          "        (On ⚠ — no swiss-knife URL was available for this tx",
          "         (calldata too large or TRON chain). Tell the user the",
          "         browser fallback is unavailable and the second-LLM",
          "         check (option 2 below) is the remaining gap-closer.)",
        ]),
    ...(simple
      ? []
      : [
          "    {✓|⏸} PAIR-CONSISTENCY HASH — <one-line verdict>.",
          "        (protects against MCP lying about the bytes sent to WalletConnect)",
        ]),
    "    □ SECOND-LLM CHECK — optional, available on request.",
    "        (protects against a coordinated agent compromise)",
    "    ────────────────────────────────",
    "    NEXT ON-DEVICE — final check happens on your Ledger screen:",
    ...(simple
      ? [
          "      • CLEAR-SIGN (this tx: native ETH send, ERC-20 transfer, or",
          "        ERC-20 approve — Ledger decodes and shows amount + recipient",
          "        + token on-device). Hash matching does NOT apply. Confirm",
          "        the on-device values equal the compact summary above.",
          "        Any difference → REJECT.",
        ]
      : [
          "      • BLIND-SIGN mode (hash only — swaps, most DeFi):",
          `          check the hash shown on-device is exactly **\`${args.preSignHash}\`**.`,
          "          Any difference → REJECT.",
          "      • CLEAR-SIGN mode (decoded fields — Aave / Lido / 1inch / LiFi /",
          "        approve / ERC-20 transfer plugins, including native ETH send):",
          "        hash matching does NOT apply. Check the function name + key",
          "        fields (amount, recipient, spender) on-device match the",
          "        compact summary above. Any difference → REJECT.",
        ]),
    "    ════════════════════════════════",
    "",
    ...(simple
      ? [
          "The NEXT ON-DEVICE line is mandatory — do NOT drop it. For this tx",
          "type (native send / ERC-20 transfer / ERC-20 approve) Ledger will",
          "clear-sign; no blind-sign hash applies, so the blind-sign branch is",
          "omitted to keep the checklist scannable under device-screen time",
          "pressure. Including a hash-match instruction the user cannot act on",
          "has caused live confusion before.",
          "",
        ]
      : [
          "The NEXT ON-DEVICE lines are mandatory — do NOT drop them. Users can only",
          "tell blind-sign from clear-sign when the device prompt actually appears,",
          "so we must explain BOTH paths. Dropping the clear-sign branch has caused",
          "live confusion (\"my device shows decoded fields and no hash, so the hash",
          "check must have failed?\") — it hasn't, the check just does not apply.",
          "",
          "Render the blind-sign hash with BOTH bold AND single-backtick inline code",
          "— i.e. `**\\`0x…\\`**` — exactly as shown in the template above. Backticks",
          "alone render as muted inline-code color in many chat clients (verified in",
          "Claude Code: the backticked hash blended into prose and the user could",
          "not visually pick it out under device-screen time pressure). Bold + code",
          "combines the two strongest emphasis markers Markdown supports, and reads",
          "with clear contrast in every client tested. Do NOT strip either marker.",
          "Whenever you reference the hash elsewhere in your reply (e.g. a summary",
          "line), use the same `**\\`0x…\\`**` wrapper so the hash looks identical at",
          "every appearance — inconsistent emphasis slows the user's match-check.",
        ]),
    "",
    "After the CHECKS PERFORMED block, append EXACTLY one line, no menu:",
    "",
    "    Want an independent second-LLM check? Reply (2). Otherwise reply 'send'.",
    "",
    "If ANY mandatory check fails (✗), LEAD your reply with a prominent",
    '"✗ <CHECK NAME> FAILED — DO NOT SIGN." line on its own, BEFORE the',
    "CHECKS PERFORMED block. The pass/fail is the news.",
    "",
    "SECOND-LLM CHECK — if the user replies (2):",
    "  Call get_verification_artifact({ handle: <handle> }) and relay ONLY",
    "  the artifact's `pasteableBlock` field VERBATIM to the user — a single",
    "  self-contained string with explicit START/END copy markers, instructions,",
    "  and the embedded JSON payload. Do NOT also dump the full artifact JSON,",
    "  do NOT wrap the block in your own commentary between the markers, do",
    "  NOT reformat or translate any line. The user copies from the START",
    "  marker to the END marker into a second, ideally different-provider LLM",
    "  session — that session has no shared context with this one, so it",
    "  decodes the bytes from scratch. Do NOT pre-decode the bytes yourself",
    "  in the same reply — the whole point is that the second agent reads",
    "  with no notes from you. Before/after the pasteableBlock, remind the",
    "  user to compare the second agent's plain-English description against",
    "  what they asked for and match the preSignHash inside the paste block",
    "  against the Ledger screen before approving.",
    "",
    "  This is the second-agent verification and the only check that survives",
    "  a fully-coordinated agent-AND-MCP compromise.",
    "",
    "SEND-CALL CONTRACT — when the user replies \"send\" (after BOTH mandatory",
    "checks passed), call send_transaction with these args (EVM path):",
    "  - handle: <the same handle>",
    "  - confirmed: true",
    "  - previewToken: <the `previewToken` value from THIS preview_send's",
    "    top-level JSON response — not anything you remember from an earlier",
    "    call on the same handle>",
    "  - userDecision: \"send\"",
    "The previewToken + userDecision pair is the server-side gate that proves",
    "this preview step actually ran. Missing/mismatched values are rejected",
    "with a clear error — don't fabricate either. If preview_send was re-",
    "called with refresh:true since you captured the token, the old token is",
    "invalid: re-run the CHECKS PERFORMED sequence before retrying.",
  ];
  return lines.join("\n");
}

/**
 * Block explorer URL template per supported chain. Only the mainnet chains
 * the server supports today — kept inline because centralizing this in a
 * helper would be premature for four entries that rarely change.
 */
const EXPLORER_TX_URL: Record<string, (hash: string) => string> = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  tron: (h) => `https://tronscan.org/#/transaction/${h}`,
};

/**
 * User-facing block emitted immediately after a successful broadcast. The
 * orchestrator must relay it VERBATIM so the txHash and explorer link land
 * in the user's chat BEFORE the polling block (which is an agent directive,
 * not user content). A live-test regression showed the agent sometimes
 * collapsed the raw JSON result and never surfaced the hash — this block
 * makes the hash impossible to miss and gives the user a one-click cross-
 * check while polling runs in the background.
 */
export function renderPostBroadcastBlock(args: {
  chain: string;
  txHash: string;
  preSignHash?: string;
}): string {
  const explorer = EXPLORER_TX_URL[args.chain];
  const explorerLine = explorer
    ? `  Explorer: [view on block explorer](${explorer(args.txHash)})`
    : `  Explorer: (open the tx hash on your chain's block explorer)`;
  const hashMatchLine = args.preSignHash
    ? `  Signed hash: ${args.preSignHash}  (same value you matched on-device at preview)`
    : null;
  return [
    "TRANSACTION BROADCAST — RELAY VERBATIM TO USER",
    `  Chain: ${args.chain}`,
    `  Tx hash: ${args.txHash}`,
    explorerLine,
    ...(hashMatchLine ? [hashMatchLine] : []),
    "",
    "The tx was accepted by the relay and is now propagating. Inclusion polling",
    "continues below — you don't need to do anything; the agent will report the",
    "outcome when it confirms or times out.",
  ].join("\n");
}

/**
 * Emitted as a second content block on every successful `send_transaction`
 * response. Tells the agent to poll `get_transaction_status` itself instead
 * of asking the user to type "next" — waiting on human turn-taking for a
 * routine inclusion poll is UX friction the user has to break out of.
 *
 * Cadence is per-chain: TRON blocks every ~3s, so a 5s interval adds
 * perceptible latency over the actual inclusion time; EVM L1 is ~12s,
 * where 5s is already tight. Undershooting the block time is fine — the
 * node just returns "unknown" / "pending" for the extra polls.
 *
 * For approve→action chains (`nextHandle` present), the agent must wait for
 * the approval receipt BEFORE re-simulating or sending the next step —
 * otherwise the dependent simulation fails with "insufficient allowance"
 * against pre-inclusion state.
 */
const POLL_CADENCE: Record<string, { intervalSec: number; maxPolls: number; budgetLabel: string }> = {
  ethereum: { intervalSec: 5, maxPolls: 24, budgetLabel: "~2 minutes" },
  arbitrum: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  polygon: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  base: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  tron: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
};

export function renderPostSendPollBlock(args: {
  chain: string;
  txHash: string;
  nextHandle?: string;
}): string {
  const { chain, txHash, nextHandle } = args;
  const cadence = POLL_CADENCE[chain] ?? POLL_CADENCE.ethereum;
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `The tx was forwarded to Ledger and broadcast; a txHash is above. Do NOT`,
    `stop and ask the user to type "next" or "check status" — poll inclusion`,
    `yourself and only speak again when you have a real outcome.`,
    ``,
    `Do this, in order:`,
    `  1. Call get_transaction_status({ chain: "${chain}", txHash: "${txHash}" })`,
    `     every ~${cadence.intervalSec} seconds until status is "success" or "failed", or until`,
    `     you have polled for ${cadence.budgetLabel} (~${cadence.maxPolls} polls). If status stays`,
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
  // No on-device hash line for TRON. The Ledger TRON app clear-signs all
  // native actions (TransferContract, VoteWitness, FreezeBalanceV2, etc.)
  // and well-known TRC-20 transfers (USDT/USDC) — there is no blind-sign
  // hash for the user to match. The txID below is the cross-check anchor:
  // it appears on-device during clear-sign approval AND on tronscan after
  // broadcast. Adding a server-side "payload hash" here would train the
  // user to compare against something the device never shows, reinforcing
  // rubber-stamp habits rather than preventing them.
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL; confirm the",
    "action + args below match what you intended, else REJECT on Ledger.",
    `  Action:  ${tx.action}`,
    `  Call:    ${v.humanDecode.functionName}`,
    ...formatArgs(v),
    `  from=${tx.from}  txID=${tx.txID}  rawData=${truncateHex(tx.rawDataHex, true)}`,
    "  After signing, paste txID into https://tronscan.org to cross-check.",
  ].join("\n");
}

/**
 * User-facing VERIFY BEFORE SIGNING block for Solana txs. Two shapes:
 *
 * - native_send (SystemProgram.Transfer): the Ledger Solana app clear-signs
 *   these unconditionally, so we print the decoded action + amount +
 *   recipient and tell the user to confirm the on-device screens. No
 *   Message Hash — the user has nothing to match.
 *
 * - spl_send (Token.TransferChecked, possibly with createAssociatedTokenAccount
 *   prepended): empirically the Ledger Solana app drops into blind-sign here
 *   because the parser at libsol/spl_token_instruction.c requires a signed
 *   "Trusted Name" TLV descriptor that only Ledger Live supplies. In
 *   blind-sign mode the device displays base58(sha256(messageBytes)) under
 *   the label "Message Hash". We compute the same value server-side and
 *   surface it in bold+code so the user has it on-screen BEFORE the device
 *   prompt fires — same UX the EVM blind-sign flow already uses.
 */
export function renderSolanaVerificationBlock(tx: UnsignedSolanaTx): string {
  if (tx.action === "native_send") {
    return renderSolanaNativeVerificationBlock(tx);
  }
  return renderSolanaSplVerificationBlock(tx);
}

function formatSolanaDecodedArgs(tx: UnsignedSolanaTx): string[] {
  return Object.entries(tx.decoded.args).map(
    ([k, v]) => `    - ${k}: ${v}`,
  );
}

function renderSolanaNativeVerificationBlock(tx: UnsignedSolanaTx): string {
  return [
    "VERIFY BEFORE SIGNING (Solana — native SOL transfer)",
    "The Ledger Solana app clear-signs SystemProgram.Transfer. The on-device",
    "screens will show the amount and recipient — confirm they match the",
    "decoded call below, else REJECT on the device.",
    "",
    `  Call:    ${tx.decoded.functionName}`,
    "  Args:",
    ...formatSolanaDecodedArgs(tx),
    `  From:    ${tx.from}`,
    `  Blockhash: ${tx.recentBlockhash}`,
  ].join("\n");
}

function renderSolanaSplVerificationBlock(tx: UnsignedSolanaTx): string {
  const ledgerHash = solanaLedgerMessageHash(tx.messageBase64);
  return [
    "VERIFY BEFORE SIGNING (Solana — SPL token transfer)",
    "The Ledger Solana app does NOT auto clear-sign SPL transfers (the app",
    "requires a signed Trusted-Name descriptor that only Ledger Live supplies).",
    "Your device will BLIND-SIGN: it shows a 'Message Hash' and nothing else.",
    "",
    "  Required one-time setup: on your Ledger → Solana app → Settings →",
    "  enable 'Allow blind signing'. If this isn't enabled the app will",
    "  refuse to sign.",
    "",
    "LEDGER MESSAGE HASH — match this against your device screen:",
    `  **\`${ledgerHash}\`**`,
    "",
    "This is base58(sha256(messageBytes)) — the exact string the Solana app",
    "computes and displays under the 'Message Hash' label. If the device",
    "shows a different value, REJECT — something between this preview and",
    "the device is tampering with the tx.",
    "",
    `  Call:    ${tx.decoded.functionName}`,
    "  Args:",
    ...formatSolanaDecodedArgs(tx),
    `  From:    ${tx.from}`,
    `  Blockhash: ${tx.recentBlockhash}`,
  ].join("\n");
}

/**
 * Per-call agent-task directive for Solana prepare results. Mirrors the EVM
 * pattern: the server authors the exact shape the agent's user-facing reply
 * must take, so a narrowly-compromised agent can't silently strip the
 * Message Hash or the blind-sign warning. Native sends skip the hash
 * rendering (nothing to match); SPL sends force the agent to relay the
 * `**\`hash\`**` wrapper literally so the hash renders with bold+code
 * contrast in every client (verified in live runs that plain backticks
 * blended into prose).
 */
export function renderSolanaAgentTaskBlock(tx: UnsignedSolanaTx): string {
  if (tx.action === "native_send") {
    return [
      "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
      "Produce a COMPACT bullet summary of the prepared native SOL send. Do",
      "NOT relay the VERIFY-BEFORE-SIGNING block verbatim. Required shape:",
      "  - Headline: \"Prepared native SOL send — <amount> SOL to <short addr>\"",
      "  - From: <from address>",
      "  - To: <to address>",
      "  - Amount: <human SOL amount>",
      "  - Fee: <fee in SOL>",
      "End with ONE line: \"Reply 'send' to forward to the Ledger — the",
      "Solana app will clear-sign (shows amount + recipient on-device).\"",
      "No Message Hash is shown for native sends; do NOT fabricate one.",
    ].join("\n");
  }
  const ledgerHash = solanaLedgerMessageHash(tx.messageBase64);
  return [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    "Produce a COMPACT bullet summary of the prepared SPL token send. Do",
    "NOT relay the VERIFY-BEFORE-SIGNING block verbatim. Required shape:",
    "  - Headline: \"Prepared SPL send — <amount> <symbol> to <short addr>\"",
    "  - From: <from address>",
    "  - To: <to address>",
    "  - Mint: <mint address> (<symbol if known>)",
    "  - Amount: <human amount + symbol>",
    "  - Rent: <rent in SOL if ATA creation, else omit the bullet>",
    "  - Fee: <fee in SOL>",
    "",
    "THEN append EXACTLY this block to your reply — verbatim characters,",
    "including the **`…`** wrappers (bold + single-backtick inline code).",
    "Do NOT strip the Markdown — backticks alone render too subtly and",
    "users have missed them under device-screen time pressure in live",
    "runs. Do NOT paraphrase:",
    "",
    "    ═══════ LEDGER MESSAGE HASH — MATCH ON-DEVICE ═══════",
    `    Hash: **\`${ledgerHash}\`**`,
    "    Your Solana app will BLIND-SIGN (not clear-sign) — it shows the",
    "    hash above under 'Message Hash'. If the device value differs,",
    "    REJECT on the device. Any difference means tampering between this",
    "    reply and the Ledger — do not approve.",
    "    One-time setup: 'Allow blind signing' must be ON in the Solana",
    "    app Settings, or the app refuses the tx.",
    "    ════════════════════════════════════════════════════",
    "",
    "End with ONE line: \"Reply 'send' to forward to the Ledger — match",
    "the hash above against your device screen before tapping Approve.\"",
    "",
    "Whenever you reference this hash elsewhere in your reply (headline,",
    "post-broadcast summary, etc.) use the same `**\\`hash\\`**` wrapper —",
    "inconsistent emphasis slows the user's visual match.",
  ].join("\n");
}

export type { SupportedChain };
