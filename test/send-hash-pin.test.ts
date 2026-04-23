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
    // against <hash>" phrasing read like a developer instruction.
    expect(block).toMatch(/hash shown on-device is exactly/i);
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
