import { createHash } from "node:crypto";

/**
 * Extend a TRON `raw_data_hex` envelope's `expiration` field client-side.
 *
 * Issue #280. TronGrid's `/wallet/createtransaction` (and the trigger /
 * freeze / unfreeze / vote / claim siblings) stamps `raw_data.expiration`
 * server-side from its `defaultExpirationTime` config — typically 60s
 * after `timestamp`. That window is too tight for the
 * prepare → CHECKS PERFORMED display → user verifies → Ledger
 * character-walk → broadcast loop, especially for fresh recipients
 * where the user is supposed to verify the recipient address
 * character-by-character on-device. Live evidence: a 5,929 USDT send
 * round-tripped over the 60s ceiling on multiple consecutive attempts.
 *
 * TronGrid's HTTP surface doesn't accept an `expiration` parameter,
 * so we extend client-side: surgically replace field 8's varint in the
 * protobuf-encoded `raw_data_hex`, recompute the `txID =
 * sha256(raw_data_hex)`, and update the JSON `raw_data.expiration`
 * mirror. The extended bytes still pass `assertTronRawDataMatches`
 * (which checks contract type / addresses / amounts / fee_limit, not
 * timing).
 *
 * Why 24h is safe:
 *
 *   - Protocol max: TRON spec permits `expiration` up to 24h after
 *     `timestamp`. Full nodes accept and broadcast within this window.
 *   - Natural decay via ref_block: `ref_block_bytes` + `ref_block_hash`
 *     bind the tx to a specific recent block; these naturally
 *     invalidate as the chain advances past the reference window
 *     (~24h). Practical liveness is gated by ref_block, not by the
 *     explicit expiration field. Setting expiration to 24h matches
 *     what ref_block already enforces.
 *   - Replay: TRON txs include the txID hash; once mined they can't be
 *     replayed. A signed-but-unbroadcast tx with a longer window is no
 *     different from any other off-chain signed payload — same
 *     security model the user already accepts.
 *   - Handle TTL is independent: the MCP's own 15-minute single-use
 *     handle still applies; this only relaxes the on-chain field.
 */

/**
 * 24 hours in milliseconds — TRON protocol max for the
 * `expiration` field measured from `timestamp`.
 */
export const EXTENDED_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Wire-format primitives for surgically replacing field 8 in a
 * Transaction.raw protobuf envelope.
 *
 * Transaction.raw fields the encoder needs to know about:
 *
 *   1   ref_block_bytes      bytes        wireType 2
 *   4   ref_block_hash       bytes        wireType 2
 *   8   expiration           int64        wireType 0   ← target
 *   11  contract             repeated     wireType 2
 *   14  timestamp            int64        wireType 0
 *   18  fee_limit            int64 opt    wireType 0
 *
 * We don't decode the contract content — only locate field 8's start
 * + end byte offsets to splice. Other fields ride through unchanged.
 */

function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let next = offset;
  for (;;) {
    if (next >= buf.length) {
      throw new Error("TRON expiration extend: truncated varint");
    }
    const b = buf[next++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) {
      throw new Error("TRON expiration extend: varint overflow");
    }
  }
  return { value: result, next };
}

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error("TRON expiration extend: negative varint not supported");
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("TRON expiration extend: raw_data_hex is not valid hex");
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function bytesToHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

/**
 * Locate field 8 (expiration, varint) in a Transaction.raw protobuf
 * buffer. Returns `{ tagOffset, bodyOffset, endOffset, value }` where:
 *   - tagOffset: byte index of the 1-byte field tag (always 0x40 for
 *     field 8 wire type 0).
 *   - bodyOffset: byte index where the varint payload starts (= tagOffset + 1).
 *   - endOffset: byte index just past the varint (= bodyOffset + varint.length).
 *   - value: decoded expiration as bigint (ms since epoch).
 *
 * Throws if field 8 is missing — every TRON transaction we build has
 * an expiration set by TronGrid, so absence is malformed input.
 */
