import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the Solana get_transaction_status "dropped" detection. The
 * RPC's `getSignatureStatuses` returns null both for "not yet propagated"
 * and "silently dropped" txs; without the blockhash expiry cross-check,
 * dropped txs report as "pending" forever. The caller supplies
 * `lastValidBlockHeight` (captured at preview-pin time, surfaced by
 * send_transaction), and the status tool compares against `getBlockHeight`
 * to distinguish the two cases.
 */

const connectionStub = {
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  connectionStub.getSignatureStatuses.mockReset();
  connectionStub.getBlockHeight.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSolanaTransactionStatus — dropped detection", () => {
  it("reports 'pending' when status is null and no lastValidBlockHeight is supplied", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({ signature: "sig123" });
    expect(status.status).toBe("pending");
    // Without lastValidBlockHeight, we can't check blockhash expiry.
    expect(connectionStub.getBlockHeight).not.toHaveBeenCalled();
  });

  it("reports 'pending' when current block height is within the validity window", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connectionStub.getBlockHeight.mockResolvedValue(999);

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      lastValidBlockHeight: 1000,
    });
    expect(status.status).toBe("pending");
  });

  it("reports 'dropped' when current block height is past lastValidBlockHeight and tx is not visible", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connectionStub.getBlockHeight.mockResolvedValue(1050);

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      lastValidBlockHeight: 1000,
    });
    expect(status.status).toBe("dropped");
    expect(status.lastValidBlockHeight).toBe(1000);
    expect(status.currentBlockHeight).toBe(1050);
  });

  it("still reports 'success' when the tx DID land, even if the blockhash later expired", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          slot: 500,
          confirmationStatus: "confirmed",
          err: null,
        },
      ],
    });

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      lastValidBlockHeight: 1000,
    });
    expect(status.status).toBe("success");
    expect(status.slot).toBe(500);
    // No block-height check needed — the tx is visible.
    expect(connectionStub.getBlockHeight).not.toHaveBeenCalled();
  });

  it("reports 'failed' with the error when the tx landed but reverted", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          slot: 600,
          confirmationStatus: "finalized",
          err: { InstructionError: [0, "InsufficientFunds"] },
        },
      ],
    });

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      lastValidBlockHeight: 1000,
    });
    expect(status.status).toBe("failed");
    expect(status.error).toContain("InsufficientFunds");
  });
});
