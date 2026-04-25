import { CHAIN_IDS } from "../types/index.js";
import type {
  SupportedChain,
  TxVerification,
  UnsignedBitcoinTx,
  UnsignedSolanaTx,
  UnsignedTronTx,
  UnsignedTx,
} from "../types/index.js";
import { solanaLedgerMessageHash } from "./verification.js";

/**
 * Solana Explorer Inspector URL prefilled with the message bytes — same
 * pattern EVM uses for the swiss-knife decoder URL (calldata embedded).
 * The Inspector route accepts `?message=<base64>` (verified against
 * github.com/solana-foundation/explorer/app/components/inspector/InspectorPage.tsx,
 * which reads `decodeParam(params, 'message')` and feeds it to
 * `VersionedMessage.deserialize`). Standard base64 chars (`+`, `/`, `=`)
 * need URL-encoding so we always run the input through `encodeURIComponent`.
 *
 * The URL is rendered inside the indented CHECKS PERFORMED block as a
 * Markdown hyperlink — EXACTLY mirroring EVM CHECK 1's swiss-knife render.
 * Earlier prototypes that surfaced the link OUTSIDE the block + a paste-
 * fallback code block were called "complete mess" by the user; the EVM
 * shape (one URL line inside the block, no paste section) is the canonical
 * pattern.
 */
function solanaInspectorUrl(messageBase64: string): string {
  return `https://explorer.solana.com/tx/inspector?cluster=mainnet&message=${encodeURIComponent(messageBase64)}`;
}

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
    "",
    `    **\`${args.preSignHash}\`**`,
    "",
    "When you relay this block to the user, keep the hash on a LINE BY ITSELF",
    "with the `**`0x…`**` wrapper (bold + single-backtick inline code) exactly",
    "as printed above. Inline at the end of a prose sentence — even with those",
    "wrappers — blended into surrounding text in live renderings where users",
    "missed it under device-screen time pressure; the isolated indented line",
    "forces a visual break that survives muted inline-code colors.",
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
    "  - SELECTOR-NAME ANCHOR when weights are insufficient: if your model",
    "    weights don't cover the 4-byte selector (common for LiFi-diamond,",
    "    1inch-aggregation-router, and other custom DeFi routers), you MAY",
    "    cite the function name from the `[CROSS-CHECK SUMMARY]` block the",
    "    server emitted at PREPARE time. That summary is the result of an",
    "    independent 4byte.directory lookup — a public registry built from",
    "    unrelated on-chain traffic — and its signature was re-encode-",
    "    verified byte-for-byte against the calldata. 4byte is a separate",
    "    DATA SOURCE from the server's ABI and from your model weights: the",
    "    server fetches it via HTTP but does not author its contents. Treat",
    "    it as a legitimate selector→name anchor for the honest-server case.",
    "    (For the compromised-server case, the user's vaultpilot-preflight",
    "    skill deliberately does NOT rely on 4byte — the skill's model-",
    "    weights-only stance is the fallback, not a contradiction.)",
    "  - Upgrade-path: if (a) the prepare-time 4byte cross-check passed its",
    "    re-encode test (summary marked ✓), AND (b) the static-head args you",
    "    independently decoded (e.g. `_receiver`, `_minAmountOut`) match the",
    "    values in the prepare summary, report this check as ✓ ABI DECODE",
    "    — note the function name comes from 4byte, not your weights.",
    "    Do NOT drop to ⚠ DECODE UNAVAILABLE just because the selector was",
    "    outside your training set; that's what the cross-check is for.",
    "  - Only mark ⚠ DECODE UNAVAILABLE when BOTH your weights and the 4byte",
    "    cross-check came up empty (summary marked `no-signature` or `error`),",
    "    OR when your independent static-head decode DISAGREES with the prepare",
    "    summary. When marking ⚠, you MUST render the swiss-knife decoder",
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
          "          The hash on-device MUST equal:",
          "",
          `              **\`${args.preSignHash}\`**`,
          "",
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
          "Render the blind-sign hash on a LINE BY ITSELF — blank line above, the",
          "hash indented with both bold AND single-backtick inline-code wrappers",
          "(`**\\`0x…\\`**`), blank line below — exactly as shown in the template",
          "above. Keeping it inline at the end of a prose sentence (even bold+code)",
          "blended into surrounding text in live renderings where users missed it",
          "under device-screen time pressure; the isolated indented line forces a",
          "visual break that survives muted inline-code colors. Do NOT strip the",
          "wrappers and do NOT collapse the blank lines. Whenever you reference the",
          "hash elsewhere in your reply (e.g. a summary line), use the same",
          "`**\\`0x…\\`**` wrapper so the hash looks identical at every appearance —",
          "inconsistent emphasis slows the user's match-check.",
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
  bitcoin: (h) => `https://mempool.space/tx/${h}`,
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
  // Bitcoin: ~10-min blocks make agent-side polling wasteful (issue
  // #215). End the turn after the broadcast; user checks the explorer
  // link on their own time. All other chains continue with the standard
  // "agent will report when it confirms" pattern.
  const trailingPara =
    args.chain === "bitcoin"
      ? [
          "The tx was accepted by the relay and is now propagating. Bitcoin",
          "blocks land every ~10 minutes on average — open the explorer link",
          "above when you want to check confirmation. The agent will not",
          "poll; ask it later if you want a one-shot status check.",
        ]
      : [
          "The tx was accepted by the relay and is now propagating. Inclusion polling",
          "continues below — you don't need to do anything; the agent will report the",
          "outcome when it confirms or times out.",
        ];
  return [
    "TRANSACTION BROADCAST — RELAY VERBATIM TO USER",
    `  Chain: ${args.chain}`,
    `  Tx hash: ${args.txHash}`,
    explorerLine,
    ...(hashMatchLine ? [hashMatchLine] : []),
    "",
    ...trailingPara,
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
  // Solana: 400ms slots; poll aggressively for the first ~30s (~60 polls)
  // within the ~60-90s blockhash-validity window. Past that, further
  // polling is pointless — dropped txs get surfaced by the status tool's
  // blockhash-expiry check once the baked blockhash is past.
  solana: { intervalSec: 2, maxPolls: 45, budgetLabel: "~90 seconds" },
  // No `bitcoin` entry: the BTC branch in `renderPostSendPollBlock`
  // returns a "do NOT poll, end your turn" directive (10-min blocks
  // make agent-side polling wasteful — issue #215). Don't reintroduce a
  // bitcoin cadence here; route any new BTC post-send guidance through
  // the early-return branch instead.
};

