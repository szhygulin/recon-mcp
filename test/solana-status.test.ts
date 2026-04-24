import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the Solana get_transaction_status "dropped" detection. The
 * RPC's `getSignatureStatuses` returns null both for "not yet propagated"
 * and "silently dropped" txs. Two distinguishing paths:
 *
 *   (1) Legacy-blockhash txs (nonce_init only): caller supplies
 *       `lastValidBlockHeight`; status tool compares against getBlockHeight.
 *   (2) Durable-nonce txs (every other send): caller supplies `durableNonce`;
 *       status tool reads the on-chain nonce account and reports `dropped`
 *       if the nonce rotated past the baked value or the account was closed.
 *       Authoritative per Agave's own validity check.
 */

const connectionStub = {
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(),
};

const getNonceAccountValueMock = vi.fn();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

vi.mock("../src/modules/solana/nonce.js", () => ({
  getNonceAccountValue: getNonceAccountValueMock,
}));

beforeEach(() => {
  connectionStub.getSignatureStatuses.mockReset();
  connectionStub.getBlockHeight.mockReset();
  getNonceAccountValueMock.mockReset();
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

describe("getSolanaTransactionStatus — durable-nonce drop detection", () => {
  const NONCE_ACCOUNT = "11111111111111111111111111111111";
  const BAKED_NONCE = "3pohVnAmNzrhJfH5pbPJMJuAw8NzfWMSsDn3snPUBmRp";
  const ROTATED_NONCE = "5GZ4Gx1hAPf2vWGZyK6ZnfKGqN7hPs5R7oG6JrPNjSCG";

  it("reports 'pending' when status is null AND on-chain nonce still matches baked value (tx may still land)", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });
    getNonceAccountValueMock.mockResolvedValue({
      nonce: BAKED_NONCE,
      authority: { toBase58: () => "auth" },
    });

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      durableNonce: { noncePubkey: NONCE_ACCOUNT, nonceValue: BAKED_NONCE },
    });
    expect(status.status).toBe("pending");
    // Block-height check must NOT fire when durableNonce is supplied —
    // the nonce state is authoritative.
    expect(connectionStub.getBlockHeight).not.toHaveBeenCalled();
    expect(getNonceAccountValueMock).toHaveBeenCalledOnce();
  });

  it("reports 'dropped' with diagnostic fields when on-chain nonce has rotated past the baked value", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });
    getNonceAccountValueMock.mockResolvedValue({
      nonce: ROTATED_NONCE,
      authority: { toBase58: () => "auth" },
    });

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      durableNonce: { noncePubkey: NONCE_ACCOUNT, nonceValue: BAKED_NONCE },
    });
    expect(status.status).toBe("dropped");
    expect(status.nonceAccount).toBe(NONCE_ACCOUNT);
    expect(status.bakedNonce).toBe(BAKED_NONCE);
    expect(status.currentNonce).toBe(ROTATED_NONCE);
  });

  it("reports 'dropped' with currentNonce='closed' when the nonce account was destroyed", async () => {
    connectionStub.getSignatureStatuses.mockResolvedValue({ value: [null] });
    // getNonceAccountValue returns null when the account doesn't exist.
    getNonceAccountValueMock.mockResolvedValue(null);

    const { getSolanaTransactionStatus } = await import(
      "../src/modules/solana/status.js"
    );
    const status = await getSolanaTransactionStatus({
      signature: "sig123",
      durableNonce: { noncePubkey: NONCE_ACCOUNT, nonceValue: BAKED_NONCE },
    });
    expect(status.status).toBe("dropped");
    expect(status.currentNonce).toBe("closed");
  });

  it("short-circuits nonce check when tx is already visible (success short-circuit)", async () => {
    // The tx landed between poll intervals — status is no longer null.
    // Nonce check must NOT fire because we already have authoritative info.
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
      durableNonce: { noncePubkey: NONCE_ACCOUNT, nonceValue: BAKED_NONCE },
    });
    expect(status.status).toBe("success");
    expect(getNonceAccountValueMock).not.toHaveBeenCalled();
  });
});
