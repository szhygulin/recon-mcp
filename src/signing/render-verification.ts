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
    `     trust boundary outside the MCP server. The MCP-side cross-check`,
    `     above and the local ABI decode both run on server code, so a`,
    `     compromised server could in principle lie in both. Present TWO`,
    `     options the user can pick from — do NOT perform either`,
    `     unprompted.`,
    ``,
    `     PLAIN-ENGLISH RULE for the user-facing text: no jargon. Do NOT`,
    `     use the terms 'MCP', 'trust boundary', 'ABI', 'calldata',`,
    `     'selector', 'swiss-knife', 'WebFetch', 'preview_send', 'dispatch',`,
    `     'blind-sign', or 'RLP' in what the user sees. Name the two tool`,
    `     names the user can act on (the decoder URL itself, and 'ask me`,
    `     to re-read it') but explain what they DO in everyday language.`,
    `     Technical descriptions below are for you, not the user:`,
    ``,
    `       (a) Technical: open the swiss-knife URL in the user's own`,
    `           browser (decoder runs in the user's own context, no MCP`,
    `           code on the path — genuinely different trust boundary).`,
    `           Plain-English wording suggestion (adapt freely):`,
    `             "Open the decoder link I gave you in your own browser.`,
    `              It runs in your browser, not on my server, so it's a`,
    `              genuinely separate check — if my description and the`,
    `              decoder's reading don't match, something is wrong."`,
    `       (b) Technical: decode the calldata from your built-in ABI`,
    `           knowledge (model weights are a separate trust boundary`,
    `           from server code — any disagreement with the MCP-side`,
    `           cross-check is a real signal). If you don't recognize`,
    `           the 4-byte selector, you may WebFetch the 4byte.directory`,
    `           or openchain.xyz JSON signature-lookup endpoint as a`,
    `           fallback; say so explicitly so the user knows the`,
    `           signature came from an external registry, not your`,
    `           weights. That's still (b) — it's your decode, just with`,
    `           an extended selector dictionary; the arg-decoding step`,
    `           is still in your weights. Do NOT present this as a`,
    `           separate independent path — there is no agent-driven`,
    `           equivalent of (a) that actually crosses the trust`,
    `           boundary, because full-arg decoders are client-side SPAs`,
    `           that WebFetch can't execute.`,
    `           Plain-English wording suggestion (adapt freely):`,
    `             "Ask me to re-read the transaction from my own knowledge`,
    `              of how these contracts work — a different source than`,
    `              the server's reading. If my reading and the server's`,
    `              disagree, that's a real red flag worth stopping for."`,
    `           If you had to look up an unfamiliar selector in an online`,
    `           registry (4byte / openchain), say so plainly in your user-`,
    `           facing text: "I didn't recognize this contract directly,`,
    `           so I looked the function name up in a public signature`,
    `           registry — the arguments are still my own reading."`,
    ``,
    `     PRESENTATION RULE — make the OFFER visually prominent. Users`,
    `     skim past options crammed into a single sentence next to "reply`,
    `     send to continue". Separate the offer from the send prompt with`,
    `     its own labeled section and vertical list. Required shape:`,
    ``,
    `         EXTRA CHECKS YOU CAN RUN BEFORE REPLYING "SEND":`,
    `           (a) <plain-English option (a)>`,
    `           (b) <plain-English option (b)>`,
    ``,
    `         Reply "send" to continue, or (a) / (b) to run a check first.`,
    ``,
    `     Put a blank line before AND after this block. Do NOT collapse`,
    `     the two options onto one line. Do NOT hide them inside a`,
    `     parenthetical. The header and the bulleted options are the point.`,
    ``,
    `     RESULT REPORTING RULE — when the user picks (a) or (b) and you`,
    `     run the check, LEAD the reply with a one-line verdict on its`,
    `     own line, BEFORE any technical breakdown:`,
    `       - On pass (your independent reading agrees with the server's):`,
    `         "✓ Independent check passed — my reading of the transaction`,
    `          matches the server's reading." Then show the supporting`,
    `          details (function name, decoded args) as evidence below.`,
    `       - On mismatch: "✗ INDEPENDENT CHECK DISAGREES with the server`,
    `          — do NOT sign. Here is what my reading says:" then the`,
    `          details. Make the failure mode unmissable.`,
    `     Do NOT bury the verdict at the end of a long bullet list. The`,
    `     pass/fail line is the news — the walkthrough is the receipt.`,
    `  4. After the user confirms, call preview_send(handle) BEFORE calling`,
    `     send_transaction. preview_send pins nonce + EIP-1559 fees server-`,
    `     side, computes the EIP-1559 pre-sign RLP hash Ledger will display`,
    `     in blind-sign mode, and returns a content block titled "LEDGER`,
    `     BLIND-SIGN HASH — RELAY VERBATIM TO USER; THEY MATCH ON-DEVICE".`,
    `     Forward that block verbatim — the user reads it BEFORE calling`,
    `     send_transaction, so the hash is on-screen when the Ledger device`,
    `     prompt appears. Only then call send_transaction, which forwards`,
    `     the pinned tuple through WalletConnect so the on-device hash is`,
    `     deterministic. If send_transaction returns "Missing pinned gas",`,
    `     you forgot preview_send — call it now.`,
    `  5. End your prepare-turn reply with the Ledger-screen reminder. DO`,
    `     NOT equate our prepare-time payloadHashShort with Ledger's on-`,
    `     device hash — those are different preimages and claiming they`,
    `     match would train the user to rubber-stamp a real mismatch. The`,
    `     blind-sign hash the user will match comes from preview_send (step`,
    `     4 above), not from this prepare turn. Reminder template:`,
    `       "On the Ledger screen: if the device clear-signs with decoded`,
    `        fields (Aave / Lido / 1inch / LiFi / approve plugin), confirm`,
    `        <function> + <key field, e.g. 'Min out 0.04 ETH' for a swap or`,
    `        'Spender + Cap' for an approve>. If the device blind-signs`,
    `        (shows only a hash), match the hash you will see in the`,
    `        LEDGER BLIND-SIGN HASH block printed by preview_send, and`,
    `        additionally verify  To = <to address>  and  Value = <human native amount>.`,
    `        Reject on-device if anything doesn't match."`,
    `     Fill in <to address> and <human native amount> from the bullet`,
    `     summary above so the user has exact values to eyeball.`,
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
    `  Hash: ${args.preSignHash}`,
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
 * Agent-task block attached to every `preview_send` response. Instructs the
 * agent to OFFER an optional independent hash re-computation to the user —
 * the defense against a compromised MCP that would return a hash over bytes
 * different from the ones it actually forwards via WalletConnect.
 *
 * Why the offer-not-run design: the check requires local code execution
 * (viem's `serializeTransaction` + keccak256). It's heavy for every send,
 * and unnecessary if the user trusts their MCP install. We expose it so the
 * option exists, without making every send slower.
 *
 * This is an agent-task block (not user-facing), so the agent processes the
 * instructions and presents a natural-language prompt to the user.
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
}): string {
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    "Optional defense-in-depth: independent hash re-computation to verify",
    "the server's preSignHash is actually over the bytes it will forward to",
    "WalletConnect (caught: a compromised MCP returning hash(X) while sending",
    "bytes Y).",
    "",
    "Offer BOTH of the following to the user as additional trust-boundary",
    "options at preview time (the prepare-time options (a)/(b) remain",
    "available too). Present them together so the user can pick either or",
    "both. Do NOT run either unprompted.",
    "",
    "PLAIN-ENGLISH RULE: phrase both offers in everyday language a non-",
    "technical user can act on. Do NOT use the terms 'keccak', 'keccak256',",
    "'EIP-1559', 'RLP', 'tuple', 'serialize', 'payloadHash', 'preSignHash',",
    "'artifact', or 'trust boundary' in the text you show the user. Describe",
    "what the check DOES (\"re-check the receipt matches what's being sent\",",
    "\"ask a second AI with no notes from me\") and WHY it matters (\"catches",
    "a specific way a compromised server could lie\"). The technical names",
    "stay in this block — they are for you, not the user.",
    "",
    "OPTION — (tuple, hash) pair-consistency check. NARROWER than (b) at",
    "prepare time: (b) catches malicious CALLDATA; this catches a pinned",
    "(tuple, preSignHash) pair where the hash does not correspond to the",
    "tuple — i.e. the server reports tuple T with preSignHash=hash(Y≠T) and",
    "then forwards Y to WalletConnect. The on-device hash match alone does",
    "NOT catch that (chat hash and device hash are both hash(Y), so they",
    "agree); only a local recompute of hash(T) catches the discrepancy.",
    "",
    "Phrase the offer so the user sees how it relates to (b), not as a",
    "restatement. Plain-English wording suggestion (adapt freely; DO NOT",
    "paste verbatim if the flow context makes a better version obvious):",
    '  "Receipt check: I can re-compute the long hash shown above from the',
    '   transaction details myself (amount, recipient, fees) and check it',
    '   matches. Think of it like a cashier showing you a receipt — this is',
    '   me re-adding the receipt to make sure the total on it is the total',
    '   the server is actually charging. It catches one specific kind of',
    '   server-side lie where the hash you see is for a different transaction',
    '   than the one being sent. If you already ran option (b) earlier, this',
    '   is a quick add-on; otherwise I\'ll read the transaction details first',
    '   so the check is meaningful."',
    "",
    "If the user says yes, do this:",
    "  1. PREREQUISITE — if the user did NOT run (b) at prepare time, decode",
    "     the `data` field from the `prepare_*` result against your OWN",
    "     built-in ABI knowledge (not the MCP's decode) and check the",
    "     function + args match the user intent you recorded in the bullet",
    "     summary. If they diverge, STOP — the MCP tampered with `data` and",
    "     step 2 would only confirm the lie. If (b) was already run and",
    "     passed, skip this step.",
    "  2. Serialize the EIP-1559 tuple and keccak256 it. In this repo:",
    "       node -e \"const {keccak256,serializeTransaction}=require('viem');",
    "       console.log(keccak256(serializeTransaction({type:'eip1559',",
    `       chainId:<${args.chain}-id>,nonce:${args.pinned.nonce},`,
    `       maxFeePerGas:${args.pinned.maxFeePerGas}n,`,
    `       maxPriorityFeePerGas:${args.pinned.maxPriorityFeePerGas}n,`,
    `       gas:${args.pinned.gas}n,to:'${args.to}',value:${args.valueWei}n,`,
    "       data:'<data from the prepare_* result>'})))\"",
    `  3. Compare the output to ${args.preSignHash}. If they differ, REFUSE`,
    "     to call send_transaction and tell the user the MCP-reported hash",
    "     does not correspond to the pinned tuple. If they match, the",
    "     pinned tuple and the hash the user will match on-device are the",
    "     same bytes end to end.",
    "",
    "Skip the pair-consistency offer entirely for native sends where the",
    "agent already knows the full tuple (data='0x') and `to`/`value`",
    "eyeballing covers the check. The second-agent offer below still applies.",
    "",
    "OPTION — second-agent verification (the only check that survives a",
    "fully-coordinated compromise where THIS agent and the MCP could be",
    "lying together — a second LLM in a different provider session has no",
    "shared context with either). Plain-English wording suggestion (adapt",
    "freely; keep the everyday framing):",
    '  "Second opinion from a different AI: I can give you a block of text',
    '   to paste into a separate chat window — ideally a different AI service',
    '   (ChatGPT, Gemini, etc — not this one). That AI sees only the raw',
    '   transaction with none of my notes, reads it from scratch, and tells',
    '   you in its own words what it will do. If what that AI describes',
    '   doesn\'t match what I described — or what you asked for — don\'t sign.',
    '   This is the strongest check I can offer: even if this chat and the',
    '   server were both lying to you, an AI that can\'t talk to either of',
    '   us would catch it."',
    "",
    "If the user says yes, call get_verification_artifact({ handle: <handle> })",
    "and relay ONLY the artifact's `pasteableBlock` field VERBATIM to the",
    "user — a single self-contained string with explicit START/END copy",
    "markers, instructions, and the embedded JSON payload. Do NOT also dump",
    "the full artifact JSON, do NOT wrap the block in your own commentary",
    "between the markers, do NOT reformat or translate any line. The user",
    "copies from the START marker to the END marker into the second session;",
    "anything outside those markers is your chat to the user and should stay",
    "outside them. Do NOT pre-decode the bytes yourself in the same reply —",
    "the whole point is that the second agent decodes from scratch without",
    "seeing your description. Before and/or after the pasteableBlock, you",
    "may (and should) remind the user: compare the second agent's plain-",
    "English description to what they asked for, and match the preSignHash",
    "from inside the paste block against the Ledger screen before approving.",
    "",
    "PRESENTATION RULE — make the OFFER visually prominent. Users skim",
    "past options crammed into one sentence next to the send prompt.",
    "Separate the offer from the send-reply line with its own labeled",
    "section and vertical list. Required shape:",
    "",
    "    EXTRA CHECKS YOU CAN RUN BEFORE REPLYING \"SEND\":",
    "      (1) <plain-English pair-consistency offer>",
    "      (2) <plain-English second-agent offer>",
    "",
    "    Reply \"send\" to continue, or (1) / (2) to run a check first.",
    "",
    "Put a blank line before AND after this block. Do NOT collapse the",
    "two options onto one line. Do NOT hide them inside a parenthetical",
    "next to \"Reply send\". The header and the bulleted options are the",
    "point — this is the last gate before funds move.",
    "",
    "RESULT REPORTING RULE — when the user picks (1) and you run the",
    "pair-consistency check, LEAD the reply with a one-line verdict on",
    "its own line, BEFORE the command output or hash value:",
    "  - On pass (your recomputed hash equals the server's hash):",
    '    "✓ Receipt check passed — the hash the server showed you matches',
    "     the transaction details (amount, recipient, fees) the server",
    '     is about to send." Then the computed hash as evidence below.',
    "  - On mismatch: \"✗ RECEIPT CHECK FAILED — the hash does NOT match",
    "    the transaction details. DO NOT SIGN.\" on its own line, in the",
    "    plainest language possible, before anything else.",
    "Do NOT bury the verdict at the end of a command-output block. The",
    "pass/fail line is the news — the hash value is the receipt.",
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

export type { SupportedChain };
