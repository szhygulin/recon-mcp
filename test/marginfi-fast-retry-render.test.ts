/**
 * Render-layer coverage for the MarginFi fast-retry feature.
 *
 * Two observable changes the feature introduces in chat output:
 *   1. `renderSolanaPrepareSummaryBlock` surfaces a FAST-RETRY ELIGIBLE
 *      banner above the PREPARED header when `r.fastRetry` is set.
 *   2. `renderSolanaAgentTaskBlock` emits the abridged CHECKS template
 *      (not the full instruction-decode flow) when `tx.fastRetry` is
 *      present on a marginfi_borrow/repay.
 *
 * The tests assert the structural invariants that actually matter —
 * "CHECK 1 / INSTRUCTION DECODE" is GONE on the abridged path, and the
 * three new CHECK letters (A/B/C) + the whitelist + the prior-hash
 * references ARE present. Avoids full-string snapshots so copy tweaks
 * don't cascade into irrelevant test churn.
 */
import { describe, it, expect } from "vitest";

import {
  renderSolanaAgentTaskBlock,
  renderSolanaPrepareSummaryBlock,
  type RenderableSolanaPrepareResult,
} from "../src/signing/render-verification.js";
import type { UnsignedSolanaTx } from "../src/types/index.js";

const WALLET = "8xn3QBmgqZiXg5ZQMEgJ8H3wP9DpM2V3Qz4bK1N7YaVc";
const BANK = "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZMAMwVBUvBM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MARGINFI_ACCOUNT = "M4rg1nF1AccPDA1111111111111111111111111111";

// Minimum valid Solana message bytes for a v0 tx — used only so the
// `solanaLedgerMessageHash` helper has input. The hash value itself is
// incidental to the render assertions; we just need the block to render.
// Structure: version byte (0x80), [num_required_signatures=1, num_readonly_signed=0,
// num_readonly_unsigned=0], [1 account_key], recent blockhash (32 zeroes),
// [0 instructions], [0 address_table_lookups].
function makeStubMessageBase64(): string {
  const bytes = Buffer.concat([
    Buffer.from([0x80]), // v0 prefix
    Buffer.from([1, 0, 0]), // signatures / readonly / unsigned
    Buffer.from([1]), // 1 account key
    Buffer.alloc(32, 0), // dummy pubkey
    Buffer.alloc(32, 0), // recent blockhash
    Buffer.from([0]), // 0 instructions
    Buffer.from([0]), // 0 address-table lookups
  ]);
  return bytes.toString("base64");
}

function makeUnsignedMarginfiBorrowWithFastRetry(): UnsignedSolanaTx {
  return {
    chain: "solana",
    action: "marginfi_borrow",
    from: WALLET,
    messageBase64: makeStubMessageBase64(),
    recentBlockhash: "11111111111111111111111111111111",
    description: "MarginFi borrow: 1.5 USDC ...",
    decoded: {
      functionName: "marginfi.lending_account_borrow",
      args: {
        wallet: WALLET,
        marginfiAccount: MARGINFI_ACCOUNT,
        accountIndex: "0",
        bank: BANK,
        mint: MINT,
        symbol: "USDC",
        amount: "1.5 USDC",
        nonceAccount: "NoncePDA",
      },
    },
    fastRetry: {
      priorLedgerHash: "abc12345",
      approvedAt: Date.now() - 42_000, // 42s ago
      transientReason: "NotEnoughSamples",
      priorDecodedArgs: {
        wallet: WALLET,
        marginfiAccount: MARGINFI_ACCOUNT,
        accountIndex: "0",
        bank: BANK,
        mint: MINT,
        symbol: "USDC",
        amount: "1.5 USDC",
        nonceAccount: "NoncePDA",
      },
    },
    programIdsInMessage: [
      "11111111111111111111111111111111", // System
      "ComputeBudget111111111111111111111111111111",
      "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
      "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv",
    ],
  };
}

