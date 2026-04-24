/**
 * Tests for issue #37 — pin nonce + EIP-1559 fees at send time, compute the
 * pre-sign RLP hash, forward pinned fields through WalletConnect, and surface
 * the hash via `renderLedgerHashBlock`. The pin closes the on-device
 * calldata-integrity gap in blind-sign mode; before this change Ledger Live
 * picked nonce + fees at send time so the RLP hash was unpredictable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keccak256, serializeTransaction } from "viem";

describe("eip1559PreSignHash", () => {
  it("matches viem's independent serialize+keccak of the same tuple", async () => {
    const { eip1559PreSignHash } = await import("../src/signing/verification.js");
    const tuple = {
      chainId: 1,
      nonce: 42,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
      gas: 21_000n,
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
      value: 500_000_000_000_000_000n,
      data: "0x" as `0x${string}`,
    };
    // Golden reference: re-serialize + re-hash via viem directly. If our
    // helper drifts (different field order, extra access list, wrong type
    // tag), this equality fails.
    const golden = keccak256(
      serializeTransaction({
        type: "eip1559",
        chainId: tuple.chainId,
        nonce: tuple.nonce,
        maxFeePerGas: tuple.maxFeePerGas,
        maxPriorityFeePerGas: tuple.maxPriorityFeePerGas,
        gas: tuple.gas,
        to: tuple.to,
        value: tuple.value,
        data: tuple.data,
      }),
    );
    expect(eip1559PreSignHash(tuple)).toBe(golden);
  });

  it("changes when any pinned field changes (nonce flip)", async () => {
    const { eip1559PreSignHash } = await import("../src/signing/verification.js");
    const base = {
      chainId: 1,
      nonce: 42,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
      gas: 21_000n,
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
      value: 0n,
      data: "0x" as `0x${string}`,
    };
    const h1 = eip1559PreSignHash(base);
    const h2 = eip1559PreSignHash({ ...base, nonce: 43 });
    // This is the point of pinning — the hash is a lossless fingerprint of
    // the full tuple. If Ledger Live silently overrides the nonce we gave
    // it, the on-device hash shifts and the user rejects.
    expect(h1).not.toBe(h2);
  });
});

describe("renderPrepareReceiptBlock", () => {
  it("labels itself for verbatim relay and lists the agent-supplied args", async () => {
    const { renderPrepareReceiptBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPrepareReceiptBlock({
      tool: "prepare_native_send",
      args: {
        wallet: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
        chain: "ethereum",
        to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        amount: "0.5",
      },
    });
    // Verbatim-relay label is how we ask the agent not to collapse this; if
    // this string drifts, the per-call directive is lost and a narrowly-
    // compromised agent can tamper invisibly.
    expect(block).toMatch(/PREPARE RECEIPT — RELAY VERBATIM TO USER/);
    expect(block).toContain("Tool: prepare_native_send");
    // Each arg appears as its own line so the user can spot a single-field
    // mutation (e.g. a swapped `to`).
    expect(block).toMatch(/wallet: 0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361/);
    expect(block).toMatch(/to: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/);
    expect(block).toMatch(/amount: 0\.5/);
    // Honest framing — this is a narrow-injection defense, not a hard
    // trust boundary. Keep the "retelling vs. actual" contrast explicit.
    expect(block).toMatch(/retelling/);
  });

  it("renders nested objects as JSON so complex args (e.g. Tron votes) stay inspectable", async () => {
    const { renderPrepareReceiptBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPrepareReceiptBlock({
      tool: "prepare_tron_vote",
      args: {
        from: "TXYZ",
        votes: [{ srAddress: "TABC", count: 1000 }],
      },
    });
    expect(block).toContain(
      'votes: [{"srAddress":"TABC","count":1000}]',
    );
  });
});

describe("renderPreviewVerifyAgentTaskBlock", () => {
  it("is an agent-task block (not user-facing) that describes independent hash recomputation", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 7,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      valueWei: "500000000000000000",
    });
    // Agent directive, framed as auto-run (not a menu) — the redesign
    // flipped "offer both options" to "run both, report in CHECKS PERFORMED".
    expect(block).toMatch(/AGENT TASK — RUN THESE CHECKS NOW/);
    expect(block).toMatch(/DO NOT ASK THE USER/);
    // Pair-consistency framing — the narrower attack shape (pinned tuple
    // vs. hash of different bytes) is the reason this check exists.
    expect(block).toMatch(/pair-consistency/i);
    expect(block).toMatch(/on-device hash match/i);
    // The per-call values are spliced into the viem command so the agent
    // doesn't have to reconstruct them — keeps the mandatory check cheap.
    expect(block).toContain("nonce:7");
    expect(block).toContain("maxFeePerGas:22000000000n");
    expect(block).toContain("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    // CHECKS PERFORMED template + the ChecksPayload JSON (structured
    // threat taxonomy) must be present — the agent renders its user-facing
    // block from these.
    expect(block).toMatch(/CHECKS PERFORMED/);
    expect(block).toMatch(/CHECKS PAYLOAD/);
    expect(block).toContain('"abiDecode"');
    expect(block).toContain('"pairConsistencyHash"');
    expect(block).toContain('"secondLlm"');
    expect(block).toContain('"autoRun": true');
    expect(block).toContain('"autoRun": false');
    expect(block).toContain('"calldata tampering"');
    expect(block).toContain('"WalletConnect"');
    expect(block).toContain('"coordinated"');
    // Second-LLM check — the one remaining opt-in, promoted to a single
    // one-line prompt instead of a menu item. The tool name must appear
    // verbatim so the agent knows it's not narrative advice.
    expect(block).toMatch(/Want an independent second-LLM check\? Reply \(2\)/);
    expect(block).toContain("get_verification_artifact");
    expect(block).toMatch(/second-agent verification/);
    expect(block).toMatch(/coordinated .*(agent|MCP).*compromise/i);
    // Must tell the agent NOT to pre-decode in the same reply — the
    // whole point of the check is that the second agent decodes with
    // no shared context from this one.
    expect(block).toMatch(/Do\s*NOT pre-decode/);
    // NEXT ON-DEVICE block: the CHECKS PERFORMED render shape must tell the
    // user how the Ledger screen check differs between blind-sign and clear-
    // sign. Without it, users hit clear-sign (Aave/Lido/1inch/LiFi/approve)
    // and think "there's no hash, did the check fail?" — the honest answer
    // is the hash-match check doesn't apply; verify decoded fields instead.
    expect(block).toMatch(/NEXT ON-DEVICE/);
    expect(block).toMatch(/BLIND-SIGN mode/);
    expect(block).toMatch(/CLEAR-SIGN mode/);
    expect(block).toMatch(/hash matching does NOT apply/i);
    expect(block).toMatch(/decoded fields/);
    // User-friendly wording for the hash-match step — the old "match it
    // against <hash>" phrasing read like a developer instruction. The
    // post-#116-UX phrasing puts the hash on its own indented line, so
    // the directive reads "The hash on-device MUST equal:" followed by
    // the hash on the next line.
    expect(block).toMatch(/hash on-device MUST equal/i);
    expect(block).not.toMatch(/match it against/);
    // The blind-sign hash must be wrapped in BOTH bold AND single-backtick
    // inline code so Markdown clients render it with maximum visual
    // emphasis. Backticks alone rendered too muted in Claude Code terminal
    // output during a live run; users missed the hash under device-screen
    // time pressure, so the directive was upgraded to require both markers.
    expect(block).toMatch(/\*\*`0xabc`\*\*/);
    // The agent must be told to preserve both emphasis markers — without
    // this guard, paraphrasers strip them and the hash loses its visual
    // distinction (same live-run bug class as the URL-narration issue).
    expect(block).toMatch(/bold AND single-backtick/i);
    // No menu for the two mandatory checks — the old (1)/(2) shape is gone.
    expect(block).not.toMatch(/EXTRA CHECKS YOU CAN RUN/);
    expect(block).not.toMatch(/\(1\)\s*<plain-English pair-consistency/);
  });

  it("tells the agent it MAY cite the prepare-time [CROSS-CHECK SUMMARY] as a selector→name anchor when model weights miss the selector", async () => {
    // Live-session regression: on a LiFi swap the agent hit
    // selector 0x2c57e884 (swapTokensMultipleV3ERC20ToNative), which is
    // outside its model-weight ABI coverage, and reported ⚠ DECODE
    // UNAVAILABLE — despite the prepare-time 4byte cross-check already
    // having resolved the selector name byte-for-byte. The block above
    // was telling the agent "use only your built-in ABI knowledge" and
    // neglecting to mention 4byte as a legitimate third data source.
    // Fix: explicitly surface the upgrade path (model-weights-miss +
    // 4byte-hit + static-head-match → ✓ ABI DECODE) and the narrow
    // fallback (both model-weights AND 4byte empty → ⚠ DECODE UNAVAILABLE).
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 1,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "200000",
      },
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      valueWei: "0",
      decoderUrl: "https://calldata.swiss-knife.xyz/decoder?calldata=0x2c57e884",
    });
    // Explicit permission to cite the prepare-time cross-check.
    expect(block).toMatch(/CROSS-CHECK SUMMARY/);
    expect(block).toMatch(/4byte\.directory/);
    expect(block).toMatch(/selector[-→]?name anchor/i);
    // The upgrade path must be stated plainly — otherwise the agent
    // stays conservative and the fix doesn't land.
    expect(block).toMatch(/(upgrade|report.*✓ ABI DECODE)/i);
    // And the narrow fallback (both weights AND 4byte empty) is still
    // the only trigger for ⚠ DECODE UNAVAILABLE. The assertion below
    // uses [\s\S] rather than `.` because the template wraps lines and
    // JS regex dot doesn't span \n by default.
    expect(block).toMatch(
      /only mark ⚠ DECODE UNAVAILABLE when BOTH[\s\S]*?4byte[\s\S]*?empty/i,
    );
    expect(block).toContain("`no-signature`");
    // The compromised-server caveat is acknowledged (skill stays strict;
    // this block speaks to the honest-server path). This keeps the
    // layered-defense story consistent with SECURITY.md.
    expect(block).toMatch(/compromised[- ]server/i);
    expect(block).toMatch(/vaultpilot-preflight/);
    // Swiss-knife fallback still rendered — removing it would break the
    // ⚠ DECODE UNAVAILABLE path entirely. Regression guard.
    expect(block).toContain("[Open in swiss-knife decoder]");
  });

  it("splices the swiss-knife decoder URL into the ⚠ DECODE UNAVAILABLE branch of the render template", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const decoderUrl =
      "https://calldata.swiss-knife.xyz/decoder?calldata=0x736eac0b00&address=0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE&chainId=1";
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 7,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      valueWei: "0",
      decoderUrl,
    });
    // The URL must appear INSIDE the render-shape template so the agent's
    // paraphrase of the template retains it — regression: when instructed
    // to "include the URL from the earlier prepare block", agents narrated
    // "see the prepare block above" instead of rendering the URL, forcing
    // the user to scroll up.
    expect(block).toContain(decoderUrl);
    expect(block).toMatch(/Browser-side decode fallback:/);
    // Instruction must forbid the "see the earlier block" paraphrase.
    expect(block).toMatch(/Do NOT paraphrase the URL away/);
    // Render the URL as a Markdown hyperlink — raw swiss-knife URLs are
    // multi-KB of hex calldata and wrap the chat into unreadable walls.
    // `[Open in swiss-knife decoder](<url>)` keeps it a neat single line.
    expect(block).toContain(`[Open in swiss-knife decoder](${decoderUrl})`);
    expect(block).toMatch(/Markdown hyperlink/);
    // Live-run regression: the agent stripped both the `…` backticks around
    // the hash AND the [label](url) syntax around the swiss-knife link,
    // rendering "Open in swiss-knife decoder" as plain text with no URL and
    // the hash as plain prose. Root cause was notation ambiguity: the
    // template used square-bracket placeholders like `[✓|✗|⚠]` for
    // "pick-one" verdict markers, and the agent generalized "brackets are
    // placeholder notation → strip them" to the Markdown link brackets too.
    // Fix: switch placeholders to curly braces `{✓|✗|⚠}` so square brackets
    // only appear in literal Markdown link syntax, and add an explicit
    // NOTATION section that distinguishes the two.
    expect(block).toMatch(/NOTATION/);
    expect(block).toMatch(/\{✓\|✗\|⚠\}/);
    expect(block).not.toMatch(/\[✓\|✗\|⚠\]/);
    // The NOTATION section must explicitly call out `[label](url)` and
    // backtick-wrapped hashes as literal Markdown, not placeholders.
    expect(block).toMatch(/\[label\]\(url\)/);
    expect(block).toMatch(/rendering directives, NOT placeholders/i);
  });

  it("when no decoder URL is available (oversized calldata), tells the agent to say so honestly", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 7,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      valueWei: "0",
      // no decoderUrl — e.g. calldata too large to preload into swiss-knife URL
    });
    expect(block).not.toMatch(/Browser-side decode fallback:/);
    expect(block).toMatch(/browser fallback is unavailable/i);
    // Second-LLM is the remaining gap-closer in this case.
    expect(block).toMatch(/second-LLM/);
  });

  // Clear-sign-only txs (native send, ERC-20 transfer, ERC-20 approve): the
  // PAIR-CONSISTENCY HASH line and the BLIND-SIGN branch of NEXT ON-DEVICE
  // were noise under device-screen time pressure (user complaint 2026-04-24
  // — "add about native eth transfers and erc20 transfers"). For these tx
  // types the reduced template drops both sections and expands CLEAR-SIGN
  // to name the tx type explicitly.
  it("clearSignOnly: true → drops PAIR-CONSISTENCY HASH + BLIND-SIGN branch", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 7,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      valueWei: "500000000000000000",
      clearSignOnly: true,
    });
    // PAIR-CONSISTENCY HASH verdict line (the user-facing render-template
    // line the agent copies into its CHECKS PERFORMED block) must be gone.
    // The opening explanation may still *mention* pair-consistency by name
    // (explaining why the check was skipped) — that's agent-facing prose,
    // not part of the template the user sees.
    expect(block).not.toMatch(/\{✓\|⏸\} PAIR-CONSISTENCY HASH/);
    // Matching "(protects against MCP lying about the bytes sent to
    // WalletConnect)" — the threat-clause under the PAIR-CONSISTENCY line —
    // must also be gone, since that line attaches to the removed verdict.
    expect(block).not.toMatch(/bytes sent to WalletConnect/);
    // And the full CHECK 2 section (running the viem recompute) should not
    // be in the agent-task body either, since the check is skipped.
    expect(block).not.toMatch(/CHECK 2 — PAIR-CONSISTENCY HASH/);
    // CHECKS PAYLOAD JSON must not include the pairConsistencyHash key.
    expect(block).not.toContain('"pairConsistencyHash"');
    // NEXT ON-DEVICE must still exist (without it, users don't know to
    // check the Ledger screen at all) but the BLIND-SIGN branch is gone.
    expect(block).toMatch(/NEXT ON-DEVICE/);
    expect(block).not.toMatch(/BLIND-SIGN mode/);
    // The expanded CLEAR-SIGN branch names the tx types this flag covers.
    expect(block).toMatch(/native ETH send, ERC-20 transfer, or[\s\S]*ERC-20 approve/);
    // The ABI DECODE check still runs — it's the one integrity check we keep.
    expect(block).toMatch(/CHECK 1 — AGENT-SIDE ABI DECODE/);
    expect(block).toContain('"abiDecode"');
    // SECOND-LLM stays available; it's the user's explicit opt-in path.
    expect(block).toMatch(/SECOND-LLM CHECK/);
  });

  it("clearSignOnly defaults to false → full template (regression: swaps / DeFi path unchanged)", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderPreviewVerifyAgentTaskBlock({
      chain: "ethereum",
      preSignHash: "0xabc",
      pinned: {
        nonce: 7,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      valueWei: "0",
      // clearSignOnly omitted — full template
    });
    expect(block).toMatch(/PAIR-CONSISTENCY HASH/);
    expect(block).toMatch(/BLIND-SIGN mode/);
    expect(block).toContain('"pairConsistencyHash"');
  });
});