function locateField8(buf: Uint8Array): {
  tagOffset: number;
  bodyOffset: number;
  endOffset: number;
  value: bigint;
} {
  let offset = 0;
  while (offset < buf.length) {
    const tagStart = offset;
    const { value: tag, next } = readVarint(buf, offset);
    offset = next;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (fieldNum === 8) {
      if (wireType !== 0) {
        throw new Error(
          `TRON expiration extend: field 8 wire type ${wireType}, expected 0 (varint)`,
        );
      }
      const v = readVarint(buf, offset);
      return {
        tagOffset: tagStart,
        bodyOffset: offset,
        endOffset: v.next,
        value: v.value,
      };
    }
    // Skip this field's body.
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      offset = v.next;
    } else if (wireType === 2) {
      const l = readVarint(buf, offset);
      offset = l.next;
      const len = Number(l.value);
      if (offset + len > buf.length) {
        throw new Error(
          "TRON expiration extend: length-delimited field overruns buffer",
        );
      }
      offset += len;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(
        `TRON expiration extend: unsupported wire type ${wireType}`,
      );
    }
  }
  throw new Error(
    "TRON expiration extend: field 8 (expiration) not found in raw_data_hex",
  );
}

export interface ExtendedTronTx {
  /** Updated protobuf bytes as a hex string (no 0x prefix). */
  rawDataHex: string;
  /** Recomputed txID — sha256(rawDataHex). Hex string, no prefix. */
  txID: string;
  /** New expiration value (ms since epoch). */
  expirationMs: number;
}

/**
 * Surgically extend the `expiration` field of a TRON Transaction.raw
 * envelope to `timestamp + EXTENDED_EXPIRATION_MS` (or the value
 * passed in `expirationMs`, capped to the protocol max).
 *
 * Why surgical splice rather than full re-encode: the protobuf carries
 * fields we don't fully decode (the contract body is itself a nested
 * message that varies per contract type — TransferContract /
 * TriggerSmartContract / FreezeBalanceV2Contract / etc.). Re-encoding
 * the whole message means re-encoding every contract type. Splicing
 * one varint preserves every other byte of the original TronGrid
 * response — including any future fields TronGrid adds that our
 * decoder doesn't know about.
 *
 * The new expiration is computed from the existing `timestamp` field
 * (also a varint at field 14) plus the requested offset. We re-read
 * `timestamp` rather than calling `Date.now()` so the math matches
 * what's in the protobuf — TronGrid stamps `timestamp` and
 * `expiration` together, and the user/Ledger sees them both.
 */
export function extendRawDataExpiration(
  rawDataHex: string,
  expirationOffsetMs: number = EXTENDED_EXPIRATION_MS,
): ExtendedTronTx {
  if (!Number.isFinite(expirationOffsetMs) || expirationOffsetMs <= 0) {
    throw new Error(
      `TRON expiration extend: expirationOffsetMs must be a positive finite number, got ${expirationOffsetMs}`,
    );
  }
  if (expirationOffsetMs > EXTENDED_EXPIRATION_MS) {
    throw new Error(
      `TRON expiration extend: requested ${expirationOffsetMs} ms exceeds protocol max ${EXTENDED_EXPIRATION_MS} ms (24h)`,
    );
  }
  const buf = hexToBytes(rawDataHex);
  const f8 = locateField8(buf);
  // Read timestamp (field 14, wire type 0). It's somewhere in the
  // buffer — we don't care about its position, just its value.
  const timestampMs = readField14Timestamp(buf);
  const newExpirationMs = timestampMs + BigInt(expirationOffsetMs);

  const newVarint = encodeVarint(newExpirationMs);
  const out = new Uint8Array(
    buf.length - (f8.endOffset - f8.bodyOffset) + newVarint.length,
  );
  // Prefix (everything up to and including the field tag).
  out.set(buf.subarray(0, f8.bodyOffset), 0);
  // New varint body.
  out.set(newVarint, f8.bodyOffset);
  // Suffix (everything after the old varint body).
  out.set(buf.subarray(f8.endOffset), f8.bodyOffset + newVarint.length);

  const txID = createHash("sha256").update(out).digest("hex");
  return {
    rawDataHex: bytesToHex(out),
    txID,
    expirationMs: Number(newExpirationMs),
  };
}

/**
 * Read field 14 (timestamp, wire type 0 / varint) from the buffer.
 * Throws if missing — every TRON transaction we build has a
 * timestamp set by TronGrid.
 */
function readField14Timestamp(buf: Uint8Array): bigint {
  let offset = 0;
  while (offset < buf.length) {
    const { value: tag, next } = readVarint(buf, offset);
    offset = next;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (fieldNum === 14 && wireType === 0) {
      const v = readVarint(buf, offset);
      return v.value;
    }
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      offset = v.next;
    } else if (wireType === 2) {
      const l = readVarint(buf, offset);
      offset = l.next;
      const len = Number(l.value);
      offset += len;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(
        `TRON expiration extend: unsupported wire type ${wireType}`,
      );
    }
  }
  throw new Error(
    "TRON expiration extend: field 14 (timestamp) not found in raw_data_hex",
  );
}
