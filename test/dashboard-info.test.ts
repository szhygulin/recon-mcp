import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseDashboardInfo,
  deviceModelFromTargetId,
} from "../src/signing/dashboard-info.ts";

/**
 * Unit tests for the dashboard `getDeviceInfo` APDU parser + the
 * device-model lookup. The end-to-end transport flow is tested via
 * `verify_ledger_firmware` integration tests.
 */

/**
 * Build a synthetic getDeviceInfo response with the BOLOS layout:
 *   target_id_len(1) | target_id(N) | se_ver_len(1) | se_ver(M) |
 *   flags_len(1)     | flags(F)     | mcu_ver_len(1)| mcu_ver(K)
 */
function buildResponse({
  targetId,
  seVersion,
  flags,
  mcuVersion,
  trailing = Buffer.alloc(0),
}: {
  targetId: Buffer;
  seVersion: string;
  flags: Buffer;
  mcuVersion: string;
  trailing?: Buffer;
}): Buffer {
  const seBytes = Buffer.from(seVersion, "ascii");
  const mcuBytes = Buffer.from(mcuVersion, "ascii");
  return Buffer.concat([
    Buffer.from([targetId.length]),
    targetId,
    Buffer.from([seBytes.length]),
    seBytes,
    Buffer.from([flags.length]),
    flags,
    Buffer.from([mcuBytes.length]),
    mcuBytes,
    trailing,
  ]);
}

describe("deviceModelFromTargetId", () => {
  it("maps known target_ids to model names", () => {
    expect(deviceModelFromTargetId("31100003")).toBe("nanoX");
    expect(deviceModelFromTargetId("31100004")).toBe("nanoSP");
    expect(deviceModelFromTargetId("33000004")).toBe("stax");
    expect(deviceModelFromTargetId("33100004")).toBe("flex");
  });

  it("returns 'unknown' for unrecognized target_ids", () => {
    expect(deviceModelFromTargetId("31100002")).toBe("unknown"); // legacy Nano S
    expect(deviceModelFromTargetId("00000000")).toBe("unknown");
    expect(deviceModelFromTargetId("ffffffff")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(deviceModelFromTargetId("31100003")).toBe("nanoX");
    expect(deviceModelFromTargetId("31100003".toUpperCase())).toBe("nanoX");
  });
});

describe("parseDashboardInfo", () => {
  it("parses a Nano S Plus response", () => {
    const resp = buildResponse({
      targetId: Buffer.from("31100004", "hex"),
      seVersion: "1.1.0",
      flags: Buffer.from("00000000", "hex"),
      mcuVersion: "4.04",
    });
    const info = parseDashboardInfo(resp);
    expect(info.targetId).toBe("31100004");
    expect(info.deviceModel).toBe("nanoSP");
    expect(info.seVersion).toBe("1.1.0");
    expect(info.mcuVersion).toBe("4.04");
    expect(info.flagsHex).toBe("00000000");
  });

  it("strips a null terminator from mcuVersion", () => {
    const resp = buildResponse({
      targetId: Buffer.from("31100003", "hex"),
      seVersion: "2.2.3",
      flags: Buffer.from("01020304", "hex"),
      mcuVersion: "2.61\0",
    });
    const info = parseDashboardInfo(resp);
    expect(info.mcuVersion).toBe("2.61");
  });

  it("tolerates trailing bytes (mcu_hash on newer firmware)", () => {
    const resp = buildResponse({
      targetId: Buffer.from("33000004", "hex"),
      seVersion: "1.5.0",
      flags: Buffer.from("00000000", "hex"),
      mcuVersion: "5.12",
      trailing: Buffer.alloc(32, 0xab), // simulated mcu_hash
    });
    const info = parseDashboardInfo(resp);
    expect(info.deviceModel).toBe("stax");
    expect(info.seVersion).toBe("1.5.0");
  });

  it("returns 'unknown' deviceModel for unrecognized target_id", () => {
    const resp = buildResponse({
      targetId: Buffer.from("ffffffff", "hex"),
      seVersion: "1.0.0",
      flags: Buffer.from("00000000", "hex"),
      mcuVersion: "1.0",
    });
    const info = parseDashboardInfo(resp);
    expect(info.deviceModel).toBe("unknown");
  });

  it("throws on a truncated response", () => {
    const truncated = Buffer.from([0x04, 0x31, 0x10, 0x00]); // target_id_len=4 but only 3 bytes
    expect(() => parseDashboardInfo(truncated)).toThrow(/too short|truncated/);
  });

  it("throws on a length prefix that overflows the buffer", () => {
    // Bytes ≥ 8 (passes the initial too-short guard) but the
    // target_id_len byte (100) far exceeds the remaining buffer.
    const malformed = Buffer.concat([
      Buffer.from([100]),
      Buffer.alloc(10, 0xab),
    ]);
    expect(() => parseDashboardInfo(malformed)).toThrow(/truncated/);
  });
});

describe("getLedgerFirmwareInfo (transport branch)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parses a real-shape response from a mocked transport", async () => {
    const sendMock = vi.fn(async () =>
      buildResponse({
        targetId: Buffer.from("31100004", "hex"),
        seVersion: "1.1.1",
        flags: Buffer.from("00000000", "hex"),
        mcuVersion: "4.04",
      }),
    );
    const closeMock = vi.fn(async () => {});
    vi.doMock("../src/signing/ledger-device-info-loader.js", () => ({
      openRawLedgerTransport: async () => ({
        send: sendMock,
        close: closeMock,
      }),
    }));
    const { getLedgerFirmwareInfo } = await import(
      "../src/signing/dashboard-info.ts"
    );
    const info = await getLedgerFirmwareInfo();
    expect(info.deviceModel).toBe("nanoSP");
    expect(info.seVersion).toBe("1.1.1");
    // Transport closed exactly once.
    expect(closeMock).toHaveBeenCalledTimes(1);
    // APDU sent with the right CLA/INS.
    expect(sendMock).toHaveBeenCalledWith(0xe0, 0x01, 0x00, 0x00);
  });

  it("translates 0x6E00 (CLA not supported) into a 'close apps' hint", async () => {
    const sendMock = vi.fn(async () => {
      throw new Error("Ledger device: CLA not supported (0x6E00)");
    });
    const closeMock = vi.fn(async () => {});
    vi.doMock("../src/signing/ledger-device-info-loader.js", () => ({
      openRawLedgerTransport: async () => ({
        send: sendMock,
        close: closeMock,
      }),
    }));
    const { getLedgerFirmwareInfo } = await import(
      "../src/signing/dashboard-info.ts"
    );
    await expect(getLedgerFirmwareInfo()).rejects.toThrow(
      /Cannot read firmware info while an app is open/,
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("propagates other transport errors verbatim", async () => {
    const sendMock = vi.fn(async () => {
      throw new Error("Ledger device: unknown error 0x6F00");
    });
    const closeMock = vi.fn(async () => {});
    vi.doMock("../src/signing/ledger-device-info-loader.js", () => ({
      openRawLedgerTransport: async () => ({
        send: sendMock,
        close: closeMock,
      }),
    }));
    const { getLedgerFirmwareInfo } = await import(
      "../src/signing/dashboard-info.ts"
    );
    await expect(getLedgerFirmwareInfo()).rejects.toThrow(/0x6F00/);
  });
});