export function renderPostSendPollBlock(args: {
  chain: string;
  txHash: string;
  nextHandle?: string;
  /**
   * Solana legacy-blockhash txs only (currently just `nonce_init`). Lets
   * the status poller distinguish `dropped` (current block past this) from
   * `pending` for that specific tx kind.
   */
  lastValidBlockHeight?: number;
  /**
   * Solana durable-nonce txs (every send except nonce_init). Lets the
   * status poller authoritatively distinguish `dropped` (on-chain nonce
   * rotated past the baked value) from `pending`. Without it a dropped
   * durable-nonce tx reads as `pending` forever — a known Phase 2 UX gap.
   */
  durableNonce?: { noncePubkey: string; nonceValue: string };
}): string {
  const { chain, txHash, nextHandle, lastValidBlockHeight, durableNonce } = args;
  // Bitcoin: ~10-min average block time + heavy variance. Agent-side
  // polling (even at 30s intervals for 12 minutes) wastes context for
  // ~1 block of coverage and almost always times out without a result.
  // The user checks mempool.space themselves; the agent ends its turn.
  // Issue #215.
  if (chain === "bitcoin") {
    const lines = [
      "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
      `The tx was forwarded to Ledger and broadcast; a txHash is above.`,
      `Bitcoin confirmation takes ~10 minutes on average and often longer;`,
      `polling at this timescale wastes turns without producing a real`,
      `outcome.`,
      ``,
      `Do NOT call get_transaction_status, do NOT poll inclusion, do NOT`,
      `say "I'll watch it" — END YOUR TURN after the TRANSACTION BROADCAST`,
      `block above. The explorer link in that block is the user's path to`,
      `monitor confirmation.`,
      ``,
      `If the user later asks "did it confirm?", call`,
      `get_transaction_status({ chain: "bitcoin", txHash: "${txHash}" })`,
      `ONCE on demand and report the result. Never enter a polling loop.`,
    ];
    if (nextHandle) {
      lines.push(
        ``,
        `A follow-up handle is queued (${nextHandle}). Do NOT proceed with`,
        `it until the user confirms the prior tx has at least 1 confirmation`,
        `— Bitcoin has no mempool-chained-spend semantics worth relying on`,
        `in an interactive flow.`,
      );
    }
    return lines.join("\n");
  }
  const cadence = POLL_CADENCE[chain] ?? POLL_CADENCE.ethereum;
  const solanaHasDropDetect =
    chain === "solana" &&
    (durableNonce !== undefined || lastValidBlockHeight !== undefined);
  let statusCall: string;
  if (chain === "solana" && durableNonce !== undefined) {
    statusCall =
      `get_transaction_status({ chain: "solana", txHash: "${txHash}", durableNonce: ` +
      `{ noncePubkey: "${durableNonce.noncePubkey}", nonceValue: "${durableNonce.nonceValue}" } })`;
  } else if (chain === "solana" && lastValidBlockHeight !== undefined) {
    statusCall = `get_transaction_status({ chain: "solana", txHash: "${txHash}", lastValidBlockHeight: ${lastValidBlockHeight} })`;
  } else {
    statusCall = `get_transaction_status({ chain: "${chain}", txHash: "${txHash}" })`;
  }
  const solanaDroppedBranch = solanaHasDropDetect
    ? [
        `  5. SOLANA SPECIFIC — if status returns "dropped", the tx is`,
        durableNonce !== undefined
          ? `     permanently gone (on-chain nonce rotated past bakedNonce=${durableNonce.nonceValue};`
          : `     permanently gone (current block height is past`,
        durableNonce !== undefined
          ? `     see returned currentNonce for the post-rotation value). Tell the`
          : `     lastValidBlockHeight=${lastValidBlockHeight}). Tell the`,
        `     user the broadcast did not land and offer to re-run the`,
        `     prepare → preview → send flow. Do NOT keep polling — "dropped"`,
        `     is terminal.`,
      ]
    : [];
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `The tx was forwarded to Ledger and broadcast; a txHash is above. Do NOT`,
    `stop and ask the user to type "next" or "check status" — poll inclusion`,
    `yourself and only speak again when you have a real outcome.`,
    ``,
    `Do this, in order:`,
    `  1. Call ${statusCall}`,
    `     every ~${cadence.intervalSec} seconds until status is "success" or "failed"${chain === "solana" ? ' or "dropped"' : ''}, or until`,
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
    ...solanaDroppedBranch,
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
  //
  // The Tronscan line below is an AFTER-BROADCAST heads-up, not a pre-sign
  // defense — explicitly labeled so the user doesn't conflate it with the
  // preventive checks above. Redundant-by-design with the TRANSACTION
  // BROADCAST block emitted from sendTransactionHandler, which carries the
  // same explorer URL via EXPLORER_TX_URL.tron.
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL; confirm the",
    "action + args below match what you intended, else REJECT on Ledger.",
    `  Action:  ${tx.action}`,
    `  Call:    ${v.humanDecode.functionName}`,
    ...formatArgs(v),
    `  from=${tx.from}  txID=${tx.txID}  rawData=${truncateHex(tx.rawDataHex, true)}`,
    "",
    "AFTER BROADCAST (not a pre-sign check):",
    `  Paste txID into [tronscan.org](https://tronscan.org/#/transaction/${tx.txID}) to cross-check on-network.`,
  ].join("\n");
}

/**
 * Bitcoin verification block. The Ledger BTC app clear-signs every
 * output (address + amount) and the fee — so unlike EVM's blind-sign
 * path, the device IS the decoder; there's no calldata-style stream a
 * swiss-knife URL could deconstruct, and PSBTs are too large to embed
 * in a clickable URL anyway. This block surfaces the same projection
 * in chat so the user can cross-check the device screens against
 * trusted text before pressing Approve.
 *
 * The block ends with an explicit instruction to the agent NOT to
 * write multi-file PSBT decode scripts — every byte the device shows
 * is a higher-trust source than any chat-side decode the agent could
 * cobble together, and watching the agent `cp` files into the project
 * tree to find bitcoinjs-lib is a worse UX than the device walk.
 * Issue #215.
 */
export function renderBitcoinVerificationBlock(tx: UnsignedBitcoinTx): string {
  const lines: string[] = [];
  lines.push("VERIFY BEFORE SIGNING (Bitcoin — native send)");
  lines.push(
    "The Ledger Bitcoin app clear-signs every output. Confirm on-device:",
  );
  for (let i = 0; i < tx.decoded.outputs.length; i++) {
    const o = tx.decoded.outputs[i];
    const tag = o.isChange ? "Change" : `Output ${i + 1}`;
    const labelSuffix = o.isChange ? " (your wallet)" : "";
    lines.push(`  • ${tag}: ${o.amountBtc} BTC → ${o.address}${labelSuffix}`);
  }
  lines.push(
    `  • Fee:      ${tx.decoded.feeBtc} BTC (~${tx.decoded.feeRateSatPerVb} sat/vB)`,
  );
  lines.push(
    `  • RBF:      ${tx.decoded.rbfEligible ? "enabled — replaceable" : "disabled — final"}`,
  );
  lines.push(
    `  • From:     ${tx.from}  (BIP-32 account ${tx.accountPath})`,
  );
  lines.push("");
  lines.push(
    "If ANY output address or amount on-device differs from the above → " +
      "REJECT on Ledger and re-prepare.",
  );
  lines.push("");
  lines.push("[AGENT NOTE — do not forward this paragraph to the user]");
  lines.push(
    "Do NOT decode the PSBT in chat. The Ledger device clear-signs every",
  );
  lines.push(
    "output address, amount, fee, and RBF flag on its screen — that walk IS",
  );
  lines.push(
    "the verification, and it is a higher-trust source than any chat-side",
  );
  lines.push(
    "decode you could write. Specifically: do NOT write `node -e` scripts,",
  );
  lines.push(
    "do NOT create `/tmp/*.cjs` or `_psbt-verify.cjs` files, do NOT `cp`",
  );
  lines.push(
    "anything into the project tree to resolve `bitcoinjs-lib`. The bullet",
  );
  lines.push(
    "list above is the MCP's claim; the device screens are the truth; the",
  );
  lines.push(
    "user reconciles the two by eye. If the bullets and device disagree,",
  );
  lines.push(
    "the user rejects on-device — no chat-side decode would have caught it",
  );
  lines.push("any earlier.");
  return lines.join("\n");
}

/**
 * Shape of a prepare_solana_* result — the draft is in the tx-store; this
 * is the user-visible metadata returned to the agent. Parallels UnsignedTx
 * without `messageBase64` / `recentBlockhash` (those get pinned by
 * `preview_solana_send` right before signing).
 */
