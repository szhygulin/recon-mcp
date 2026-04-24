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

  /**
   * Issue #125 — a NotEnoughSamples caused by an active feed rotation
   * (logs contain "Rotating mega slot") must produce the "wait, don't
   * retry" message, not the aged-out "re-prepare" message. The two
   * failure modes carry the same Anchor error code (6030) but require
   * opposite user actions.
   */
  it("reframes NotEnoughSamples WITH 'Rotating mega slot' as a wait-don't-retry message", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message: "Transaction simulation failed",
      logs: [
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv invoke [1]",
        "Program log: Instruction: PullFeedSubmitResponseConsensus",
        "Program log: Rotating mega slot",
        "Program log: AnchorError thrown in programs/sb_on_demand/src/impls/pull_feed_impl.rs:328. Error Code: NotEnoughSamples. Error Number: 6030.",
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv failed: custom program error: 0x178e",
      ],
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /ROTATING oracles/,
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /Wait at least 60s/,
    );
    // Must NOT suggest re-prepare — that's the wrong action for rotation.
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.not.toThrow(
      /aged out during Ledger review/,
    );
  });

  it("keeps the aged-out framing for NotEnoughSamples WITHOUT rotation marker", async () => {
    sendRawTransactionMock.mockRejectedValue({
      message: "Transaction simulation failed",
      logs: [
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv invoke [1]",
        "Program log: AnchorError thrown in ...:328. Error Code: NotEnoughSamples. Error Number: 6030.",
        "Program SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv failed: custom program error: 0x178e",
      ],
    });
    const { broadcastSolanaTx } = await import(
      "../src/modules/solana/broadcast.js"
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.toThrow(
      /aged out during Ledger review/,
    );
    await expect(broadcastSolanaTx(Buffer.alloc(0))).rejects.not.toThrow(
      /ROTATING oracles/,
    );
  });
});

/**
 * Issue #125 — the rotation-vs-aged-out detector is also used by the
 * pre-sign simulation gate. Keep the pure-function behavior covered
 * independently so both call sites (broadcast.ts and execution/index.ts)
 * can trust the signal.
 */
describe("isSwitchboardRotation", () => {
  it("returns true when 'Rotating mega slot' appears anywhere in the logs", async () => {
    const { isSwitchboardRotation } = await import(
      "../src/modules/solana/simulate.js"
    );
    expect(
      isSwitchboardRotation([
        "Program A invoke [1]",
        "Program log: Rotating mega slot",
        "Program log: AnchorError ...",
      ]),
    ).toBe(true);
  });

  it("returns false for plain NotEnoughSamples logs without the rotation marker", async () => {
    const { isSwitchboardRotation } = await import(
      "../src/modules/solana/simulate.js"
    );
    expect(
      isSwitchboardRotation([
        "Program A invoke [1]",
        "Program log: AnchorError ... Error Code: NotEnoughSamples. Error Number: 6030.",
      ]),
    ).toBe(false);
  });

  it("handles empty / undefined input defensively", async () => {
    const { isSwitchboardRotation } = await import(
      "../src/modules/solana/simulate.js"
    );
    expect(isSwitchboardRotation(undefined)).toBe(false);
    expect(isSwitchboardRotation([])).toBe(false);
  });
});
