/**
 * Drainer-pattern refusal + byte-fingerprint helper for
 * `sign_message_btc` / `sign_message_ltc` (issue #454). Pure unit
 * tests on the guard module — the integration with the actual
 * signers is covered by the existing message-sign tests
 * (`btc-pr4-portfolio-message-sign.test.ts` /
 * `litecoin-core.test.ts`), which the guard's additive output field
 * (`messageBytesSha256`) and its no-op-on-benign-message default
 * leave green.
 */
import { describe, it, expect } from "vitest";
import {
  refuseIfDrainerLike,
  messageBytesSha256,
} from "../src/signing/message-sign-guard.js";
import { createHash } from "node:crypto";

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const OTHER_BTC_ADDR = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const LTC_ADDR = "ltc1qhzjptwpym9afcdjhs7jcz6fd0jma0l0rc0e5yr";

function safeSubject(extra?: Partial<{ wallet: string; toolName: "sign_message_btc" | "sign_message_ltc" }>) {
  return {
    wallet: extra?.wallet ?? SEGWIT_ADDR,
    toolName: extra?.toolName ?? ("sign_message_btc" as const),
  };
}

describe("refuseIfDrainerLike — drainer template phrases (any single hit refuses)", () => {
  const templates = [
    "I authorize the use of these funds.",
    "Granting custody of this wallet to bob",
    "Granting full custody to a third party",
    "I consent to the transfer of all funds",
    "I grant access to my private keys",
    "release of funds approved",
    "release of all funds approved",
    "transfer all funds to the recipient",
    "authorize transfer of holdings",
    "authorize release of escrow",
    "authorize custody change",
  ];
  it.each(templates)("refuses on template phrase: %s", (msg) => {
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).toThrow(/drainer-template phrase|drainer-pattern/i);
  });
});

describe("refuseIfDrainerLike — semantic markers (refuse on 2+ co-occurring matches)", () => {
  it("refuses when message contains two markers (transfer + authorize)", () => {
    const msg = "Please authorize the transfer.";
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).toThrow(/semantic markers/i);
  });

  it("refuses when message contains three markers without a template phrase", () => {
    // Three markers (transfer, custody, release) co-occur but no
    // template anchor like "I grant" / "I authorize" — exercises the
    // semantic-markers branch directly.
    const msg = "Reviewing the transfer, the custody change, and the release.";
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).toThrow(/semantic markers/i);
  });

  it("does NOT refuse on a single marker in a benign sentence", () => {
    // "I, the owner, received a transfer ..." — single marker, no
    // template, no foreign address. False-positive risk would be
    // here; we deliberately allow it.
    const msg = "I, the owner of this wallet, received a transfer on 2026-04-28";
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).not.toThrow();
  });

  it("does NOT refuse on a benign proof-of-ownership challenge", () => {
    const msg = "challenge nonce 7f2a93";
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).not.toThrow();
  });
});

describe("refuseIfDrainerLike — embedded address must be the signing wallet", () => {
  it("refuses on a foreign BTC segwit address in the body", () => {
    const msg = `I attest ownership of ${OTHER_BTC_ADDR} as of 2026-04-28`;
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).toThrow(/external address/i);
  });

  it("refuses on a foreign address even when the wallet is also embedded", () => {
    const msg = `Owner of ${SEGWIT_ADDR} attests for ${OTHER_BTC_ADDR}.`;
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).toThrow(/external address/i);
  });

  it("does NOT refuse when only the signing wallet is embedded", () => {
    const msg = `I am the owner of ${SEGWIT_ADDR}. challenge=abc`;
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: msg }),
    ).not.toThrow();
  });

  it("works for LTC signing wallet + foreign LTC address", () => {
    const msg = `proof for ${LTC_ADDR} (foreign)`;
    expect(() =>
      refuseIfDrainerLike({
        wallet: "ltc1qjyj7lr3a23ejfsm2vvld6ugxx9wpgu33uxmd2k",
        toolName: "sign_message_ltc",
        message: msg,
      }),
    ).toThrow(/external address/i);
  });
});

describe("refuseIfDrainerLike — error messages cite the issue + tool", () => {
  it("template error names the tool and issue", () => {
    expect(() =>
      refuseIfDrainerLike({ ...safeSubject(), message: "I authorize this." }),
    ).toThrow(/sign_message_btc.*#454/);
  });

  it("LTC tool name flows into the LTC-side error", () => {
    expect(() =>
      refuseIfDrainerLike({
        ...safeSubject({ toolName: "sign_message_ltc" }),
        message: "I authorize this.",
      }),
    ).toThrow(/sign_message_ltc.*#454/);
  });
});

describe("messageBytesSha256 — pinned hashes", () => {
  it("returns the SHA-256 of the UTF-8 bytes (ASCII)", () => {
    const msg = "hello world";
    const expected =
      "0x" + createHash("sha256").update(Buffer.from(msg, "utf-8")).digest("hex");
    expect(messageBytesSha256(msg)).toBe(expected);
  });

  it("differs for visually-confusable Unicode (em-dash vs hyphen)", () => {
    const withHyphen = "I own bc1qabc - challenge 7f";
    const withEmDash = "I own bc1qabc — challenge 7f";
    expect(messageBytesSha256(withHyphen)).not.toBe(
      messageBytesSha256(withEmDash),
    );
  });

  it("differs for Cyrillic-А vs Latin-A confusable", () => {
    const latin = "Address attestation A";
    const cyrillic = "Address attestation А"; // U+0410 CYRILLIC CAPITAL A
    expect(messageBytesSha256(latin)).not.toBe(messageBytesSha256(cyrillic));
  });

  it("returns 0x-prefixed lowercase hex of length 66 (32 bytes + prefix)", () => {
    const out = messageBytesSha256("anything");
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
