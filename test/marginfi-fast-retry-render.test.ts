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
  it("emits the abridged template with CHECK A/B/C instead of CHECK 1/2", () => {
    const tx = makeUnsignedMarginfiBorrowWithFastRetry();
    const out = renderSolanaAgentTaskBlock(tx);

    // Fast-retry header + references to the prior approval
    expect(out).toMatch(/FAST-RETRY MODE/);
    expect(out).toContain("abc12345");
    expect(out).toMatch(/NotEnoughSamples/);

    // Abridged checks
    expect(out).toMatch(/CHECK A — PAIR-CONSISTENCY LEDGER HASH/);
    expect(out).toMatch(/CHECK B — PROGRAM-ID WHITELIST/);
    expect(out).toMatch(/CHECK C — SEMANTIC-ARGS MATCH/);
    expect(out).toMatch(/CHECKS PERFORMED \(FAST-RETRY\)/);

    // The full-path instruction-decode narrative and ABI-style markers
    // must NOT appear — that's the whole point of the abridge.
    expect(out).not.toMatch(/CHECK 1 — AGENT-SIDE INSTRUCTION DECODE/);
    expect(out).not.toMatch(/CHECK 2 — PAIR-CONSISTENCY LEDGER HASH/);
    expect(out).not.toMatch(/INSTRUCTION DECODE — <one-line verdict>/);

    // Program-id whitelist: both the retry's actual IDs and the curated
    // allow-list must be present so the agent can visually diff them.
    expect(out).toContain("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
    expect(out).toContain("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

    // Semantic-args diff: both prior and current arg bundles must render.
    expect(out).toMatch(/Prior approval args/);
    expect(out).toMatch(/Retry args/);

    // Second-LLM escape hatch stays available on retry.
    expect(out).toMatch(/SECOND-LLM CHECK/);

    // Fallback instruction if the agent has no memory of the prior approval.
    expect(out).toMatch(/DO NOT trust this FAST-RETRY header/);

    // v1.5 measurement instrumentation: the abridged CHECK A script drops
    // @solana/web3.js entirely (inline base58) and prints a timingsMs JSON
    // object so the user can attribute latency. Surface via a ⏱ Timings
    // line in the CHECKS PERFORMED template.
    expect(out).not.toMatch(/require\('@solana\/web3\.js'\)/);
    expect(out).toMatch(/timingsMs/);
    expect(out).toMatch(/⏱ Timings:/);
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
