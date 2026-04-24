import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * broadcastSolanaTx tests. Keeps the RPC path fake so we can exercise the
 * error-reframing branches without burning live network calls.
 */

const sendRawTransactionMock = vi.fn();
const connectionStub = { sendRawTransaction: sendRawTransactionMock };

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  sendRawTransactionMock.mockReset();
});

describe("broadcastSolanaTx", () => {
  it("returns the signature on success", async () => {
    sendRawTransactionMock.mockResolvedValue("sig123");
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    const sig = await broadcastSolanaTx(Buffer.alloc(0));
    expect(sig).toBe("sig123");
  });

  it("wraps generic errors with a 'Solana broadcast failed' prefix + logs", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message: "Transaction simulation failed",
      logs: [
        "Program Foo invoke [1]",
        "Program Foo failed: custom program error: 0x1",
      ],
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Solana broadcast failed: Transaction simulation failed/,
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Program Foo failed: custom program error: 0x1/,
    );
  });

  /**
   * Issue #120 — Switchboard `NotEnoughSamples` (Anchor 6030 / 0x178e)
   * means the oracle samples embedded in the tx aged past their
   * `max_staleness` during Ledger blind-sign review. The raw RPC error
   * is useless to end-users; reframe it as "re-prepare" guidance.
   */
  it("reframes Switchboard NotEnoughSamples (0x178e) as a re-prepare-needed message", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message: "Transaction simulation failed",
      logs: [
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv invoke [1]",
        "Program log: AnchorError thrown in programs/sb_on_demand/src/impls/pull_feed_impl.rs:328. Error Code: NotEnoughSamples. Error Number: 6030.",
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv failed: custom program error: 0x178e",
      ],
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Switchboard oracle samples aged out during Ledger review/,
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /prepare_marginfi_\* again/,
    );
    // Still includes the raw logs for debuggability.
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /0x178e/,
    );
  });

  it("reframes even when 0x178e appears only in the outer message (no logs array)", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message:
        "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x178e",
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Switchboard oracle samples aged out/,
    );
  });

  it("does NOT reframe other Switchboard errors (only NotEnoughSamples is timing-specific)", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message: "Transaction simulation failed",
      logs: [
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv invoke [1]",
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv failed: custom program error: 0x12",
      ],
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Solana broadcast failed/,
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.not.toThrow(
      /Switchboard oracle samples aged out/,
    );
  });
});
