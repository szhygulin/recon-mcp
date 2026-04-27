import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration tests for the `verify_ledger_firmware` tool. Mocks the
 * raw transport loader so we can exercise every status branch
 * (verified / warn / below-floor / unknown-device / wrong-mode /
 * no-device / error) without touching real hardware.
 */

function buildResponse({
  targetId,
  seVersion,
  flags = "00000000",
  mcuVersion,
}: {
  targetId: string;
  seVersion: string;
  flags?: string;
  mcuVersion: string;
}): Buffer {
  const tid = Buffer.from(targetId, "hex");
  const sev = Buffer.from(seVersion, "ascii");
  const flg = Buffer.from(flags, "hex");
  const mcv = Buffer.from(mcuVersion, "ascii");
  return Buffer.concat([
    Buffer.from([tid.length]),
    tid,
    Buffer.from([sev.length]),
    sev,
    Buffer.from([flg.length]),
    flg,
    Buffer.from([mcv.length]),
    mcv,
  ]);
}

beforeEach(() => {
  vi.resetModules();
});

function mockTransport(behavior: () => Promise<Buffer>) {
  vi.doMock("../src/signing/ledger-device-info-loader.js", () => ({
    openRawLedgerTransport: async () => ({
      send: vi.fn(behavior),
      close: vi.fn(async () => {}),
    }),
  }));
}

function mockTransportThatThrows(error: Error) {
  vi.doMock("../src/signing/ledger-device-info-loader.js", () => ({
    openRawLedgerTransport: async () => {
      throw error;
    },
  }));
}

describe("verifyLedgerFirmware", () => {
  it("returns 'verified' for a known-good Nano S Plus firmware", async () => {
    mockTransport(async () =>
      buildResponse({
        targetId: "31100004",
        seVersion: "1.1.1",
        mcuVersion: "4.04",
      }),
    );
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("verified");
    expect(out.deviceModel).toBe("nanoSP");
    expect(out.seVersion).toBe("1.1.1");
    expect(out.mcuVersion).toBe("4.04");
    expect(out.targetId).toBe("31100004");
    expect(out.message).toMatch(/Nano S Plus.*1\.1\.1.*matches/);
  });

  it("returns 'warn' when version is at-or-above floor but not in knownGood", async () => {
    mockTransport(async () =>
      buildResponse({
        targetId: "31100004",
        seVersion: "1.3.0",
        mcuVersion: "4.04",
      }),
    );
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("warn");
    expect(out.seVersion).toBe("1.3.0");
    expect(out.knownGood).toBeDefined();
    expect(out.expectedMinSeVersion).toBe("1.1.0");
    expect(out.message).toMatch(/not on the known-good list/);
  });

  it("returns 'below-floor' when SE firmware is below the floor", async () => {
    mockTransport(async () =>
      buildResponse({
        targetId: "31100004",
        seVersion: "1.0.5",
        mcuVersion: "4.04",
      }),
    );
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("below-floor");
    expect(out.expectedMinSeVersion).toBe("1.1.0");
    expect(out.seVersion).toBe("1.0.5");
    expect(out.message).toMatch(/below the minimum/);
  });

  it("returns 'unknown-device' for an unrecognized target_id", async () => {
    mockTransport(async () =>
      buildResponse({
        targetId: "31100002", // legacy Nano S
        seVersion: "2.0.0",
        mcuVersion: "1.0",
      }),
    );
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("unknown-device");
    expect(out.targetId).toBe("31100002");
    expect(out.deviceModel).toBe("unknown");
  });

  it("returns 'wrong-mode' when an app is open (CLA not supported)", async () => {
    mockTransport(async () => {
      throw new Error("Ledger device: CLA not supported (0x6E00)");
    });
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("wrong-mode");
    expect(out.message).toMatch(/Close every Ledger app/);
  });

  it("returns 'no-device' when the transport can't open", async () => {
    mockTransportThatThrows(
      new Error("cannot open device /dev/hidraw0: No such file or directory"),
    );
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("no-device");
    expect(out.message).toMatch(/No Ledger device detected/);
  });

  it("returns 'error' for unexpected transport failures", async () => {
    mockTransport(async () => {
      throw new Error("unknown protocol error 0x9999");
    });
    const { verifyLedgerFirmware } = await import(
      "../src/modules/diagnostics/ledger-firmware-verify.js"
    );
    const out = await verifyLedgerFirmware();
    expect(out.status).toBe("error");
    expect(out.errorMessage).toMatch(/0x9999/);
  });
});
