import { createHash } from "node:crypto";

/**
 * Patch the `expiration` field of a TronGrid `raw_data_hex` protobuf in
 * place. TronGrid's REST endpoints (createtransaction, triggersmartcontract,
 * freezebalancev2, votewitnessaccount, …) bake in a ~60-second expiration
 * by default — too tight for the prepare → CHECKS PERFORMED display →
 * user reads → Ledger character-walk → broadcast loop. The TRON protocol
 * permits expiration up to 24h after `timestamp`, so we widen it before
 * issuing the handle.
 *
 * Why patch the wire bytes instead of building raw_data ourselves: TronGrid's
 * trigger/createtransaction endpoints embed builder logic we don't want to
 * reproduce (energy estimation, ref-block selection, contract-type framing).
 * Patching one varint after the fact is the minimum-blast-radius change.
 *
 * Issue #280.
 */

/**
 * Wire-format tag byte for Transaction.raw field 8 (expiration, varint int64):
 *   tag = (fieldNum << 3) | wireType = (8 << 3) | 0 = 0x40
 *
 * This is the byte we scan for at the top level of Transaction.raw to
 * locate the expiration varint that follows.
 */
const EXPIRATION_FIELD_TAG = 8;

interface VarintRead {
  value: bigint;
  bytes: number;
}

function readVarint(buf: Uint8Array, offset: number): VarintRead {
  let result = 0n;
  let shift = 0n;
  let i = 0;
  for (;;) {
    if (offset + i >= buf.length) throw new Error("patchExpirationInRawData: truncated varint");
    const b = buf[offset + i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("patchExpirationInRawData: varint overflow");
  }
  return { value: result, bytes: i };
}

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("patchExpirationInRawData: negative varint");
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(stripped) || stripped.length % 2 !== 0) {
    throw new Error("patchExpirationInRawData: invalid hex");
  }
  const buf = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(stripped.substr(i * 2, 2), 16);
  }
  return buf;
}

function bytesToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Replace the expiration varint in a Transaction.raw protobuf wire-form
 * blob. Returns the new hex (no `0x` prefix); the caller can re-derive
 * `txID = sha256(newRawDataHex)`.
 *
 * Walks the wire format at the top level only — expiration is always a
 * top-level field of Transaction.raw, never nested inside Contract or
 * auths. For each field we decode tag, skip the payload based on wire
 * type, and continue until we hit field 8.
 */
export function patchExpirationInRawData(
  rawDataHex: string,
  newExpirationMs: bigint,
): string {
  const buf = hexToBytes(rawDataHex);
  let offset = 0;
  while (offset < buf.length) {
    const tagRead = readVarint(buf, offset);
    offset += tagRead.bytes;
    const fieldNum = Number(tagRead.value >> 3n);
    const wireType = Number(tagRead.value & 0x7n);

    if (fieldNum === EXPIRATION_FIELD_TAG && wireType === 0) {
      const oldVarint = readVarint(buf, offset);
      const newVarint = encodeVarint(newExpirationMs);
      const out = new Uint8Array(buf.length - oldVarint.bytes + newVarint.length);
      out.set(buf.subarray(0, offset), 0);
      out.set(newVarint, offset);
      out.set(buf.subarray(offset + oldVarint.bytes), offset + newVarint.length);
      return bytesToHex(out);
    }

    // Skip this field's payload based on wire type.
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      offset += v.bytes;
    } else if (wireType === 2) {
      const lenRead = readVarint(buf, offset);
      offset += lenRead.bytes + Number(lenRead.value);
      if (offset > buf.length) {
        throw new Error("patchExpirationInRawData: length-delimited field overruns buffer");
      }
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`patchExpirationInRawData: unsupported wire type ${wireType}`);
    }
  }
  // Field 8 absent — append it. Protobuf wire format permits fields in any
  // order, so concatenating at the end is valid. This path is unreachable
  // for real TronGrid responses (which always set expiration) but lets the
  // patcher handle minimally-shaped synthetic protobuf inputs without
  // forcing every test fixture to include the field.
  const expirationTagByte = (EXPIRATION_FIELD_TAG << 3) | 0;
  const newVarint = encodeVarint(newExpirationMs);
  const out = new Uint8Array(buf.length + 1 + newVarint.length);
  out.set(buf, 0);
  out[buf.length] = expirationTagByte;
  out.set(newVarint, buf.length + 1);
  return bytesToHex(out);
}

/**
 * Recompute txID from a (possibly patched) raw_data_hex. TronGrid's txID is
 * the lowercase hex of `sha256(raw_data_bytes)` — same convention used by
 * the TRON node when computing Transaction.id.
 */
export function txIdFromRawDataHex(rawDataHex: string): string {
  const buf = hexToBytes(rawDataHex);
  return createHash("sha256").update(buf).digest("hex");
}
