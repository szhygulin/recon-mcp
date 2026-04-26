/**
 * Unit tests for `extendRawDataExpiration` (issue #280).
 *
 * The function does a surgical splice on TRON's `raw_data_hex` protobuf:
 * locate field 8 (expiration varint) and replace its bytes so the new
 * value is `timestamp + offsetMs`. Recompute txID = sha256 of the new
 * bytes. The fixtures here are crafted to exercise:
 *   - The happy path: input has 60s expiration → extended to 24h.
 *   - The varint-length-change case: original expiration encodes in 3
 *     bytes (60_000), extended to ~86_400_000 which encodes in 4 bytes.
 *     The splice must handle the byte-length difference.
 *   - All other fields (ref_block, contract, fee_limit) ride through
 *     byte-exact.
 *   - txID is the canonical sha256 of the new bytes.
 *   - Missing field 8 throws.
 *   - Missing field 14 (timestamp) throws.
 *   - Out-of-range offsets reject (negative, > 24h).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  EXTENDED_EXPIRATION_MS,
  extendRawDataExpiration,
} from "../src/modules/tron/expiration.js";

/**
 * Build a minimal Transaction.raw protobuf:
 *   field 8  varint expiration
 *   field 11 bytes  contract (opaque payload)
 *   field 14 varint timestamp
 *   field 18 varint fee_limit (optional)
 *
 * Uses tag-then-value protobuf wire encoding. Returns the hex string.
 */
function encodeFixture(args: {
  expirationMs: bigint;
  contractBytes: Uint8Array;
  timestampMs: bigint;
  feeLimitSun?: bigint;
}): string {
  function writeVarint(n: bigint): number[] {
    const out: number[] = [];
    let v = n;
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      out.push(byte);
    } while (v > 0n);
    return out;
  }
  function writeTag(field: number, wire: number): number[] {
    return writeVarint(BigInt((field << 3) | wire));
  }
  const parts: number[] = [];
  parts.push(...writeTag(8, 0), ...writeVarint(args.expirationMs));
  parts.push(
    ...writeTag(11, 2),
    ...writeVarint(BigInt(args.contractBytes.length)),
    ...args.contractBytes,
  );
  parts.push(...writeTag(14, 0), ...writeVarint(args.timestampMs));
  if (args.feeLimitSun !== undefined) {
    parts.push(...writeTag(18, 0), ...writeVarint(args.feeLimitSun));
  }
  return Buffer.from(parts).toString("hex");
}

const TS_MS = 1_714_128_000_000n; // fixed timestamp for reproducibility
const ORIGINAL_EXPIRATION = TS_MS + 60_000n; // 60s — TronGrid default
const CONTRACT_PAYLOAD = Uint8Array.from([
  // 16 arbitrary bytes — the contract body is opaque to the extender,
  // we just want to verify it rides through byte-exact.
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10,
]);

