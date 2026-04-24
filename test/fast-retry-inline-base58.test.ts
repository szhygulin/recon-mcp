/**
 * Correctness gate for the inline base58 encoder used in the abridged
 * fast-retry CHECK A Node one-liner (src/signing/render-verification.ts
 * renderSolanaAgentTaskBlockAbridged).
 *
 * The abridged script dropped `require('@solana/web3.js')` to shave Node
 * cold-start time (v1.5 measurement plan). The inlined 20-line base58
 * encoder MUST produce identical output to `new PublicKey(buf).toBase58()`
 * for every possible 32-byte sha256 digest, otherwise the user's
 * on-device hash comparison silently diverges from what the script prints.
 *
 * Test strategy: compile the same encoder string as a runtime function,
 * fuzz 50 random 32-byte buffers + edge cases (all-zero, all-FF, low bytes
 * that need leading-'1' handling), assert byte-for-byte equality against
 * the reference.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * Exact copy of the inline encoder string embedded in the Node one-liner
 * at `renderSolanaAgentTaskBlockAbridged`. If you change one, change the
 * other in the same commit — that's the whole invariant this test exists
 * to protect.
 */
function inlineBase58(buf: Buffer): string {
  const A =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const x of buf) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of buf) {
    if (x === 0) s = "1" + s;
    else break;
  }
  return s;
}

function randomBytes32(): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

describe("inline base58 encoder matches PublicKey.toBase58() byte-for-byte", () => {
  it("fuzz: 50 random 32-byte digests produce identical base58", () => {
    for (let i = 0; i < 50; i++) {
      const buf = randomBytes32();
      const ref = new PublicKey(buf).toBase58();
      const got = inlineBase58(buf);
      expect(got).toBe(ref);
    }
  });

  it("edge case: all-zero 32 bytes encodes to '11111111111111111111111111111111'", () => {
    const buf = Buffer.alloc(32, 0);
    const ref = new PublicKey(buf).toBase58();
    const got = inlineBase58(buf);
    expect(got).toBe(ref);
    expect(got).toBe("11111111111111111111111111111111");
  });

  it("edge case: all-FF 32 bytes encodes identically to reference", () => {
    const buf = Buffer.alloc(32, 0xff);
    const ref = new PublicKey(buf).toBase58();
    expect(inlineBase58(buf)).toBe(ref);
  });

  it("edge case: leading-zero prefix maps to leading-'1' characters", () => {
    // One leading zero byte + 31 non-zero bytes — the leading-'1' branch
    // in the encoder must still fire even though the numeric value is
    // non-zero.
    const buf = Buffer.alloc(32);
    for (let i = 1; i < 32; i++) buf[i] = 0xab;
    const ref = new PublicKey(buf).toBase58();
    expect(inlineBase58(buf)).toBe(ref);
    expect(inlineBase58(buf).startsWith("1")).toBe(true);
  });

  it("edge case: 5 leading zero bytes produce 5 leading '1' characters", () => {
    const buf = Buffer.alloc(32);
    for (let i = 5; i < 32; i++) buf[i] = 0x42;
    const ref = new PublicKey(buf).toBase58();
    expect(inlineBase58(buf)).toBe(ref);
    expect(inlineBase58(buf).startsWith("11111")).toBe(true);
  });
});
