import { createHash } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  solanaLedgerMessageHash,
  solanaPayloadFingerprint,
} from "../src/signing/verification.js";
import {
  renderSolanaVerificationBlock,
  renderSolanaAgentTaskBlock,
  renderSolanaPrepareSummaryBlock,
  renderSolanaPrepareAgentTaskBlock,
} from "../src/signing/render-verification.js";
import type { UnsignedSolanaTx } from "../src/types/index.js";

describe("solanaLedgerMessageHash", () => {
  it("reproduces base58(sha256(messageBytes)) — the exact 'Message Hash' the Ledger Solana app displays on blind-sign", () => {
    const messageBytes = Buffer.from("hello world");
    const expected = bs58.encode(
      createHash("sha256").update(messageBytes).digest(),
    );
    const got = solanaLedgerMessageHash(messageBytes.toString("base64"));
    expect(got).toBe(expected);
  });

  it("returns a ~43–44-char base58 string (32-byte digest, no truncation)", () => {
    const anyMessage = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const h = solanaLedgerMessageHash(anyMessage.toString("base64"));
    expect(h.length).toBeGreaterThanOrEqual(43);
    expect(h.length).toBeLessThanOrEqual(44);
    expect(h).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("is distinct from the server's domain-tagged payload fingerprint (different purpose, different preimage)", () => {
    const messageBase64 = Buffer.from("anything").toString("base64");
    const ledger = solanaLedgerMessageHash(messageBase64);
    const server = solanaPayloadFingerprint(messageBase64);
    expect(ledger).not.toBe(server);
    expect(server.startsWith("0x")).toBe(true);
    expect(ledger.startsWith("0x")).toBe(false);
  });
});

const TEST_FROM = "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf";
const TEST_NONCE_ACCT = "Br9r1xvBG71JLfY6upxTYKk2zcoe5zuGcQdRwLJx7VCo";
const TEST_NONCE_VALUE = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";

function makeSolanaTx(
  action: "native_send" | "spl_send" | "nonce_init" | "nonce_close",
): UnsignedSolanaTx {
  // Sends + close carry the nonce metadata (they're protected by
  // AdvanceNonceAccount at ix[0]); nonce_init is the one exception
  // (that tx CREATES the nonce account, so it has no nonce yet).
  const carriesNonce =
    action === "native_send" || action === "spl_send" || action === "nonce_close";
  const functionName =
    action === "native_send"
      ? "solana.system.transfer"
      : action === "spl_send"
        ? "solana.spl.transferChecked"
        : action === "nonce_init"
          ? "solana.system.createNonceAccount"
          : "solana.system.nonceWithdraw";
  return {
    chain: "solana",
    action,
    from: TEST_FROM,
    messageBase64: Buffer.from("example-message-bytes").toString("base64"),
    // For nonce-protected txs this is the nonce value; for init, a real blockhash.
    recentBlockhash: carriesNonce
      ? TEST_NONCE_VALUE
      : "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
    description: "Send something",
    decoded: {
      functionName,
      args: {
        from: TEST_FROM,
        to: TEST_FROM,
        amount: "1 SOL",
      },
    },
    ...(carriesNonce
      ? {
          nonce: {
            account: TEST_NONCE_ACCT,
            authority: TEST_FROM,
            value: TEST_NONCE_VALUE,
          },
        }
      : {}),
  };
}

describe("renderSolanaVerificationBlock", () => {
  it("native_send: no Message Hash (Ledger clear-signs SystemProgram.Transfer)", () => {
    const block = renderSolanaVerificationBlock(makeSolanaTx("native_send"));
    expect(block).toContain("native SOL transfer");
    expect(block).toContain("clear-sign");
    expect(block).not.toContain("Message Hash");
  });

  it("spl_send: includes the Ledger Message Hash in bold+code wrapping", () => {
    const tx = makeSolanaTx("spl_send");
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaVerificationBlock(tx);
    expect(block).toContain("SPL token transfer");
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain("Allow blind signing");
    // The hash must be wrapped in **`…`** — verified in live runs that
    // plain backticks or plain bold don't give enough contrast.
    expect(block).toContain(`**\`${expectedHash}\`**`);
  });
});

describe("renderSolanaPrepareSummaryBlock", () => {
  it("emits a user-facing summary with NO Message Hash (deferred to preview_solana_send)", () => {
    const block = renderSolanaPrepareSummaryBlock({
      handle: "abc-123",
      action: "spl_send",
      from: "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf",
      description: "Send 100 USDC to self",
      decoded: {
        functionName: "solana.spl.transferChecked",
        args: { amount: "100 USDC" },
      },
      estimatedFeeLamports: 5000,
    });
    expect(block).toContain("PREPARED");
    expect(block).toContain("SPL token transfer");
    expect(block).toContain("preview_solana_send");
    // No hash VALUE rendered at prepare time (the block mentions "Message
    // Hash" textually as part of describing what preview_solana_send does;
    // that's fine). There should be no bold+code wrapping — that's the
    // signal of an actual hash — and no base58 digest in the body.
    expect(block).not.toMatch(/\*\*`[1-9A-HJ-NP-Za-km-z]{43,44}`\*\*/);
  });
});

describe("renderSolanaPrepareAgentTaskBlock", () => {
  it("instructs the agent to wait for 'send' before calling preview_solana_send", () => {
    const block = renderSolanaPrepareAgentTaskBlock({
      handle: "abc-123",
      action: "native_send",
      from: "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf",
      description: "Send 1 SOL to self",
      decoded: {
        functionName: "solana.system.transfer",
        args: { amount: "1 SOL" },
      },
    });
    expect(block).toContain("DO NOT FORWARD THIS BLOCK TO THE USER");
    expect(block).toContain("wait for");
    expect(block).toContain("preview_solana_send(handle)");
    expect(block).toContain("Handle: abc-123");
    // Don't pre-decode or fabricate a hash at prepare time.
    expect(block).toContain("Do NOT fabricate a hash");
  });
});

describe("renderSolanaAgentTaskBlock", () => {
  it("spl_send: auto-runs CHECK 1 + CHECK 2, renders Message Hash for on-device match", () => {
    const tx = makeSolanaTx("spl_send");
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    // Header tells agent to auto-run (no yes/no menu).
    expect(block).toContain("RUN THESE CHECKS NOW");
    // Both checks listed using EVM CHECK 1's exact "AGENT-SIDE ... DECODE" naming.
    expect(block).toContain("CHECK 1 — AGENT-SIDE INSTRUCTION DECODE");
    expect(block).toContain("CHECK 2 — PAIR-CONSISTENCY LEDGER HASH");
    // Hash is spliced into the recompute target AND the on-device line.
    expect(block).toContain(expectedHash);
    expect(block).toContain(`**\`${expectedHash}\`**`);
    // Blind-sign prerequisite surfaced.
    expect(block).toContain("Allow blind signing");
    // Second-LLM escape hatch documented.
    expect(block).toContain("get_verification_artifact");
    // Send-call contract spelled out (no previewToken for Solana).
    expect(block).toContain("SEND-CALL CONTRACT");
    expect(block).toContain("confirmed: true");
    expect(block).not.toContain("previewToken");
  });

  it("native_send: CHECK 1 only (no hash recompute), clear-sign on-device branch", () => {
    const tx = makeSolanaTx("native_send");
    const hash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("CHECK 1 — AGENT-SIDE INSTRUCTION DECODE");
    expect(block).not.toContain("CHECK 2 — PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("CLEAR-SIGN");
    // No hash to match against for native.
    expect(block).not.toContain(hash);
    expect(block).not.toContain("Allow blind signing");
  });

  it("CHECK 1 + CHECK 2 share a single combined Bash command (one approval, two verdicts)", () => {
    // Earlier iterations split the checks: CHECK 1 = browser-verify (Explorer
    // URL), CHECK 2 = separate hash-only Bash command. The user wanted the
    // agent to actually DO CHECK 1, not just punt to the browser. Combined
    // script: one `node -e "..."` outputs `{ledgerHash, instructions}`. Agent
    // verifies BOTH from the same JSON. CHECK 1 verdict goes from permanent
    // ⚠ to {✓|✗|⚠} (agent-determined). Explorer URL stays in the CHECKS
    // PERFORMED template as a secondary fallback for the ⚠ DECODE PARTIAL
    // case (unrecognized program / can't sanity-check the data).
    const block = renderSolanaAgentTaskBlock(makeSolanaTx("spl_send"));
    // No heredoc anywhere in the block.
    expect(block).not.toContain("<<'SCRIPT_EOF'");
    expect(block).not.toContain("SCRIPT_EOF");
    // CommonJS `node -e "..."` form, no env-var prefix.
    expect(block).not.toContain("--input-type=module -e");
    expect(block).not.toMatch(/MSG_B64=/);
    expect(block).not.toMatch(/process\.env\.MSG_B64/);
    // Combined script: imports Message + VersionedMessage + PublicKey +
    // Connection. Version branching added in Milestone A (Phase 3) so the
    // same script handles legacy (SPL sends, native sends, nonce_close) AND
    // v0 messages with ALT-indexed accounts (Jupiter swaps, Kamino/MarginFi
    // flows that need ALTs).
    expect(block).toMatch(
      /node -e "const \{Message, VersionedMessage, PublicKey, Connection\} = require\('@solana\/web3\.js'\);/,
    );
    expect(block).toContain(
      "const m = '<messageBase64 from the preview_solana_send result>';",
    );
    // Version detection: 0x80 prefix = v0, otherwise legacy.
    expect(block).toContain("if (buf[0] & 0x80) {");
    // Legacy branch uses Message.from; v0 branch uses VersionedMessage.deserialize.
    expect(block).toContain("const msg = Message.from(buf);");
    expect(block).toContain("const msg = VersionedMessage.deserialize(buf);");
    // v0 branch resolves ALTs via a Connection.
    expect(block).toContain("conn.getAddressLookupTable(lookup.accountKey)");
    // Inline base58→hex helper (for legacy data field, which is base58).
    expect(block).toContain(
      "const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';",
    );
    expect(block).toContain("const b58 = s =>");
    // v0 data is already a byte array; no base58 decode needed.
    expect(block).toContain("Buffer.from(ix.data).toString('hex')");
    // Output: BOTH ledgerHash AND instructions[] — single JSON.
    expect(block).toContain(
      "const ledgerHash = new PublicKey(createHash('sha256').update(buf).digest()).toBase58();",
    );
    expect(block).toContain("console.log(JSON.stringify({ledgerHash, instructions}, null, 2));");
    expect(block).toContain("programId: msg.accountKeys[ix.programIdIndex].toBase58()");
    expect(block).toContain("dataHex: b58(ix.data)");
    // CHECK 1 verdict is now {✓|✗|⚠} (agent-determined), NOT permanent ⚠.
    expect(block).toContain("{✓|✗|⚠} INSTRUCTION DECODE");
    // CHECK 2 verdict line still {✓|✗}.
    expect(block).toContain("{✓|✗} PAIR-CONSISTENCY LEDGER HASH");
    // Browser-verify fallback URL (prefilled) STAYS as a secondary defense
    // for the ⚠ DECODE PARTIAL case.
    const tx = makeSolanaTx("spl_send");
    const expectedUrl =
      "https://explorer.solana.com/tx/inspector?cluster=mainnet&message=" +
      encodeURIComponent(tx.messageBase64);
    expect(block).toContain(
      `[Open in Solana Explorer Inspector](${expectedUrl})`,
    );
    expect(block).toContain("Browser-side decode fallback:");
  });

  it("clear-sign actions (native_send / nonce_close) skip CHECK 2 entirely (no hash recompute)", () => {
    // Same policy as EVM: when Ledger clear-signs the tx, the on-device
    // decoded fields ARE the integrity gate. A server-side hash recompute
    // adds nothing in that scenario.
    // (nonce_init is short-circuited entirely; see its own test below.)
    for (const action of ["native_send", "nonce_close"] as const) {
      const block = renderSolanaAgentTaskBlock(makeSolanaTx(action));
      expect(block).not.toContain("CHECK 2 — PAIR-CONSISTENCY LEDGER HASH");
      // No `node -e` command for hash recompute either.
      expect(block).not.toMatch(/node --input-type=module -e/);
    }
  });

  it("DURABLE-NONCE MODE is documented for sends/close (nonce_init is short-circuited)", () => {
    for (const action of ["native_send", "spl_send", "nonce_close"] as const) {
      const block = renderSolanaAgentTaskBlock(makeSolanaTx(action));
      expect(block).toContain("DURABLE-NONCE MODE");
      // Summary shape mentions the Nonce bullet.
      expect(block).toContain("Nonce:");
    }
  });

  it("nonce_init SHORT-CIRCUITS — no CHECKS PERFORMED block, no Explorer URL, no hash recompute, just on-device clear-sign instructions", () => {
    // nonce_init is the one Solana action that runs WITHOUT durable-nonce
    // protection (it's the tx CREATING the nonce account), so it has a
    // real ~60s blockhash window. Three live attempts blew that window
    // because the standard verification block took ~30s of agent prep.
    // Since the Ledger Solana app clear-signs the two System Program
    // instructions (createAccountWithSeed + nonceInitialize) and the
    // user can verify the new account address, seed, authority, and
    // rent on-device, the standard CHECKS block adds zero security and
    // burns the budget the broadcast needs.
    const block = renderSolanaAgentTaskBlock(makeSolanaTx("nonce_init"));

    // No CHECKS PERFORMED template emitted (the short-circuit text
    // mentions the phrase as "do NOT emit a CHECKS PERFORMED block",
    // so test for the literal template marker line, not the substring).
    expect(block).not.toContain("═══════ CHECKS PERFORMED ═══════");
    expect(block).not.toContain("CHECK 1 — BROWSER-VERIFY DECODE");
    expect(block).not.toContain("CHECK 2 — PAIR-CONSISTENCY LEDGER HASH");

    // No Explorer Inspector link rendered (the bare URL doesn't appear
    // either — the short-circuit text refers to it descriptively
    // ("Solana Explorer Inspector link") but never as a clickable URL).
    expect(block).not.toContain("https://explorer.solana.com");
    expect(block).not.toContain("[Open in Solana Explorer Inspector]");

    // No hash recompute / no node command at all.
    expect(block).not.toMatch(/node --input-type=module/);
    expect(block).not.toContain("MSG_B64=");

    // No SECOND-LLM offer (would just confuse — there's no payload to
    // pass to a second LLM that the device clear-sign doesn't already
    // surface).
    expect(block).not.toContain("SECOND-LLM CHECK");
    expect(block).not.toContain("get_verification_artifact");

    // What MUST be there: on-device clear-sign instructions covering
    // the deterministic facts. These are the things that catch an MCP
    // that put the rent into an attacker-controlled PDA or set a
    // hostile authority — but the user verifies them on-DEVICE, not in
    // a browser.
    expect(block).toContain("CLEAR-SIGN");
    expect(block).toContain("CreateAccountWithSeed");
    expect(block).toContain("NonceInitialize");
    expect(block).toContain('"vaultpilot-nonce-v1"');
    expect(block).toContain("Nonce Authority");

    // Send-call contract still spelled out.
    expect(block).toContain("SEND-CALL CONTRACT");
    expect(block).toContain("confirmed: true");
  });

  it("nonce_close: durable-nonce-protected, summary headline mentions close", () => {
    // For close, the user verifies on-device that destination = wallet
    // and lamports == full balance. The bullet summary already shows this
    // (Wallet, Withdraw amount); the Explorer link in CHECK 1 lets the
    // user confirm against the decoded view.
    const block = renderSolanaAgentTaskBlock(makeSolanaTx("nonce_close"));
    expect(block).toContain("durable-nonce close");
    expect(block).toContain("DURABLE-NONCE MODE");
  });
});