describe("extendRawDataExpiration — happy path", () => {
  it("extends 60s expiration to 24h, keeps every other field byte-exact", () => {
    const original = encodeFixture({
      expirationMs: ORIGINAL_EXPIRATION,
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: TS_MS,
      feeLimitSun: 100_000_000n,
    });
    const extended = extendRawDataExpiration(original);
    // expirationMs is timestamp + 24h.
    expect(extended.expirationMs).toBe(
      Number(TS_MS) + EXTENDED_EXPIRATION_MS,
    );
    // txID is sha256 of new bytes.
    const expectedTxID = createHash("sha256")
      .update(Buffer.from(extended.rawDataHex, "hex"))
      .digest("hex");
    expect(extended.txID).toBe(expectedTxID);
    // Output must NOT equal input (extension actually fired).
    expect(extended.rawDataHex).not.toBe(original);
    // Every byte BEFORE field 8 + every byte AFTER field 8 must be
    // byte-exact (we only spliced the expiration varint). The simplest
    // way to assert this without re-implementing the protobuf walker
    // here: re-encode the same fixture with the new expiration value,
    // confirm that's what we got back.
    const reEncoded = encodeFixture({
      expirationMs: BigInt(extended.expirationMs),
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: TS_MS,
      feeLimitSun: 100_000_000n,
    });
    expect(extended.rawDataHex).toBe(reEncoded);
  });

  it("handles the varint-length-change case (3-byte → 4-byte)", () => {
    // 60_000 ms encodes as 3 varint bytes (0xe0 0xea 0x04 — wait no, depends
    // on TS-relative absolute value). What matters: TS+60_000 is roughly
    // 1.7T, encoded as varint 6-7 bytes; TS+24h is roughly 1.7T+86M ≈ same
    // 7-ish bytes. The varint-length-change is real but typically small.
    // Use a smaller timestamp to force a clear length change.
    const smallTs = 1n;
    const original = encodeFixture({
      expirationMs: smallTs + 60_000n, // ~3 bytes
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: smallTs,
    });
    const extended = extendRawDataExpiration(original);
    expect(extended.expirationMs).toBe(Number(smallTs) + EXTENDED_EXPIRATION_MS);
    // Decoded value matches; bytes differ in length (encoder produced
    // a longer varint for the larger value).
    expect(extended.rawDataHex.length).toBeGreaterThan(original.length);
  });

  it("accepts a custom offset within the protocol max", () => {
    const original = encodeFixture({
      expirationMs: TS_MS + 60_000n,
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: TS_MS,
    });
    const oneHourMs = 60 * 60 * 1000;
    const extended = extendRawDataExpiration(original, oneHourMs);
    expect(extended.expirationMs).toBe(Number(TS_MS) + oneHourMs);
  });
});

describe("extendRawDataExpiration — input validation", () => {
  it("rejects offsets ≤ 0", () => {
    const fixture = encodeFixture({
      expirationMs: TS_MS + 60_000n,
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: TS_MS,
    });
    expect(() => extendRawDataExpiration(fixture, 0)).toThrow(/positive/);
    expect(() => extendRawDataExpiration(fixture, -1)).toThrow(/positive/);
  });

  it("rejects offsets exceeding the 24h protocol max", () => {
    const fixture = encodeFixture({
      expirationMs: TS_MS + 60_000n,
      contractBytes: CONTRACT_PAYLOAD,
      timestampMs: TS_MS,
    });
    expect(() =>
      extendRawDataExpiration(fixture, EXTENDED_EXPIRATION_MS + 1),
    ).toThrow(/protocol max/);
  });

  it("throws when field 8 (expiration) is missing", () => {
    // Encode a minimal fixture WITHOUT field 8 — only contract + timestamp.
    // We can't reuse encodeFixture (it always emits field 8), so
    // hand-roll.
    const tagF11 = 11 << 3 | 2;
    const tagF14 = 14 << 3 | 0;
    const bytes = [
      tagF11, CONTRACT_PAYLOAD.length, ...CONTRACT_PAYLOAD,
      tagF14, ...encodeVarintLocal(TS_MS),
    ];
    const hex = Buffer.from(bytes).toString("hex");
    expect(() => extendRawDataExpiration(hex)).toThrow(
      /field 8 \(expiration\) not found/,
    );
  });

  it("throws when field 14 (timestamp) is missing", () => {
    const tagF8 = 8 << 3 | 0;
    const tagF11 = 11 << 3 | 2;
    const bytes = [
      tagF8, ...encodeVarintLocal(TS_MS + 60_000n),
      tagF11, CONTRACT_PAYLOAD.length, ...CONTRACT_PAYLOAD,
    ];
    const hex = Buffer.from(bytes).toString("hex");
    expect(() => extendRawDataExpiration(hex)).toThrow(
      /field 14 \(timestamp\) not found/,
    );
  });

  it("throws on malformed hex", () => {
    expect(() => extendRawDataExpiration("not-hex")).toThrow(/not valid hex/);
    expect(() => extendRawDataExpiration("0xabc")).toThrow(/not valid hex/); // odd length
  });
});

function encodeVarintLocal(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}