describe("renderSolanaPrepareSummaryBlock — fast-retry advisory banner", () => {
  it("emits the FAST-RETRY ELIGIBLE banner above PREPARED when r.fastRetry is set", () => {
    const r: RenderableSolanaPrepareResult = {
      handle: "handle-1",
      action: "marginfi_borrow",
      from: WALLET,
      description: "MarginFi borrow: 1.5 USDC",
      decoded: {
        functionName: "marginfi.lending_account_borrow",
        args: { wallet: WALLET, bank: BANK, mint: MINT, amount: "1.5 USDC" },
      },
      nonceAccount: "NoncePDA",
      fastRetry: {
        priorLedgerHash: "abc12345",
        approvedAt: Date.now() - 30_000,
        transientReason: "NotEnoughSamples",
      },
    };
    const out = renderSolanaPrepareSummaryBlock(r);
    expect(out).toMatch(/FAST-RETRY ELIGIBLE/);
    expect(out).toContain("abc12345");
    expect(out).toMatch(/NotEnoughSamples/);
    // The orphaned "send full" verb was removed (no such code path). The
    // banner now points users at re-preparing for intent changes.
    expect(out).not.toMatch(/'send full'/);
    expect(out).toMatch(/re-run\s+prepare_marginfi_borrow/);
    // The banner must appear BEFORE the PREPARED header — otherwise the
    // user scrolls past it reading the summary first.
    expect(out.indexOf("FAST-RETRY ELIGIBLE")).toBeLessThan(
      out.indexOf("PREPARED (Solana"),
    );
  });

  it("does NOT emit the banner on a non-fast-retry prepare", () => {
    const r: RenderableSolanaPrepareResult = {
      handle: "handle-1",
      action: "marginfi_borrow",
      from: WALLET,
      description: "MarginFi borrow: 1.5 USDC",
      decoded: {
        functionName: "marginfi.lending_account_borrow",
        args: { wallet: WALLET, bank: BANK, mint: MINT, amount: "1.5 USDC" },
      },
      nonceAccount: "NoncePDA",
    };
    const out = renderSolanaPrepareSummaryBlock(r);
    expect(out).not.toMatch(/FAST-RETRY ELIGIBLE/);
  });
});

describe("renderSolanaAgentTaskBlock — abridged template when tx.fastRetry is set", () => {
  it("emits the compressed abridged template (v1.6): one-line output contract, all three checks, security-critical content retained", () => {
    const tx = makeUnsignedMarginfiBorrowWithFastRetry();
    const out = renderSolanaAgentTaskBlock(tx);

    // Fast-retry header + references to the prior approval (security audit trail)
    expect(out).toMatch(/FAST-RETRY \(MarginFi borrow\)/);
    expect(out).toContain("abc12345");
    expect(out).toMatch(/NotEnoughSamples/);

    // All three abridged checks are still present (compressed but named).
    expect(out).toMatch(/CHECK A \(pair-consistency hash\)/);
    expect(out).toMatch(/CHECK B \(program-id whitelist\)/);
    expect(out).toMatch(/CHECK C \(semantic-args match\)/);

    // Old multi-line CHECKS PERFORMED box-drawing block is GONE on v1.6
    // (that's the main LLM-output compression lever).
    expect(out).not.toMatch(/═══════ CHECKS PERFORMED/);
    expect(out).not.toMatch(/────────────────────────────────/);
    expect(out).not.toMatch(/\{✓\|✗\} PAIR-CONSISTENCY LEDGER HASH — <verdict>/);

    // Full-path instruction-decode markers must still NOT appear.
    expect(out).not.toMatch(/CHECK 1 — AGENT-SIDE INSTRUCTION DECODE/);
    expect(out).not.toMatch(/INSTRUCTION DECODE — <one-line verdict>/);

    // Program-id whitelist: both retry IDs and allow-list present (inline now).
    expect(out).toContain("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
    expect(out).toContain("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

    // Semantic-args diff: prior + retry args both render (as JSON on compressed path).
    expect(out).toMatch(/prior:/);
    expect(out).toMatch(/retry:/);

    // New one-line output contract — the compression's biggest LLM-cost win.
    expect(out).toMatch(/✓ FAST-RETRY CHECKS PASSED — approve on Ledger \(hash /);
    expect(out).toMatch(/✗ CHECK <A\|B\|C> FAILED — DO NOT SIGN:/);

    // Security-critical: no-session-memory fallback kept verbatim in spirit.
    expect(out).toMatch(/I don't recognize this prior approval/);

    // Security-critical: second-LLM escape hatch still points at the right tool.
    expect(out).toMatch(/get_verification_artifact/);

    // v1.5 inline base58 (no @solana/web3.js) + timingsMs still present.
    expect(out).not.toMatch(/require\('@solana\/web3\.js'\)/);
    expect(out).toMatch(/timingsMs/);

    // Hard compression ceiling — the abridged block must stay ≤40 lines
    // (it was ~120 before v1.6). Going over this without updating the
    // ceiling means the compression has regressed and needs a look.
    expect(out.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("the full template renders when tx.fastRetry is absent on marginfi_borrow", () => {
    const tx = makeUnsignedMarginfiBorrowWithFastRetry();
    delete tx.fastRetry;
    delete tx.programIdsInMessage;
    const out = renderSolanaAgentTaskBlock(tx);
    // Full template carries the "INSTRUCTION DECODE" phrase, abridged does not.
    expect(out).toMatch(/INSTRUCTION DECODE/);
    expect(out).not.toMatch(/FAST-RETRY MODE/);

    // v1.5 measurement instrumentation: the full combined script stays
    // on @solana/web3.js (needed for Message/VersionedMessage/Connection)
    // but carries its own timingsMs breakdown + ⏱ Timings echo line.
    expect(out).toMatch(/require\('@solana\/web3\.js'\)/);
    expect(out).toMatch(/timingsMs/);
    expect(out).toMatch(/⏱ Timings:/);
  });
});
