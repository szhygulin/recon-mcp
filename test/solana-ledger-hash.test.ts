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
  it("spl_send: forces the agent to render the **`hash`** block verbatim", () => {
    const tx = makeSolanaTx("spl_send");
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("DO NOT FORWARD THIS BLOCK");
    expect(block).toContain("LEDGER MESSAGE HASH");
    expect(block).toContain(`**\`${expectedHash}\`**`);
    expect(block).toContain("Allow blind signing");
  });

  it("native_send: no hash-to-match block, no blind-sign-enable instruction", () => {
    const tx = makeSolanaTx("native_send");
    const hash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("clear-sign");
    // Must NOT contain the hash value itself — there's nothing to match.
    // (The template does mention "Message Hash" textually, as an
    // anti-hallucination reminder to the agent; that's fine.)
    expect(block).not.toContain(hash);
    expect(block).not.toContain("MATCH ON-DEVICE");
    expect(block).not.toContain("Allow blind signing");
  });
});
