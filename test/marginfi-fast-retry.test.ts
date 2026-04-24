/**
 * MarginFi fast-retry — unit coverage for the approval cache and the
 * failure classifier. Exercises the two pure building blocks the feature
 * depends on (eligibility gating + failure classification); the full
 * preview → sign → broadcast → retry loop is covered in a separate
 * integration test file.
 *
 * The cache is a process-local singleton — each test calls
 * `__clearMarginfiApprovalCache` in its setup to avoid cross-test leakage.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  __clearMarginfiApprovalCache,
  findMarginfiApproval,
  recordMarginfiApproval,
  recordMarginfiFailure,
  type ApprovalKeyFields,
  type ApprovedMarginfiOp,
} from "../src/signing/solana-tx-store.js";
import { classifyMarginfiFailure } from "../src/modules/solana/broadcast.js";

const WALLET = "8xn3QBmgqZiXg5ZQMEgJ8H3wP9DpM2V3Qz4bK1N7YaVc";
const BANK = "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZMAMwVBUvBM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fields(overrides: Partial<ApprovalKeyFields> = {}): ApprovalKeyFields {
  return {
    wallet: WALLET,
    action: "marginfi_borrow",
    accountIndex: 0,
    bank: BANK,
    mint: MINT,
    amount: "1.5",
    ...overrides,
  };
}

function approval(
  overrides: Partial<ApprovedMarginfiOp> = {},
): ApprovedMarginfiOp {
  return {
    key: fields(),
    ledgerHash: "abc12345",
    approvedAt: Date.now(),
    decodedArgs: {
      wallet: WALLET,
      marginfiAccount: "Marg1nF1PDA",
      accountIndex: "0",
      bank: BANK,
      mint: MINT,
      symbol: "USDC",
      amount: "1.5 USDC",
      nonceAccount: "No1cePDA",
    },
    ...overrides,
  };
}

describe("approval cache — findMarginfiApproval keying + TTL", () => {
  beforeEach(() => __clearMarginfiApprovalCache());

  it("returns the approval after recordMarginfiApproval for an identical descriptor", () => {
    const op = approval();
    recordMarginfiApproval(op);
    const hit = findMarginfiApproval(fields());
    expect(hit?.approval.ledgerHash).toBe(op.ledgerHash);
    expect(hit?.lastFailure).toBeUndefined();
  });

  it("misses when any of the six key dimensions differs (wallet)", () => {
    recordMarginfiApproval(approval());
    expect(findMarginfiApproval(fields({ wallet: "DifferentWallet11111" }))).toBeNull();
  });

  it("misses when the action flips from borrow to repay", () => {
    recordMarginfiApproval(approval());
    expect(findMarginfiApproval(fields({ action: "marginfi_repay" }))).toBeNull();
  });

  it("misses when the bank changes", () => {
    recordMarginfiApproval(approval());
    expect(findMarginfiApproval(fields({ bank: "OtherBank" }))).toBeNull();
  });

  it("misses when the mint changes", () => {
    recordMarginfiApproval(approval());
    expect(findMarginfiApproval(fields({ mint: "OtherMint" }))).toBeNull();
  });

  it("misses when the amount differs by a single atom in canonical form", () => {
    recordMarginfiApproval(approval());
    // 1.5 vs. 1.500001 — different canonical string, cache miss by design.
    expect(findMarginfiApproval(fields({ amount: "1.500001" }))).toBeNull();
  });

  it("misses when the accountIndex changes", () => {
    recordMarginfiApproval(approval());
    expect(findMarginfiApproval(fields({ accountIndex: 1 }))).toBeNull();
  });

  it("surfaces the most recent failure when one is recorded after the approval", () => {
    recordMarginfiApproval(approval());
    recordMarginfiFailure(fields(), {
      kind: "oracle-transient",
      reason: "NotEnoughSamples",
      failedAt: Date.now(),
    });
    const hit = findMarginfiApproval(fields());
    expect(hit?.lastFailure?.kind).toBe("oracle-transient");
    expect(hit?.lastFailure?.reason).toBe("NotEnoughSamples");
  });

  it("recordMarginfiFailure is a no-op without a prior approval", () => {
    recordMarginfiFailure(fields(), {
      kind: "oracle-transient",
      reason: "NotEnoughSamples",
      failedAt: Date.now(),
    });
    // No approval was recorded — the cache stays empty, so lookups miss.
    expect(findMarginfiApproval(fields())).toBeNull();
  });

  it("a later recordMarginfiApproval preserves the lastFailure from before", () => {
    recordMarginfiApproval(approval());
    recordMarginfiFailure(fields(), {
      kind: "oracle-transient",
      reason: "RotatingMegaSlot",
      failedAt: Date.now(),
    });
    // A same-key re-approval (e.g. user re-signed the exact same tx that
    // then failed again) shouldn't zero the failure log.
    recordMarginfiApproval(approval({ ledgerHash: "def67890" }));
    const hit = findMarginfiApproval(fields());
    expect(hit?.approval.ledgerHash).toBe("def67890");
    expect(hit?.lastFailure?.reason).toBe("RotatingMegaSlot");
  });
});

describe("approval cache — TTL expiry", () => {
  beforeEach(() => {
    __clearMarginfiApprovalCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the approval after 15 minutes", () => {
    const now = new Date("2026-04-24T12:00:00Z").getTime();
    vi.setSystemTime(now);
    recordMarginfiApproval(approval({ approvedAt: now }));
    expect(findMarginfiApproval(fields())).not.toBeNull();

    // 14m59s — still fresh
    vi.setSystemTime(now + 14 * 60_000 + 59_000);
    expect(findMarginfiApproval(fields())).not.toBeNull();

    // 15m01s — expired
    vi.setSystemTime(now + 15 * 60_000 + 1_000);
    expect(findMarginfiApproval(fields())).toBeNull();
  });
});

describe("classifyMarginfiFailure — switchboard transient taxonomy", () => {
  it("classifies broadcast.ts's 'ROTATING oracles' wrap as RotatingMegaSlot", () => {
    const err = new Error(
      'Switchboard feed is ROTATING oracles ("Rotating mega slot" in the logs) — this is a transient ...',
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("RotatingMegaSlot");
  });

  it("classifies broadcast.ts's 'aged out' wrap as NotEnoughSamples", () => {
    const err = new Error(
      "Switchboard oracle samples aged out during Ledger review — ... Raw: foo",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("NotEnoughSamples");
  });

  it("classifies a pre-sign simulation 'NotEnoughSamples' anchor-error message", () => {
    const err = new Error(
      "Pre-sign simulation REJECTED the marginfi_borrow tx — NotEnoughSamples (6030): ...",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("NotEnoughSamples");
  });

  it("classifies an InvalidSlotNumber-named error as InvalidSlotNumber", () => {
    const err = new Error(
      "Pre-sign simulation REJECTED — InvalidSlotNumber (6039): provided slot is outside ...",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("InvalidSlotNumber");
  });

  it("classifies a 0x178e-only message (no named anchor) as NotEnoughSamples", () => {
    const err = new Error(
      "Transaction simulation failed: custom program error: 0x178e",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("NotEnoughSamples");
  });

  it("classifies a 0x1797-only message as InvalidSlotNumber", () => {
    const err = new Error(
      "Transaction simulation failed: custom program error: 0x1797",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("InvalidSlotNumber");
  });

  it("classifies a MarginFi bad-health revert as 'other' (not oracle-transient)", () => {
    const err = new Error(
      "Pre-sign simulation REJECTED — RiskEngineInitRejected (6009): ...",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("other");
  });

  it("classifies arbitrary RPC errors as 'other'", () => {
    const err = new Error("HTTP 500 fetch error against https://rpc.example.com");
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("other");
  });

  it("classifies a rotation-wrapped raw 0x178e (the full combined error) as RotatingMegaSlot, not NotEnoughSamples", () => {
    // A `Rotating mega slot` log PRECEDES the 0x178e Anchor code — the
    // combined broadcast error string carries both. Rotation must win
    // because the user action differs (wait vs. re-prepare).
    const err = new Error(
      "Transaction simulation failed: custom program error: 0x178e\nProgram logs:\n  Program log: Rotating mega slot\n  Program log: AnchorError NotEnoughSamples 6030",
    );
    const c = classifyMarginfiFailure(err);
    expect(c.kind).toBe("oracle-transient");
    expect(c.reason).toBe("RotatingMegaSlot");
  });
});

describe("findMarginfiApproval — fast-retry eligibility interpretation", () => {
  beforeEach(() => __clearMarginfiApprovalCache());

  it("eligibility (A∧B) requires BOTH an approval AND an oracle-transient last failure", () => {
    // (A) alone — approval but no recorded failure → ineligible.
    recordMarginfiApproval(approval());
    let hit = findMarginfiApproval(fields());
    expect(hit?.lastFailure?.kind).toBeUndefined();

    // (B) without (A) — can't record failure without approval (returns silently).
    __clearMarginfiApprovalCache();
    recordMarginfiFailure(fields(), {
      kind: "oracle-transient",
      reason: "NotEnoughSamples",
      failedAt: Date.now(),
    });
    hit = findMarginfiApproval(fields());
    expect(hit).toBeNull();

    // (A) + (B, wrong kind) — fails classifier → ineligible.
    __clearMarginfiApprovalCache();
    recordMarginfiApproval(approval());
    recordMarginfiFailure(fields(), {
      kind: "other",
      reason: "RiskEngineInitRejected",
      failedAt: Date.now(),
    });
    hit = findMarginfiApproval(fields());
    expect(hit?.lastFailure?.kind).toBe("other");
    // Call sites gate on `lastFailure?.kind === "oracle-transient"` — this
    // asserts the eligibility decision is computable, not the decision itself.

    // (A) + (B, right kind) — eligible.
    __clearMarginfiApprovalCache();
    recordMarginfiApproval(approval());
    recordMarginfiFailure(fields(), {
      kind: "oracle-transient",
      reason: "NotEnoughSamples",
      failedAt: Date.now(),
    });
    hit = findMarginfiApproval(fields());
    expect(hit?.lastFailure?.kind).toBe("oracle-transient");
  });
});
