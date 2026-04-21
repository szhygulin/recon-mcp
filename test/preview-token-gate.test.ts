/**
 * Tests for the preview-token gate on send_transaction.
 *
 * Background: preview_send's agent-task block tells the agent to surface an
 * EXTRA CHECKS menu to the user before calling send_transaction. In live
 * testing, agents collapse preview_send + send_transaction into a single
 * silent step, skipping that gate. The server cannot force a UI pause, but
 * it CAN require send_transaction to carry back two values the agent can
 * only hold honestly if preview_send ran AND the menu was shown:
 *
 *   - `previewToken`: a UUID minted by preview_send; stashed on the pin;
 *     required to match at send time.
 *   - `userDecision`: literal "send"; schema-enforced affirmation that the
 *     user picked "send" from the menu.
 *
 * These tests cover the gate, its refusal cases, and the TRON bypass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const EVM_PRE_SIGN_MOCK = {
  getConnectedAccounts: async () => ["0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361"],
};

function mockEvmRpc(opts: { nonce?: number } = {}) {
  vi.doMock("../src/signing/walletconnect.js", () => ({
    requestSendTransaction: vi.fn().mockResolvedValue("0xabc123"),
    getConnectedAccounts: EVM_PRE_SIGN_MOCK.getConnectedAccounts,
  }));
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => ({
      call: vi.fn().mockResolvedValue({ data: "0x" }),
      getTransactionCount: vi.fn().mockResolvedValue(opts.nonce ?? 7),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
      estimateGas: vi.fn().mockResolvedValue(21_000n),
    }),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: () => {},
  }));
  vi.doMock("../src/signing/pre-sign-check.js", () => ({
    assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
  }));
}

function makeEvmTx() {
  return {
    chain: "ethereum" as const,
    to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
    data: "0x" as `0x${string}`,
    value: "1",
    from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361" as `0x${string}`,
    description: "preview-gate test",
  };
}

describe("send_transaction preview-token gate (EVM)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("preview_send returns a UUID-shaped previewToken; happy path forwards the tx", async () => {
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const preview = await previewSend({ handle: stamped.handle! });
    // Basic shape — UUID v4 form. The specific format isn't load-bearing, but
    // if this drifts silently (e.g. empty string) the gate becomes vacuous.
    expect(preview.previewToken).toMatch(/^[0-9a-f-]{36}$/);

    const result = await sendTransaction({
      handle: stamped.handle!,
      confirmed: true,
      previewToken: preview.previewToken,
      userDecision: "send",
    });
    expect(result.txHash).toBe("0xabc123");
  });

  it("refuses when previewToken is missing — names the arg and points at preview_send", async () => {
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    await previewSend({ handle: stamped.handle! });

    // Error must name the missing arg AND what preview_send returned; the
    // agent reads this and should self-correct without a roundtrip.
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        userDecision: "send",
      }),
    ).rejects.toThrow(/Missing `previewToken`/);
  });

  it("refuses when userDecision is missing — names the gate it enforces", async () => {
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const preview = await previewSend({ handle: stamped.handle! });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/userDecision.*send/);
  });

  it("refuses when previewToken is wrong — names refresh:true as the typical cause", async () => {
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    await previewSend({ handle: stamped.handle! });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "not-the-real-token",
        userDecision: "send",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("refresh:true mints a new token and invalidates the old one", async () => {
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const first = await previewSend({ handle: stamped.handle! });
    const second = await previewSend({ handle: stamped.handle!, refresh: true });
    // The refreshed pin gets a FRESH token so an old token (captured before
    // the user was shown a new hash) cannot be replayed as "I already showed
    // them the menu for this hash."
    expect(second.previewToken).not.toBe(first.previewToken);

    // Old token → refused.
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: first.previewToken,
        userDecision: "send",
      }),
    ).rejects.toThrow(/does not match/);

    // New token → accepted.
    const result = await sendTransaction({
      handle: stamped.handle!,
      confirmed: true,
      previewToken: second.previewToken,
      userDecision: "send",
    });
    expect(result.txHash).toBe("0xabc123");
  });

  it("Missing-pin error still fires before the gate when preview_send was skipped entirely", async () => {
    // A user who calls send_transaction without any preview_send first gets
    // the existing 'Missing pinned gas' message — more actionable than a
    // preview-token error when the whole preview step was skipped.
    mockEvmRpc();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeEvmTx());
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "anything",
        userDecision: "send",
      }),
    ).rejects.toThrow(/Missing pinned gas/);
  });
});

describe("send_transaction preview-token gate (TRON bypass)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("TRON handles do not require previewToken or userDecision (gate is EVM-only)", async () => {
    // TRON has no preview_send step — the gate would be meaningless there.
    // Verify the EVM-branch refusals don't fire for TRON by calling
    // sendTransaction with ONLY { handle, confirmed } and asserting the
    // error we hit is TRON-specific (e.g. no paired TRON address), not our
    // preview-token error.
    vi.doMock("../src/signing/tron-usb-signer.js", () => ({
      getTronLedgerAddress: vi.fn().mockRejectedValue(new Error("no tron app")),
      signTronTxOnLedger: vi.fn(),
      setPairedTronAddress: vi.fn(),
      getPairedTronByAddress: () => undefined,
      tronPathForAccountIndex: () => "m/44'/195'/0'/0/0",
    }));
    const { issueTronHandle } = await import(
      "../src/signing/tron-tx-store.js"
    );
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trx_send",
      from: "TXYZ111111111111111111111111111111",
      txID: "a".repeat(64),
      rawData: {},
      rawDataHex: "0a02b63922080102030405060708",
      description: "send 1 TRX",
      decoded: { functionName: "TransferContract", args: { to: "TXYZ", amount: "1 TRX" } },
    });
    const { sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    // We intentionally omit previewToken + userDecision. On EVM this would
    // throw "Missing `previewToken`" — on TRON the call must bypass the gate
    // and proceed into the USB signing path (which we then see fail for an
    // unrelated reason, confirming we got past the gate).
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
      }),
    ).rejects.not.toThrow(/previewToken|userDecision/);
  });
});
