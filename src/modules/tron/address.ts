import { createHash } from "node:crypto";
import { isTronAddress } from "../../config/tron.js";

/**
 * Base58 alphabet used by Bitcoin, TRON, and most cryptocurrency address
 * schemes. Excludes visually-ambiguous characters (0, O, I, l).
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_INDEX.set(BASE58_ALPHABET[i], i);
}

/**
 * Decode a base58 string to raw bytes. Throws on invalid characters.
 * No checksum validation — that's the caller's responsibility (see
 * `base58ToHex` below which does the full base58check verify).
 */
function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();

  let num = 0n;
  for (const ch of s) {
    const idx = BASE58_INDEX.get(ch);
    if (idx === undefined) {
      throw new Error(`Invalid base58 character "${ch}"`);
    }
    num = num * 58n + BigInt(idx);
  }

  // bigint → bytes (big-endian)
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }

  // Leading "1"s in base58 correspond to leading zero bytes.
  let leadingOnes = 0;
  for (const ch of s) {
    if (ch === "1") leadingOnes++;
    else break;
  }
  const out = new Uint8Array(leadingOnes + bytes.length);
  out.set(bytes, leadingOnes);
  return out;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Decode a TRON base58 mainnet address to the 21-byte hex TRON form (prefix
 * 0x41 + 20 bytes of EVM-style address). Used as `owner_address`,
 * `to_address`, and `contract_address` in TronGrid POST bodies when
 * `visible: false` (hex mode).
 *
 * We always call TronGrid with `visible: true` (base58 pass-through), so
 * this function is primarily used for TRC-20 parameter encoding where the
 * ABI requires the 20-byte form stripped of the 0x41 prefix.
 *
 * Performs the full base58check verification (4-byte double-sha256 checksum
 * suffix) — throws on any tampering, including case changes and typos that
 * the charset regex would miss.
 */
export function base58ToHex(address: string): string {
  if (!isTronAddress(address)) {
    throw new Error(
      `"${address}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`
    );
  }
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(
      `Decoded TRON address must be 25 bytes (1 prefix + 20 addr + 4 checksum), got ${decoded.length}.`
    );
  }
  const payload = decoded.subarray(0, 21);
  const providedChecksum = decoded.subarray(21, 25);
  const expectedChecksum = sha256(sha256(payload)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (providedChecksum[i] !== expectedChecksum[i]) {
      throw new Error(
        `Checksum mismatch on TRON address "${address}" — possible typo or tampering.`
      );
    }
  }
  if (payload[0] !== 0x41) {
    throw new Error(
      `TRON mainnet addresses must have version byte 0x41 (got 0x${payload[0].toString(16)}).`
    );
  }
  return Buffer.from(payload).toString("hex");
}

/**
 * Encode the `transfer(address,uint256)` parameter payload for a TRC-20
 * call through TronGrid's /wallet/triggersmartcontract.
 *
 * Layout: two 32-byte words concatenated as hex (128 chars, no 0x prefix).
 *   Word 1: the recipient address, 20 bytes left-padded to 32.
 *           NB: stripped of the 0x41 TRON prefix — TRC-20 ABI uses the
 *           EVM 20-byte form so the contract can reuse the EIP-20 signature.
 *   Word 2: the amount as a big-endian uint256.
 */
export function encodeTrc20TransferParam(toBase58: string, amountSun: bigint): string {
  if (amountSun < 0n) throw new Error("TRC-20 transfer amount must be non-negative.");
  const toHex21 = base58ToHex(toBase58); // 42 hex chars, prefix 41
  const toHex20 = toHex21.slice(2); // strip the 0x41 version byte → 40 hex chars
  const addrWord = toHex20.padStart(64, "0");
  const amountWord = amountSun.toString(16).padStart(64, "0");
  return addrWord + amountWord;
}