describe("isClearSignOnlyTx selector detection", () => {
  it("returns true for empty data (native send)", async () => {
    const { isClearSignOnlyTx } = await import(
      "../src/signing/render-verification.js"
    );
    expect(isClearSignOnlyTx({ data: "0x" as `0x${string}` })).toBe(true);
  });

  it("returns true for ERC-20 transfer(address,uint256) = 0xa9059cbb", async () => {
    const { isClearSignOnlyTx } = await import(
      "../src/signing/render-verification.js"
    );
    // transfer(0xrecipient..., 1 USDC) calldata prefix
    const data = "0xa9059cbb000000000000000000000000c0f5b7f7703ba95dc7c09d4ef50a830622234075000000000000000000000000000000000000000000000000000000000000000a" as `0x${string}`;
    expect(isClearSignOnlyTx({ data })).toBe(true);
  });

  it("returns true for ERC-20 approve(address,uint256) = 0x095ea7b3", async () => {
    const { isClearSignOnlyTx } = await import(
      "../src/signing/render-verification.js"
    );
    const data = "0x095ea7b3000000000000000000000000c0f5b7f7703ba95dc7c09d4ef50a830622234075000000000000000000000000000000000000000000000000000000000000000a" as `0x${string}`;
    expect(isClearSignOnlyTx({ data })).toBe(true);
  });

  it("returns false for a LiFi swap selector (protects the swaps path)", async () => {
    const { isClearSignOnlyTx } = await import(
      "../src/signing/render-verification.js"
    );
    // swapAndStartBridgeTokensViaAcrossV4 — from a live capture
    const data = "0x1794958f0000000000000000000000000000000000000000000000000000000000000060" as `0x${string}`;
    expect(isClearSignOnlyTx({ data })).toBe(false);
  });

  it("returns false for an unknown 4-byte selector", async () => {
    const { isClearSignOnlyTx } = await import(
      "../src/signing/render-verification.js"
    );
    const data = "0xdeadbeef" as `0x${string}`;
    expect(isClearSignOnlyTx({ data })).toBe(false);
  });
});

