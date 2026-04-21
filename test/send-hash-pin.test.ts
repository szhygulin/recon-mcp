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
    // Must be an agent directive, not a verbatim-relay block — we don't want
    // this command surface text dumped into the user's chat.
    expect(block).toMatch(/AGENT TASK — DO NOT FORWARD/);
    // Pair-consistency framing (was previously labeled "hash recompute" —
    // that framing overlapped with option (b) at prepare time). The
    // narrower attack shape is what makes the check worth running.
    expect(block).toMatch(/pair-consistency/);
    expect(block).toMatch(/on-device (hash )?match/);
    // The per-call values are spliced into the viem command so the agent
    // doesn't have to reconstruct them — keeps the optional check cheap.
    expect(block).toContain("nonce:7");
    expect(block).toContain("maxFeePerGas:22000000000n");
    expect(block).toContain("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    // Acknowledges (b) from prepare time so the user doesn't see pair-
    // consistency as a restatement — the new wording lets them skip the
    // decode prerequisite if they already ran it.
    expect(block).toMatch(/already ran (option )?\(b\)/);
    // "Offer, don't run" is load-bearing UX — the check is heavy and
    // irrelevant for trusting users.
    expect(block).toMatch(/Do NOT run either unprompted/);
    // Second-agent verification option — names the tool explicitly so
    // the agent knows it's not just narrative advice. This is the only
    // check that survives a fully-coordinated compromise where this
    // agent AND the MCP are lying together.
    expect(block).toContain("second-agent verification");
    expect(block).toContain("get_verification_artifact");
    expect(block).toMatch(/second[,-]? (independent |different )?(LLM|AI)/);
    // Must tell the agent NOT to pre-decode in the same reply — the
    // whole point of the check is that the second agent decodes with
    // no shared context from this one.
    expect(block).toMatch(/Do\s*NOT pre-decode/);
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