export interface RenderableSolanaPrepareResult {
  handle: string;
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "jito_stake"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  rentLamports?: number;
  estimatedFeeLamports?: number;
  /** Nonce-account PDA — surfaced for send / close actions (absent for init's own decoded form, but present after init completes). */
  nonceAccount?: string;
}

/**
 * Human label for each Solana action — used in the PREPARED header and as
 * a lookup in a few other places. Keeping this in one spot avoids four
 * copies of the "native_send → 'native SOL transfer'" map scattered
 * through the render code.
 */
function solanaActionLabel(action: RenderableSolanaPrepareResult["action"]): string {
  switch (action) {
    case "native_send":
      return "native SOL transfer";
    case "spl_send":
      return "SPL token transfer";
    case "nonce_init":
      return "durable-nonce init (one-time setup)";
    case "nonce_close":
      return "durable-nonce close (reclaim rent-exempt seed)";
    case "jupiter_swap":
      return "Jupiter swap";
    case "marginfi_init":
      return "MarginFi account init (one-time setup)";
    case "marginfi_supply":
      return "MarginFi supply";
    case "marginfi_withdraw":
      return "MarginFi withdraw";
    case "marginfi_borrow":
      return "MarginFi borrow";
    case "marginfi_repay":
      return "MarginFi repay";
    case "marinade_stake":
      return "Marinade stake (SOL → mSOL)";
    case "marinade_unstake_immediate":
      return "Marinade liquid unstake (mSOL → SOL via pool)";
    case "jito_stake":
      return "Jito stake (SOL → jitoSOL via SPL stake-pool)";
    case "native_stake_delegate":
      return "Native stake delegate (create stake account + delegate to validator)";
    case "native_stake_deactivate":
      return "Native stake deactivate (one-epoch cooldown before withdrawable)";
    case "native_stake_withdraw":
      return "Native stake withdraw (from inactive stake account)";
    case "lifi_solana_swap":
      return "LiFi swap / bridge (Solana source)";
    case "kamino_init_user":
      return "Kamino account init (create LUT + userMetadata + obligation)";
    case "kamino_supply":
      return "Kamino supply";
    case "kamino_borrow":
      return "Kamino borrow";
    case "kamino_withdraw":
      return "Kamino withdraw";
    case "kamino_repay":
      return "Kamino repay";
  }
}

/**
 * User-facing block emitted from `prepare_solana_*`. DELIBERATELY does not
 * contain a Message Hash — the hash is only meaningful once a fresh
 * blockhash is pinned, which happens in `preview_solana_send`. Showing a
 * hash at prepare time would train users to match a stale value.
 */
export function renderSolanaPrepareSummaryBlock(
  r: RenderableSolanaPrepareResult,
): string {
  const actionLabel = solanaActionLabel(r.action);
  const isInit = r.action === "nonce_init";
  const rentNote = isInit
    ? " (one-time rent-exempt seed for the nonce account, reclaimable via prepare_solana_nonce_close)"
    : " (one-time, creates recipient ATA)";
  return [
    `PREPARED (Solana — ${actionLabel}) — review, then confirm to continue`,
    `  ${r.description}`,
    `  From:    ${r.from}`,
    `  Call:    ${r.decoded.functionName}`,
    "  Args:",
    ...Object.entries(r.decoded.args).map(([k, v]) => `    - ${k}: ${v}`),
    ...(r.estimatedFeeLamports !== undefined
      ? [`  Est. fee: ${r.estimatedFeeLamports} lamports`]
      : []),
    ...(r.rentLamports !== undefined
      ? [`  Rent:    ${r.rentLamports} lamports${rentNote}`]
      : []),
    ...(r.nonceAccount && !isInit
      ? [`  Nonce:   ${r.nonceAccount}`]
      : []),
    "",
    "NEXT STEP — NOT YET SIGNABLE",
    "  The Solana message is NOT serialized yet: we intentionally defer the",
    "  blockhash-or-nonce pin so the ~60s on-chain validity window isn't",
    "  burned while the user reviews (durable-nonce txs don't have that",
    "  window, but init does, and the same deferral pattern keeps the flow",
    "  uniform). When the user says 'send', call `preview_solana_send(handle)`",
    "  — that tool pins the nonce value (or a fresh blockhash for init),",
    "  returns the Message Hash, and emits the CHECKS PERFORMED agent-task",
    "  block the agent runs unprompted.",
  ].join("\n");
}

/**
 * Per-call agent-task directive for `prepare_solana_*` results. Tells the
 * agent to produce a short bullet summary and then — once the user says
 * "send" — call `preview_solana_send(handle)` to pin the blockhash. All
 * the integrity checks (CHECK 1 / CHECK 2 / second-LLM) fire from the
 * `preview_solana_send` response, not here; at prepare time there are no
 * final message bytes to decode or hash.
 */