describe("renderLedgerHashBlock", () => {
  it("includes the hash, the on-device match instruction, and the Edit-gas warning", async () => {
    const { renderLedgerHashBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderLedgerHashBlock({
      preSignHash:
        "0xdeadbeefcafef00dbabe0123456789abcdef0123456789abcdef0123456789ab",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      valueWei: "500000000000000000",
    });
    // Marked for verbatim relay — the orchestrator must not collapse this
    // into its bullet summary.
    expect(block).toMatch(/LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER/);
    expect(block).toContain(
      "0xdeadbeefcafef00dbabe0123456789abcdef0123456789abcdef0123456789ab",
    );
    // Blind-sign vs clear-sign branches both honestly addressed.
    expect(block).toMatch(/BLIND-SIGNS/);
    expect(block).toMatch(/CLEAR-SIGNS/);
    // Edit-gas paragraph is load-bearing; without it the user would see a
    // hash mismatch after tapping Edit gas and wrongly suspect a compromised
    // MCP. The paragraph gives the user a choice (accept divergence without
    // the hash-match guarantee, or reject and re-preview) — not a flat "you
    // must reject".
    expect(block).toMatch(/Edit gas/i);
    expect(block).toMatch(/Reject on the device if they differ/);
    expect(block).toMatch(/hash-match guarantee no longer applies/);
    // Eyeball values in scope.
    expect(block).toContain("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(block).toContain("500000000000000000");
  });
});

describe("previewSendHandler — LEDGER BLIND-SIGN HASH gating", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // Live-test regression: on a 0.1 ETH self-send the user saw a
  // `LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER` block even though
  // the Ledger Ethereum app clear-signs native sends and displays no hash
  // on-device. Showing a blind-sign hash for clear-sign txs trains the
  // user to hunt for a match that doesn't exist — worse than useless; it
  // dilutes the signal value of the hash block in real blind-sign flows.
  // previewSendHandler must suppress the block when result.clearSignOnly
  // is true.
  it("does NOT emit the LEDGER BLIND-SIGN HASH block when result.clearSignOnly is true", async () => {
    const { previewSendHandler } = await import("../src/index.js");
    const fakePreview = async () => ({
      handle: "h",
      chain: "ethereum" as const,
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
      valueWei: "500000000000000000",
      preSignHash:
        "0xdeadbeefcafef00dbabe0123456789abcdef0123456789abcdef0123456789ab" as `0x${string}`,
      pinned: {
        nonce: 1,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "21000",
      },
      previewToken: "tok",
      clearSignOnly: true,
    });
    const out = await previewSendHandler(fakePreview)({ handle: "h" });
    // The agent-task block still fires (it handles the clearSignOnly
    // branch internally — tested above), so content is non-empty. What
    // matters: NONE of the text blocks carry the LEDGER BLIND-SIGN HASH
    // verbatim-relay label.
    const texts = out.content.map((c) => c.text);
    for (const t of texts) {
      expect(t).not.toMatch(/LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER/);
    }
  });

  it("DOES emit the LEDGER BLIND-SIGN HASH block when clearSignOnly is absent (regression: swaps / DeFi path unchanged)", async () => {
    const { previewSendHandler } = await import("../src/index.js");
    const fakePreview = async () => ({
      handle: "h",
      chain: "ethereum" as const,
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
      valueWei: "0",
      preSignHash:
        "0xdeadbeefcafef00dbabe0123456789abcdef0123456789abcdef0123456789ab" as `0x${string}`,
      pinned: {
        nonce: 1,
        maxFeePerGas: "22000000000",
        maxPriorityFeePerGas: "2000000000",
        gas: "100000",
      },
      previewToken: "tok",
      // clearSignOnly omitted — generic contract call (swap, supply, …)
    });
    const out = await previewSendHandler(fakePreview)({ handle: "h" });
    const texts = out.content.map((c) => c.text);
    const hashBlockCount = texts.filter((t) =>
      /LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER/.test(t),
    ).length;
    expect(hashBlockCount).toBe(1);
  });
});

describe("preview_send surfaces pin + hash; send_transaction consumes them", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("preview_send throws if priority-fee RPC fails (no silent fallback to unpinned)", async () => {
    const requestSendMock = vi.fn().mockResolvedValue("0xabc");
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: requestSendMock,
      getConnectedAccounts: async () => [
        "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      ],
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        call: vi.fn().mockResolvedValue({ data: "0x" }),
        getTransactionCount: vi.fn().mockResolvedValue(1),
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
        estimateMaxPriorityFeePerGas: vi
          .fn()
          .mockRejectedValue(new Error("fee history RPC down")),
        estimateGas: vi.fn().mockResolvedValue(21_000n),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/signing/pre-sign-check.js", () => ({
      assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
    }));

    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles({
      chain: "ethereum",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      data: "0x",
      value: "1",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      description: "test",
    });
    const { previewSend } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(previewSend({ handle: stamped.handle! })).rejects.toThrow(
      /fee history RPC down/,
    );
    // Critically: no WalletConnect request is made — we'd rather fail loudly
    // than submit with Ledger-Live-picked fees and lose the hash-match check.
    expect(requestSendMock).not.toHaveBeenCalled();
  });
});
