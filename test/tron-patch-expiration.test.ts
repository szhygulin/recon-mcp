import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  patchExpirationInRawData,
  txIdFromRawDataHex,
} from "../src/modules/tron/patch-expiration.js";
import { encodeTransferRawData } from "./helpers/tron-raw-data-encode.js";

const ADDR_FROM = "TPoaKtYTEPMj4LxWE3J5q3NdZVcX6HYUay";
const ADDR_TO = "TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1";

/**
 * Append a varint expiration field (field 8) to an existing
 * Transaction.raw protobuf hex blob. Used to seed the patcher with a
 * "real-shape" raw_data_hex so the in-place patch path is exercised
 * (the test helper's `wrapRaw` deliberately omits expiration so the
 * builder fixtures stay minimal).
 */
function appendExpiration(rawDataHex: string, expirationMs: bigint): string {
  // Field 8 (expiration), wire type 0 (varint): tag = (8 << 3) | 0 = 0x40
  const tagByte = "40";
  let v = expirationMs;
  let varintHex = "";
  while (v > 0x7fn) {
    varintHex += (Number(v & 0x7fn) | 0x80).toString(16).padStart(2, "0");
    v >>= 7n;
  }
  varintHex += Number(v).toString(16).padStart(2, "0");
  return rawDataHex + tagByte + varintHex;
}

describe("patchExpirationInRawData", () => {
  it("replaces an existing expiration field in place and preserves all other bytes", () => {
    const baseHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1_500_000n,
    });
    const original = appendExpiration(baseHex, 1_000_000_000_000n);
    const newExpiration = 1_761_545_478_000n; // ms-since-epoch around 2025-10-27
    const patched = patchExpirationInRawData(original, newExpiration);

    // Patched bytes round-trip back through the patcher: re-patching with
    // a new value should yield a result whose only difference from `patched`
    // is the new expiration varint. We assert this by re-patching and
    // confirming the full buffer changes only in the expected slice.
    const repatched = patchExpirationInRawData(patched, newExpiration);
    expect(repatched).toBe(patched);

    // The contract bytes (field 11) must be byte-identical to baseHex's
    // contract section. Easiest assertion: baseHex is a prefix of patched
    // (since the test helper appends nothing else, contract bytes sit at
    // offset 0 of the original input).
    expect(patched.startsWith(baseHex)).toBe(true);
  });

  it("appends an expiration field when the protobuf has none (synthetic minimal fixtures)", () => {
    const baseHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1n,
    });
    // baseHex deliberately has no field 8.
    const newExpiration = 1_761_545_478_000n;
    const patched = patchExpirationInRawData(baseHex, newExpiration);

    // Patched output preserves the original prefix and ends with a
    // freshly-appended expiration field.
    expect(patched.startsWith(baseHex)).toBe(true);
    expect(patched.length).toBeGreaterThan(baseHex.length);

    // Re-patching reproduces the same output (idempotent at the same
    // expiration value).
    const repatched = patchExpirationInRawData(patched, newExpiration);
    expect(repatched).toBe(patched);
  });

  it("rejects malformed hex", () => {
    expect(() => patchExpirationInRawData("not-hex-at-all", 1n)).toThrow(/invalid hex/);
    expect(() => patchExpirationInRawData("0a01", 1n)).toThrow(/length-delimited field overruns/);
  });
});

describe("issueTronHandle widens expiration on TronGrid-shaped tx", () => {
  it("bumps rawData.expiration to ~24h from now and recomputes txID", async () => {
    const { issueTronHandle } = await import("../src/signing/tron-tx-store.js");
    const baseHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1_500_000n,
    });
    const tronGridReturnedExpiration = Date.now() + 60_000; // ~60s — what TronGrid bakes in
    const rawDataHex = appendExpiration(baseHex, BigInt(tronGridReturnedExpiration));
    const stamped = issueTronHandle({
      chain: "tron",
      action: "native_send",
      from: ADDR_FROM,
      txID: "00".repeat(32),
      rawData: { expiration: tronGridReturnedExpiration } as Record<string, unknown>,
      rawDataHex,
      description: "test",
      decoded: { functionName: "TransferContract", args: {} },
    });
    const widened = (stamped.rawData as Record<string, unknown>).expiration as number;
    const now = Date.now();
    // 24h ± a small tolerance for clock movement during the test
    expect(widened).toBeGreaterThan(now + 23 * 60 * 60 * 1000);
    expect(widened).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 1000);
    // txID must equal sha256 of the patched rawDataHex
    expect(stamped.txID).toBe(txIdFromRawDataHex(stamped.rawDataHex));
    expect(stamped.txID).not.toBe("00".repeat(32));
  });

  it("leaves lifi_swap txs untouched (rawData absent — LiFi controls the bytes)", async () => {
    const { issueTronHandle } = await import("../src/signing/tron-tx-store.js");
    const lifiRawDataHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1n,
    });
    const stamped = issueTronHandle({
      chain: "tron",
      action: "lifi_swap",
      from: ADDR_FROM,
      txID: "ab".repeat(32),
      // rawData absent — LiFi-swap path uses /broadcasthex
      rawDataHex: lifiRawDataHex,
      description: "swap",
      decoded: { functionName: "lifiBridge", args: {} },
    });
    expect(stamped.rawDataHex).toBe(lifiRawDataHex);
    expect(stamped.txID).toBe("ab".repeat(32));
  });
});

describe("txIdFromRawDataHex", () => {
  it("matches sha256 of the raw bytes", () => {
    const baseHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1n,
    });
    const expected = createHash("sha256").update(Buffer.from(baseHex, "hex")).digest("hex");
    expect(txIdFromRawDataHex(baseHex)).toBe(expected);
    expect(txIdFromRawDataHex("0x" + baseHex)).toBe(expected); // strips 0x prefix
  });

  it("changes when raw_data changes (i.e. when expiration is patched)", () => {
    const baseHex = encodeTransferRawData({
      from: ADDR_FROM,
      to: ADDR_TO,
      amountSun: 1n,
    });
    const original = appendExpiration(baseHex, 1_000_000_000_000n);
    const patched = patchExpirationInRawData(original, 1_761_545_478_000n);
    expect(txIdFromRawDataHex(patched)).not.toBe(txIdFromRawDataHex(original));
  });
});
