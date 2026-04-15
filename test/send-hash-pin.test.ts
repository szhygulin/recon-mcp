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
    // Edit-gas warning is load-bearing; without it the user would see a hash
    // mismatch after tapping Edit gas and wrongly suspect a compromised MCP.
    expect(block).toMatch(/Edit gas/i);
    expect(block).toMatch(/Reject on the device/);
    // Eyeball values in scope.
    expect(block).toContain("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(block).toContain("500000000000000000");
  });
});

describe("send_transaction surfaces pin + hash through the handler", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("throws if send-time fee estimation fails (no silent fallback to unpinned)", async () => {
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
        estimateFeesPerGas: vi
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
    const { sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      sendTransaction({ handle: stamped.handle!, confirmed: true }),
    ).rejects.toThrow(/fee history RPC down/);
    // Critically: no WalletConnect request is made — we'd rather fail loudly
    // than submit with Ledger-Live-picked fees and lose the hash-match check.
    expect(requestSendMock).not.toHaveBeenCalled();
  });
});
