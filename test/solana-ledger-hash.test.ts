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

function makeSolanaTx(action: "native_send" | "spl_send"): UnsignedSolanaTx {
  return {
    chain: "solana",
    action,
    from: "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf",
    messageBase64: Buffer.from("example-message-bytes").toString("base64"),
    recentBlockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
    description: "Send something",
    decoded: {
      functionName:
        action === "native_send"
          ? "solana.system.transfer"
          : "solana.spl.transferChecked",
      args: {
        from: "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf",
        to: "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf",
        amount: "1 SOL",
      },
    },
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

describe("renderSolanaAgentTaskBlock", () => {
  it("spl_send: auto-runs CHECK 1 + CHECK 2, renders Message Hash in bold+code, gates send_transaction", () => {
    const tx = makeSolanaTx("spl_send");
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    // Header tells agent to auto-run (no yes/no menu).
    expect(block).toContain("RUN THESE CHECKS NOW");
    // Both checks listed.
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

  it("native_send: CHECK 1 only, no CHECK 2, clear-sign on-device branch", () => {
    const tx = makeSolanaTx("native_send");
    const hash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("CHECK 1 — AGENT-SIDE INSTRUCTION DECODE");
    expect(block).not.toContain("CHECK 2 — PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("CLEAR-SIGN");
    // No hash to match against for native.
    expect(block).not.toContain(hash);
    expect(block).not.toContain("Allow blind signing");
    // But CHECK 1's decode recipe is still there.
    expect(block).toContain("@solana/web3.js");
  });
});