export function renderSolanaPrepareAgentTaskBlock(
  r: RenderableSolanaPrepareResult,
): string {
  const isMarginfi = r.action.startsWith("marginfi_");
  const isMarinade = r.action.startsWith("marinade_");
  const isNativeStake = r.action.startsWith("native_stake_");
  const isLifiSolana = r.action === "lifi_solana_swap";
  const marginfiActionWord =
    r.action === "marginfi_init"
      ? "MarginFi account init"
      : r.action === "marginfi_supply"
        ? "MarginFi supply"
        : r.action === "marginfi_withdraw"
          ? "MarginFi withdraw"
          : r.action === "marginfi_borrow"
            ? "MarginFi borrow"
            : r.action === "marginfi_repay"
              ? "MarginFi repay"
              : null;
  const marinadeActionWord =
    r.action === "marinade_stake"
      ? "Marinade stake"
      : r.action === "marinade_unstake_immediate"
        ? "Marinade liquid unstake"
        : null;
  const nativeStakeActionWord =
    r.action === "native_stake_delegate"
      ? "native stake delegate"
      : r.action === "native_stake_deactivate"
        ? "native stake deactivate"
        : r.action === "native_stake_withdraw"
          ? "native stake withdraw"
          : null;
  const actionWord =
    r.action === "native_send"
      ? "native SOL send"
      : r.action === "spl_send"
        ? "SPL send"
        : r.action === "nonce_init"
          ? "durable-nonce init"
          : r.action === "nonce_close"
            ? "durable-nonce close"
            : r.action === "jupiter_swap"
              ? "Jupiter swap"
              : marginfiActionWord ?? marinadeActionWord ?? nativeStakeActionWord ?? (isLifiSolana ? "LiFi swap / bridge (Solana source)" : "Solana tx");
  const nonceBullet =
    r.nonceAccount && r.action !== "nonce_init"
      ? ["  - Nonce: <short nonce-account addr>"]
      : [];
  const summaryShape =
    r.action === "spl_send"
      ? [
          "  - Headline: \"Prepared SPL send — <amount> <symbol> to <short addr>\"",
          "  - From: <from address>",
          "  - To: <to address>",
          "  - Mint: <mint address> (<symbol if known>)",
          "  - Amount: <human amount + symbol>",
          ...nonceBullet,
          "  - Rent: <rent in SOL if ATA creation, else omit the bullet>",
          "  - Fee: <est. fee in SOL>",
        ]
      : r.action === "native_send"
        ? [
            "  - Headline: \"Prepared native SOL send — <amount> SOL to <short addr>\"",
            "  - From: <from address>",
            "  - To: <to address>",
            "  - Amount: <human SOL amount>",
            ...nonceBullet,
            "  - Fee: <est. fee in SOL>",
          ]
        : r.action === "nonce_init"
          ? [
              "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
              "  - Wallet: <from address>",
              "  - Nonce account: <deterministic PDA from createWithSeed(wallet, 'vaultpilot-nonce-v1')>",
              "  - Rent-exempt seed: <rent in SOL>",
              "  - Fee: <est. fee in SOL>",
              "  - Note: one-time setup; reclaimable via prepare_solana_nonce_close",
            ]
          : r.action === "nonce_close"
            ? [
                "  - Headline: \"Prepared durable-nonce close — returning <balance> SOL to main wallet\"",
                "  - Wallet: <from address>",
                "  - Nonce account: <will be destroyed after this tx>",
                "  - Destination: <from address (returns to the same wallet)>",
                "  - Withdraw amount: <balance in SOL>",
                ...nonceBullet,
                "  - Fee: <est. fee in SOL>",
              ]
            : r.action === "jupiter_swap"
              ? [
                  "  - Headline: \"Prepared Solana swap — <inputAmount> <inputSymbol> → <outputAmount> <outputSymbol> via Jupiter\"",
                  "  - From: <from address>",
                  "  - Input mint: <inputMint from decoded.args> (<inputSymbol if known>)",
                  "  - Output mint: <outputMint from decoded.args> (<outputSymbol if known>)",
                  "  - Expected output: <outputAmount> <outputSymbol> (min <minOutput> @ <slippageBps> bps)",
                  "  - Route: <route labels joined with →, from decoded.args.route>",
                  "  - Price impact: <priceImpactPct>%",
                  ...nonceBullet,
                  "  - Fee: <est. fee in SOL (priority + base)>",
                ]
              : r.action === "marginfi_init"
                ? [
                    "  - Headline: \"Prepared MarginFi account init — <short PDA>\"",
                    "  - Wallet: <from address>",
                    "  - MarginfiAccount PDA: <marginfiAccount from decoded.args>",
                    "  - Account index: <accountIndex from decoded.args, default 0>",
                    ...nonceBullet,
                    "  - Rent: ~0.017 SOL (rent-exempt minimum for the MarginfiAccount PDA; reclaimable when the account is closed)",
                    "  - Fee: <est. fee in SOL>",
                  ]
                : isMarginfi
                  ? [
                      // marginfi_supply / withdraw / borrow / repay — same
                      // shape; the action word differentiates the headline.
                      `  - Headline: \"Prepared ${marginfiActionWord} — <amount> <symbol>\"`,
                      "  - Wallet: <from address>",
                      "  - MarginfiAccount: <marginfiAccount from decoded.args>",
                      "  - Bank: <bank from decoded.args> (<symbol>)",
                      "  - Amount: <human amount + symbol>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "marinade_stake"
                  ? [
                      "  - Headline: \"Prepared Marinade stake — <amountSol> SOL → mSOL\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountSol> SOL (deposit)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "marinade_unstake_immediate"
                  ? [
                      "  - Headline: \"Prepared Marinade liquid unstake — <amountMSol> mSOL → SOL (pool, with fee)\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountMSol> mSOL (burned)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_delegate"
                  ? [
                      "  - Headline: \"Prepared native stake delegate — <amountSol> SOL → validator <short>\"",
                      "  - Wallet: <from address>",
                      "  - Validator: <validator from decoded.args>",
                      "  - Stake amount: <amountSol> SOL",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      "  - Rent-exempt seed: <rentLamports>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_deactivate"
                  ? [
                      "  - Headline: \"Prepared native stake deactivate — <stakeAccount short>\"",
                      "  - Wallet: <from address>",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_withdraw"
                  ? [
                      "  - Headline: \"Prepared native stake withdraw — <amountSol> SOL from <stakeAccount short>\"",
                      "  - Wallet: <from + recipient>",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      "  - Amount: <amountSol> SOL (or 'max')",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : isLifiSolana
                  ? [
                      "  - Headline: \"Prepared LiFi <swap|bridge> — <fromAmount> <inputSymbol> → ~<minOutput> <outputSymbol> on <toChain>\"",
                      "  - From wallet: <from address>",
                      "  - Input: <fromAmount from decoded.args> <inputSymbol> (mint: <fromMint>)",
                      "  - Output: ~<minOutput> <outputSymbol> on <toChain> (token: <toToken>)",
                      "  - Tool / route: <tool from decoded.args>",
                      "  - Slippage: <slippageBps from decoded.args> bps",
                      "  - Destination wallet: <toAddress, or 'same as source' if absent>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : [
                      // Fallback for any newly-added Solana action that
                      // hasn't been wired up here yet — surface a generic
                      // shape rather than reusing the nonce_close template
                      // (which was #97's silent-mismatch bug).
                      `  - Headline: \"Prepared ${actionWord}\"`,
                      "  - From: <from address>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ];
  const closingLine =
    r.action === "nonce_init"
      ? '  "Reply \'send\' to continue — I\'ll pin a fresh blockhash (this init tx is the one exception that uses legacy-blockhash mode), run the mandatory integrity checks, and surface the Ledger Message Hash for you to match on-device."'
      : '  "Reply \'send\' to continue — I\'ll pin the current nonce value, run the mandatory integrity checks, and surface the Ledger Message Hash for you to match on-device."';
  return [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `Produce a COMPACT bullet summary of the prepared ${actionWord}. Required shape:`,
    ...summaryShape,
    "",
    "End with ONE line:",
    closingLine,
    "",
    "Do NOT call `preview_solana_send` or `send_transaction` yet — wait for",
    "the user's 'send'. When they reply, call `preview_solana_send(handle)`",
    "with the handle below; that response carries the CHECKS template and",
    "the Message Hash. Do NOT fabricate a hash here — none exists yet; the",
    "blockhash/nonce gets pinned at preview_solana_send time.",
    "",
    `Handle: ${r.handle}`,
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
  if (tx.action === "spl_send") {
    return renderSolanaSplVerificationBlock(tx);
  }
  // native_send: Ledger clear-signs SystemProgram.Transfer.
  // nonce_init / nonce_close: all-SystemProgram ixs; per source these
  //   clear-sign (memory: project_solana_durable_nonce_viability.md —
  //   "Ledger clear-signs AdvanceNonceAccount, source; not device-tested").
  //   If the device DOES drop to blind-sign for some reason, the pair-
  //   consistency check + INSTRUCTION DECODE still catch tampering; the
  //   user just won't have a hash to match. Add the hash to the render in
  //   a future pass if live testing shows blind-sign behavior.
  return renderSolanaNativeVerificationBlock(tx);
}

function formatSolanaDecodedArgs(tx: UnsignedSolanaTx): string[] {
  return Object.entries(tx.decoded.args).map(
    ([k, v]) => `    - ${k}: ${v}`,
  );
}

function renderSolanaNativeVerificationBlock(tx: UnsignedSolanaTx): string {
  const headerLabel =
    tx.action === "native_send"
      ? "native SOL transfer"
      : tx.action === "nonce_init"
        ? "durable-nonce init (one-time setup)"
        : tx.action === "nonce_close"
          ? "durable-nonce close (reclaim seed)"
          : "Solana tx"; // spl_send routes through the other branch
  const explainerLine =
    tx.action === "native_send"
      ? "The Ledger Solana app clear-signs SystemProgram.Transfer. The on-device"
      : "The Ledger Solana app clear-signs SystemProgram instructions. The on-device";
  const hashLabel = tx.nonce ? "Nonce value" : "Blockhash";
  return [
    `VERIFY BEFORE SIGNING (Solana — ${headerLabel})`,
    explainerLine,
    "screens will show the amount and recipient — confirm they match the",
    "decoded call below, else REJECT on the device.",
    "",
    `  Call:    ${tx.decoded.functionName}`,
    "  Args:",
    ...formatSolanaDecodedArgs(tx),
    `  From:    ${tx.from}`,
    ...(tx.nonce
      ? [`  Nonce account: ${tx.nonce.account}`]
      : []),
    `  ${hashLabel}: ${tx.recentBlockhash}`,
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
 * `renderPreviewVerifyAgentTaskBlock` shape: two mandatory integrity checks
 * (instruction-decode, and — for blind-sign SPL — pair-consistency on the
 * Ledger Message Hash) plus an optional user-prompted second-LLM check.
 *
 * Solana has no `preview_send` step (the message bytes + blockhash are
 * already pinned at prepare time), so all checks run in the prepare agent-
 * task block rather than a later preview block. Native SOL sends drop the
 * pair-consistency check — SystemProgram.Transfer clear-signs on-device so
 * the user already sees decoded fields; no hash-match path fires.
 */
export function renderSolanaAgentTaskBlock(tx: UnsignedSolanaTx): string {
  const isSpl = tx.action === "spl_send";
  const isNativeSend = tx.action === "native_send";
  const isNonceInit = tx.action === "nonce_init";
  const isNonceClose = tx.action === "nonce_close";
  const isJupiterSwap = tx.action === "jupiter_swap";
  const isMarginfi =
    tx.action === "marginfi_init" ||
    tx.action === "marginfi_supply" ||
    tx.action === "marginfi_withdraw" ||
    tx.action === "marginfi_borrow" ||
    tx.action === "marginfi_repay";
  const isMarinade =
    tx.action === "marinade_stake" ||
    tx.action === "marinade_unstake_immediate";
  const isNativeStake =
    tx.action === "native_stake_delegate" ||
    tx.action === "native_stake_deactivate" ||
    tx.action === "native_stake_withdraw";
  const isLifiSolana = tx.action === "lifi_solana_swap";
  const isKamino =
    tx.action === "kamino_init_user" ||
    tx.action === "kamino_supply" ||
    tx.action === "kamino_borrow" ||
    tx.action === "kamino_withdraw" ||
    tx.action === "kamino_repay";
  const marginfiActionLabel =
    tx.action === "marginfi_init"
      ? "account init"
      : tx.action === "marginfi_supply"
        ? "supply"
        : tx.action === "marginfi_withdraw"
          ? "withdraw"
          : tx.action === "marginfi_borrow"
            ? "borrow"
            : tx.action === "marginfi_repay"
              ? "repay"
              : null;

  // SPECIAL CASE — nonce_init is the one Solana action where ALL the
  // standard checks are pure ceremony. Why:
  //   - It's a one-time, deterministic, two-instruction tx
  //     (createAccountWithSeed + nonceInitialize).
  //   - The Ledger Solana app clear-signs both ixs on-device — the user
  //     sees the new account address, seed, authority, and rent values.
  //   - Those on-device fields ARE the integrity gate. CHECK 1 (browser-
  //     verify decode) and CHECK 2 (pair-consistency hash) add nothing
  //     a clear-sign user can't already verify with their eyes.
  //   - The cost of running the standard verification block is real:
  //     ~30s of agent prep time on a tx with a ~60s legacy blockhash
  //     window (nonce_init can't use durable-nonce protection since
  //     it's the tx CREATING the nonce). Three live attempts blew that
  //     window before this short-circuit was added.
  // For every OTHER Solana action (native_send / spl_send / nonce_close)
  // the standard CHECKS PERFORMED block + Explorer URL still applies.
  if (isNonceInit) {
    return [
      "[AGENT TASK — RUN THIS NOW, DO NOT ASK THE USER]",
      "",
      "Produce a COMPACT bullet summary of the prepared durable-nonce init.",
      "Required shape:",
      "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
      "  - Wallet: <from address>",
      "  - Nonce account: <nonce-account PDA>",
      "  - Authority: <from address (same as wallet)>",
      "  - Rent-exempt seed: <rent in SOL (~0.00144 SOL)>",
      "  - Fee: <fee in SOL>",
      "",
      "Then — do NOT emit a CHECKS PERFORMED block, do NOT surface a Solana",
      "Explorer Inspector link, do NOT compute a Message Hash. nonce_init is",
      "a deterministic two-ix System Program tx and the Ledger Solana app",
      "CLEAR-SIGNS both instructions on-device. The on-device fields are the",
      "integrity gate; an extra browser-verify step adds nothing a clear-sign",
      "user can't already see, and the legacy ~60s blockhash window makes",
      "the extra ceremony actively harmful (live regression: three failed",
      "attempts before this short-circuit was added).",
      "",
      "Lead with this on-device instruction so the user knows what to",
      "expect when they press the button on Ledger:",
      "",
      "  Ledger CLEAR-SIGN — your device will display the two System",
      "  Program instructions in plain text:",
      "    1. CreateAccountWithSeed: confirm `New Account` matches the",
      "       Nonce account bullet above, `Base` matches your Wallet,",
      "       `Seed` is exactly \"vaultpilot-nonce-v1\", and `Lamports`",
      "       matches the Rent-exempt seed bullet.",
      "    2. NonceInitialize: confirm `Nonce Authority` equals your",
      "       Wallet (so YOU stay in control of the nonce).",
      "  Any field that doesn't match → REJECT on-device.",
      "",
      "End with ONE line, no menu, no second-LLM offer:",
      "  Reply 'send' to broadcast — approve on-device when the Solana app",
      "  prompts. The legacy ~60s blockhash window starts now.",
      "",
      "SEND-CALL CONTRACT — when the user replies \"send\", call",
      "`send_transaction` with: handle: <from prepare result>, confirmed: true.",
    ].join("\n");
  }

  // Send-type txs (native_send / spl_send / nonce_close) all carry
  // ix[0] = SystemProgram.nonceAdvance for durable-nonce protection.
  // Every send-type tx (any action except nonce_init) carries nonceAdvance
  // as ix[0] — this flag drives the "DURABLE-NONCE MODE" explainer text +
  // the Nonce bullet in the summary + the expected-shape text for CHECK 1.
  const hasAdvanceNonceIx =
    isNativeSend || isSpl || isNonceClose || isJupiterSwap || isMarginfi || isMarinade || isNativeStake || isLifiSolana || isKamino;
  // The Ledger Solana app only clear-signs a small allowlist of programs
  // (System Program's transfer/advance/initialize/withdraw, and a few
  // others). Everything else falls to blind-sign, which shows only the
  // Message Hash on-device and requires the user to match it against the
  // hash the server displayed. SPL TransferChecked AND Jupiter swaps both
  // fall in that bucket.
  const isBlindSign = isSpl || isJupiterSwap || isMarginfi || isMarinade || isNativeStake || isLifiSolana || isKamino;
  const ledgerHash = isBlindSign ? solanaLedgerMessageHash(tx.messageBase64) : null;

  const checksPayload = {
    instructionDecode: {
      autoRun: true,
      threat: "MCP-side Solana message tampering",
      keywords: ["Solana", "tampering"],
    },
    ...(isBlindSign
      ? {
          pairConsistencyLedgerHash: {
            autoRun: true,
            threat: "MCP signing different bytes than it displayed",
            keywords: ["displayed"],
          },
        }
      : {}),
    secondLlm: {
      autoRun: false,
      threat: "coordinated agent compromise",
      keywords: ["coordinated", "agent"],
    },
  };

  const nonceBullet = hasAdvanceNonceIx
    ? "  - Nonce: <short nonce-account addr>"
    : null;
  const summaryShape = isSpl
    ? [
        "  - Headline: \"Prepared SPL send — <amount> <symbol> to <short addr>\"",
        "  - From: <from address>",
        "  - To: <to address>",
        "  - Mint: <mint address> (<symbol if known>)",
        "  - Amount: <human amount + symbol>",
        ...(nonceBullet ? [nonceBullet] : []),
        "  - Rent: <rent in SOL if ATA creation, else omit the bullet>",
        "  - Fee: <fee in SOL>",
      ]
    : isNativeSend
      ? [
          "  - Headline: \"Prepared native SOL send — <amount> SOL to <short addr>\"",
          "  - From: <from address>",
          "  - To: <to address>",
          "  - Amount: <human SOL amount>",
          ...(nonceBullet ? [nonceBullet] : []),
          "  - Fee: <fee in SOL>",
        ]
      : isNonceInit
        ? [
            "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
            "  - Wallet: <from address>",
            "  - Nonce account: <nonce-account PDA>",
            "  - Authority: <from address (same as wallet)>",
            "  - Rent-exempt seed: <rent in SOL (~0.00144 SOL)>",
            "  - Fee: <fee in SOL>",
          ]
        : isNonceClose
          ? [
              "  - Headline: \"Prepared durable-nonce close — returning <balance> SOL to <wallet short>\"",
              "  - Wallet: <from address>",
              "  - Nonce account: <nonce-account PDA, will be destroyed>",
              "  - Destination: <from address (returns to main wallet)>",
              "  - Withdraw amount: <balance in SOL>",
              ...(nonceBullet ? [nonceBullet] : []),
              "  - Fee: <fee in SOL>",
            ]
          : isJupiterSwap
            ? [
                "  - Headline: \"Prepared Solana swap — <inputAmount> <inputSymbol> → <outputAmount> <outputSymbol> via Jupiter\"",
                "  - From: <from address>",
                "  - Input mint: <inputMint> (<inputSymbol if known>)",
                "  - Output mint: <outputMint> (<outputSymbol if known>)",
                "  - Expected output: <outputAmount> <outputSymbol> (min <minOutput> @ <slippageBps> bps)",
                "  - Route: <route labels joined with →, from decoded.args.route>",
                "  - Price impact: <priceImpactPct>%",
                ...(nonceBullet ? [nonceBullet] : []),
                "  - Fee: <fee in SOL (priority + base)>",
              ]
            : tx.action === "marginfi_init"
              ? [
                  "  - Headline: \"Prepared MarginFi account init — <short PDA>\"",
                  "  - Wallet: <from address>",
                  "  - MarginfiAccount PDA: <marginfiAccount from decoded.args>",
                  "  - Account index: <accountIndex from decoded.args, default 0>",
                  ...(nonceBullet ? [nonceBullet] : []),
                  "  - Fee: <est. fee in SOL>",
                  "  - Note: one-time deterministic PDA — no rent-exempt seed moved",
                ]
              : tx.action === "marinade_stake"
                ? [
                    "  - Headline: \"Prepared Marinade stake — <amountSol> SOL → mSOL\"",
                    "  - Wallet: <from address>",
                    "  - Amount: <amountSol> SOL (deposit)",
                    "  - mSOL ATA: <mSolAta from decoded.args (created on first stake if missing)>",
                    ...(nonceBullet ? [nonceBullet] : []),
                    "  - Fee: <est. fee in SOL>",
                  ]
                : tx.action === "marinade_unstake_immediate"
                  ? [
                      "  - Headline: \"Prepared Marinade liquid unstake — <amountMSol> mSOL → SOL (via pool, with fee)\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountMSol> mSOL (burned)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      "  - Note: routes via Marinade's liquidity pool — small fee, immediate (NOT delayed-unstake / OrderUnstake — that flow needs an ephemeral signer and isn't shipped here)",
                      ...(nonceBullet ? [nonceBullet] : []),
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : tx.action === "native_stake_delegate"
                    ? [
                        "  - Headline: \"Prepared native stake delegate — <amountSol> SOL → validator <short>\"",
                        "  - Wallet: <from address>",
                        "  - Validator: <validator vote pubkey from decoded.args>",
                        "  - Stake amount: <amountSol> SOL (active principal)",
                        "  - Stake account: <stakeAccount from decoded.args (deterministic per (wallet, validator))>",
                        "  - Rent-exempt seed: <rentLamports from decoded.args> lamports (~0.00228 SOL — reclaimable on full withdraw)",
                        ...(nonceBullet ? [nonceBullet] : []),
                        "  - Fee: <est. fee in SOL>",
                        "  - Note: stake activates next epoch (~2-3 days); use prepare_native_stake_deactivate then prepare_native_stake_withdraw to exit",
                      ]
                    : tx.action === "native_stake_deactivate"
                      ? [
                          "  - Headline: \"Prepared native stake deactivate — <stakeAccount short>\"",
                          "  - Wallet: <from address>",
                          "  - Stake account: <stakeAccount from decoded.args>",
                          ...(nonceBullet ? [nonceBullet] : []),
                          "  - Fee: <est. fee in SOL>",
                          "  - Note: deactivation takes one epoch (~2-3 days). After it lands, prepare_native_stake_withdraw can fully drain.",
                        ]
                      : tx.action === "native_stake_withdraw"
                        ? [
                            "  - Headline: \"Prepared native stake withdraw — <amountSol> SOL from <stakeAccount short>\"",
                            "  - Wallet: <from + recipient (same address)>",
                            "  - Stake account: <stakeAccount from decoded.args>",
                            "  - Amount: <amountSol> SOL (or 'max' = full balance, closes the account)",
                            ...(nonceBullet ? [nonceBullet] : []),
                            "  - Fee: <est. fee in SOL>",
                            "  - Note: stake account must already be inactive (1 epoch after deactivate); on-chain reverts otherwise",
                          ]
                        : tx.action === "lifi_solana_swap"
                          ? [
                              "  - Headline: \"Prepared LiFi <swap|bridge> — <fromAmount> <inputSymbol> → ~<minOutput> <outputSymbol>\"",
                              "  - From wallet: <from address>",
                              "  - Input: <fromAmount> <inputSymbol> (mint: <fromMint from decoded.args>)",
                              "  - Output: ~<minOutput> <outputSymbol> on <toChain> (token: <toToken from decoded.args>)",
                              "  - Tool / route: <tool from decoded.args>",
                              "  - Slippage: <slippageBps from decoded.args> bps",
                              "  - Destination wallet: <toAddress from decoded.args, or 'same as source' if omitted>",
                              ...(nonceBullet ? [nonceBullet] : []),
                              "  - Fee: <est. fee in SOL>",
                              "  - Note: cross-chain bridges complete in 2 stages — Solana source tx confirms first; destination delivery happens after via the bridge protocol (typically 1-15 min depending on tool).",
                            ]
                          : tx.action === "kamino_init_user"
                            ? [
                                "  - Headline: \"Prepared Kamino account init — userMetadata + obligation\"",
                                "  - Wallet: <from address>",
                                "  - Market: <market from decoded.args>",
                                "  - UserMetadata PDA: <userMetadata from decoded.args>",
                                "  - User lookup table: <userLookupTable from decoded.args>",
                                "  - Obligation PDA: <obligation from decoded.args>",
                                ...(nonceBullet ? [nonceBullet] : []),
                                "  - Fee: <est. fee in SOL>",
                                "  - Note: one-time setup; after this lands, prepare_kamino_supply / borrow / withdraw / repay all work without re-initing.",
                              ]
                            : tx.action === "kamino_supply"
                              ? [
                                  "  - Headline: \"Prepared Kamino supply — <amount> <symbol>\"",
                                  "  - Wallet: <from address>",
                                  "  - Reserve: <reserve from decoded.args>",
                                  "  - Mint: <mint from decoded.args> (<symbol>)",
                                  "  - Amount: <amount> <symbol>",
                                  "  - Obligation: <obligation from decoded.args>",
                                  ...(nonceBullet ? [nonceBullet] : []),
                                  "  - Fee: <est. fee in SOL>",
                                ]
                              : [
                      // marginfi_supply / withdraw / borrow / repay — same shape,
                      // only the "Action" bullet text differs; keep one template.
                      `  - Headline: \"Prepared MarginFi ${marginfiActionLabel} — <amount> <symbol>\"`,
                      "  - Wallet: <from address>",
                      "  - MarginfiAccount: <marginfiAccount from decoded.args>",
                      "  - Bank: <bank from decoded.args> (<symbol>)",
                      "  - Amount: <human amount + symbol>",
                      ...(nonceBullet ? [nonceBullet] : []),
                      "  - Fee: <est. fee in SOL>",
                    ];

  const inspectorUrl = solanaInspectorUrl(tx.messageBase64);

  // CHECK 2 only fires for blind-sign actions (Ledger shows just the
  // Message Hash, no decoded fields). For clear-sign actions (native_send,
  // nonce_init, nonce_close) the on-device decoded fields ARE the
  // integrity gate and a server-side hash recompute adds nothing — same
  // policy EVM uses for clear-sign txs (native sends, ERC20
  // transfers/approvals).
  // CHECK 2 (pair-consistency hash recompute) fires when the device would
  // blind-sign — without the hash, the on-device screen has nothing but a
  // hash to match against, so we need to bind the displayed bytes to the
  // displayed hash. Clear-sign actions (native_send, nonce_close) skip CHECK
  // 2 because the on-device decoded fields ARE the integrity gate.
  const needsPairConsistency = isBlindSign;
  // Combined CHECK 1 + CHECK 2 script — single Bash invocation, single
  // approval prompt, two verdicts. Mirrors EVM CHECK 2's template shape
  // (multi-line `node -e "..."` with `<messageBase64 from the prepare_*
  // result>` as a JS string-literal placeholder the agent splices in).
  //
  // What the script computes:
  //   - ledgerHash = base58(sha256(msg)) — same value the Ledger Solana
  //     app derives and shows on blind-sign. PublicKey(<32-byte buffer>)
  //     .toBase58() does base58 encoding (works for raw sha256 digests).
  //   - instructions[] = per-ix { programId, accounts, dataHex } extracted
  //     via @solana/web3.js. The script auto-detects message version:
  //       - legacy (no 0x80 prefix): `Message.from(buf)` — instruction data
  //         is base58, decoded via the inline bs58→hex helper below (bs58 v6
  //         is ESM-only so `require('bs58')` fails; the decoder is one line).
  //       - v0 (0x80 prefix): `VersionedMessage.deserialize(buf)` — fetches
  //         Address Lookup Table accounts via an RPC Connection, flattens
  //         static + ALT-resolved account keys, then reads `compiledInstructions`
  //         (data is already a Uint8Array, no base58 decode needed).
  //     The v0 branch requires network access (to fetch ALTs); the script
  //     reads the RPC URL from `SOLANA_RPC_URL` env var with a fallback to
  //     the public mainnet-beta endpoint.
  //
  // The agent inspects the JSON output and reports BOTH verdicts:
  //   - CHECK 1 ✓/✗ on instruction structure (programId + accounts +
  //     dataHex tag) matching the bullet summary
  //   - CHECK 2 ✓/✗ on ledgerHash matching the displayed value
  const combinedCheckScript = [
    `    node -e "const {Message, VersionedMessage, PublicKey, Connection} = require('@solana/web3.js');`,
    `    const {createHash} = require('crypto');`,
    `    const m = '<messageBase64 from the preview_solana_send result>';`,
    `    const buf = Buffer.from(m, 'base64');`,
    `    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';`,
    `    const b58 = s => { if (!s.length) return ''; let n=0n; for (const c of s) n=n*58n+BigInt(A.indexOf(c)); let z=0; while (z<s.length&&s[z]==='1') z++; const h=n.toString(16); return '00'.repeat(z)+(h.length%2?'0'+h:h); };`,
    `    const ledgerHash = new PublicKey(createHash('sha256').update(buf).digest()).toBase58();`,
    `    (async () => {`,
    `      let instructions;`,
    `      if (buf[0] & 0x80) {`,
    `        const msg = VersionedMessage.deserialize(buf);`,
    `        const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');`,
    `        const alts = [];`,
    `        for (const lookup of msg.addressTableLookups) {`,
    `          const res = await conn.getAddressLookupTable(lookup.accountKey);`,
    `          if (!res.value) throw new Error('ALT not found on chain: ' + lookup.accountKey.toBase58());`,
    `          alts.push(res.value);`,
    `        }`,
    `        const keys = msg.getAccountKeys({addressLookupTableAccounts: alts}).keySegments().flat();`,
    `        instructions = msg.compiledInstructions.map(ix => ({`,
    `          programId: keys[ix.programIdIndex].toBase58(),`,
    `          accounts: ix.accountKeyIndexes.map(i => keys[i].toBase58()),`,
    `          dataHex: Buffer.from(ix.data).toString('hex'),`,
    `        }));`,
    `      } else {`,
    `        const msg = Message.from(buf);`,
    `        instructions = msg.instructions.map(ix => ({`,
    `          programId: msg.accountKeys[ix.programIdIndex].toBase58(),`,
    `          accounts: ix.accounts.map(i => msg.accountKeys[i].toBase58()),`,
    `          dataHex: b58(ix.data),`,
    `        }));`,
    `      }`,
    `      console.log(JSON.stringify({ledgerHash, instructions}, null, 2));`,
    `    })();"`,
  ];

  // v1.6 Phase 2: compressed full-path template. Input-side prose reduced
  // (threat-model rationale lives in SECURITY.md; historical context lives
  // in git log/code comments; meta-formatting hints removed). Output-side
  // CHECKS PERFORMED template reduced to structured terse lines; on-device
  // hash still rendered on its own bare line. Security content (integrity
  // checks themselves, fail-loud rule, second-LLM escape hatch, on-device
  // match) retained verbatim.
  const onDeviceLine = isBlindSign
    ? `• BLIND-SIGN — Message Hash on-device MUST equal: ${ledgerHash}  (Allow blind signing must be ON in Solana app Settings; any difference → REJECT)`
    : isNonceClose
      ? "• CLEAR-SIGN — Solana app shows nonceAdvance + nonceWithdraw; confirm destination = your wallet, lamports = full balance. Any difference → REJECT."
      : "• CLEAR-SIGN — Solana app shows amount + recipient on-device. Confirm fields match your summary. Any difference → REJECT.";
  const pairConsistencyLine = needsPairConsistency
    ? `  {✓|✗} PAIR-CONSISTENCY LEDGER HASH — <verdict>  (protects against MCP signing different bytes than displayed)`
    : null;
  const nonceNote = hasAdvanceNonceIx
    ? "This tx is durable-nonce-protected (ix[0] = nonceAdvance); no ~60s blockhash expiry."
    : null;

  const lines = [
    "[AGENT TASK — RUN THESE CHECKS NOW, DO NOT ASK THE USER]",
    needsPairConsistency
      ? "Run BOTH integrity checks UNPROMPTED; no yes/no menu."
      : "Run the INSTRUCTION-DECODE check UNPROMPTED; no yes/no menu.",
    ...(nonceNote ? [nonceNote] : []),
    "",
    "Step 1 — emit a COMPACT bullet summary of the prepared tx:",
    ...summaryShape,
    "",
    "Step 2 — run the combined check script (splice messageBase64 in place of the placeholder):",
    "",
    ...combinedCheckScript,
    "",
    "Step 3 — verify from the script's JSON output:",
    "  CHECK 1 (INSTRUCTION DECODE): every `programId` in `instructions[]` is one you",
    "    recognize for this action; `dataHex` first-byte tags match expected ops",
    "    (System 0x04=AdvanceNonce, 0x02=Transfer; SPL Token 0x0c=TransferChecked;",
    "    ComputeBudget, ATA, Switchboard, MarginFi programs self-identify); every",
    "    `accounts[]` entry appears in your bullet summary. Verdict ✓ MATCH /",
    "    ✗ MISMATCH / ⚠ DECODE PARTIAL (unrecognized programId — direct user to",
    `    the Explorer fallback link below).`,
    ...(needsPairConsistency
      ? [
          `  CHECK 2 (PAIR-CONSISTENCY LEDGER HASH): script's \`ledgerHash\` = ${ledgerHash}. Verdict ✓ MATCH / ✗ MISMATCH.`,
        ]
      : []),
    "",
    "Step 4 — emit this block to the user (keep the structure, fill in the {✓|✗|⚠} verdicts):",
    "",
    "  CHECKS PERFORMED",
    "  {✓|✗|⚠} INSTRUCTION DECODE — <verdict>  (protects against MCP-side Solana tampering)",
    ...(pairConsistencyLine ? [pairConsistencyLine] : []),
    "  □ SECOND-LLM CHECK — optional (reply 2)  (protects against coordinated agent compromise)",
    "",
    "  NEXT ON-DEVICE:",
    `  ${onDeviceLine}`,
    ...(isBlindSign
      ? [
          "",
          `  (Render the Message Hash ${ledgerHash} bare on its own line somewhere in your reply — blank line above and below, no backticks/bold — so the user can visually match it against the device screen without the CHECKS PERFORMED preformatted region leaking ** or \` as literal characters. On-⚠ DECODE PARTIAL: add line \`Browser-side decode fallback: [Open in Solana Explorer Inspector](${inspectorUrl})\` verbatim.)`,
        ]
      : [
          ...(isBlindSign
            ? []
            : [
                "",
                "  (On-⚠ DECODE PARTIAL only: add line `Browser-side decode fallback:" +
                  ` [Open in Solana Explorer Inspector](${inspectorUrl})\` verbatim.)`,
              ]),
        ]),
    "",
    "  End with: `Want an independent second-LLM check? Reply (2). Otherwise reply 'send'.`",
    "",
    "If any mandatory check ✗, LEAD your reply with `✗ <CHECK NAME> FAILED — DO NOT SIGN.` BEFORE the block.",
    "",
    "SECOND-LLM CHECK on (2): call `get_verification_artifact({handle})`, relay its",
    "`pasteableBlock` field VERBATIM (no commentary between the START/END markers, no",
    "pre-decoding). Remind the user to paste into a different-provider LLM and compare",
    isBlindSign
      ? "its description to their intent AND match the paste-block's hash to the Ledger screen."
      : "its description to their intent AND confirm on-device decoded fields match.",
    "",
    "SEND on 'send': call `send_transaction({handle, confirmed:true})`.",
  ];
  return lines.join("\n");
}

/**
 * Agent-task block emitted when the user has NOT installed the
 * `vaultpilot-preflight` Claude Code skill (see
 * https://github.com/<OWNER>/vaultpilot-skill). The skill is the only
 * MCP-independent source of truth for agent-side integrity checks — its
 * content lives under `~/.claude/skills/` on the user's disk, outside
 * this server's reach. Without it, a compromised MCP could silently
 * suppress its own CHECKS PERFORMED directives and the agent would have
 * no static rule to fall back on.
 *
 * This block is prefixed to every `prepare_*` / `preview_*` tool response
 * when the skill marker file is missing. It is a UX nudge, not a security
 * boundary: an actually-compromised MCP would of course suppress its own
 * warning too. The point is to catch the honest-MCP case where the user
 * simply hasn't completed the install step, so they don't silently run
 * with a weaker agent.
 *
 * `skillRepoUrl` is the GitHub URL the user clones from; passed in so the
 * call site owns the single source of truth (index.ts).
 */
export function renderMissingSkillWarning(opts: {
  skillRepoUrl: string;
}): string {
  // NOTE ON FRAMING — this block was originally prefixed with an
  // "[AGENT TASK — RELAY TO USER FIRST, BEFORE ANY OTHER BLOCK]" header
  // and a direct `git clone <url>` command. Live testing showed agents
  // flagging that shape as prompt injection (because it is — structurally
  // indistinguishable from an attacker-authored block demanding the user
  // run an external script). Defense-in-depth agents correctly ignored it.
  //
  // The current shape mirrors the other vaultpilot-mcp informational
  // blocks (VERIFY BEFORE SIGNING, PREPARE RECEIPT, TRANSACTION BROADCAST)
  // the agent already trusts: a named notice with status/purpose/install
  // sections, no imperative verbs directed at the agent, and no pasted
  // shell commands. The server-level `instructions` field documents this
  // notice pattern explicitly at initialize time so the agent has prior
  // knowledge it is legitimate server output.
  return [
    "VAULTPILOT NOTICE — Preflight skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-preflight/SKILL.md not found.",
    "Purpose: the preflight skill adds MCP-independent integrity checks",
    "         to every signing flow (local bytes-decode + on-device hash",
    "         recompute). It lives on the user's disk outside this",
    "         server's reach, so its invariants stay enforced even if",
    "         this MCP is compromised or silently drops its own CHECKS",
    "         PERFORMED directives.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; restart Claude Code after.)",
    "",
    "This notice is emitted by vaultpilot-mcp while the skill file is",
    "absent. It is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this pattern. Surface it to",
    "the user once per session as informational, then continue with",
    "their request.",
  ].join("\n");
}

/**
 * Companion to `renderMissingSkillWarning` — emitted when the
 * `vaultpilot-setup` skill is missing, so an agent fielding a setup-flow
 * question still has explicit guidance even when the wizard's auto-install
 * step (`src/setup/install-skills.ts`) failed earlier (no `git`, no
 * network, user declined). Same shape as the preflight notice — named
 * `VAULTPILOT NOTICE`, no imperative agent verbs, no pasted shell — so the
 * agent treats it as legitimate server output rather than prompt injection.
 *
 * Triggered narrowly (only on `get_vaultpilot_config_status` responses)
 * rather than every tool call: that tool is the canonical first call the
 * setup skill makes, so the notice fires exactly when the agent is in a
 * setup-flow context. This avoids stacking two unrelated install notices
 * on every response when both skills happen to be missing.
 */
export function renderMissingSetupSkillWarning(opts: {
  skillRepoUrl: string;
}): string {
  return [
    "VAULTPILOT NOTICE — Setup skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-setup/SKILL.md not found.",
    "Purpose: the setup skill drives the conversational `/setup` flow —",
    "         classifying the user's use case, collecting only the API",
    "         keys that case actually needs, validating each pasted key",
    "         via a read-only tool call, and ending with a working",
    "         example. Without it the agent has to improvise the flow",
    "         from this server's tool surface alone.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; the setup wizard's",
    "         auto-install step would normally clone it, but that path",
    "         can fail when git is missing, the network is down, or",
    "         the user declined. Restart Claude Code after cloning.)",
    "",
    "This notice is server-generated, not prompt injection. Surface it",
    "to the user once per session as informational, then continue with",
    "their setup question — referencing the install instructions if the",
    "user wants the guided flow.",
  ].join("\n");
}

export type { SupportedChain };
