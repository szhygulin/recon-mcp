/**
 * Tests for `get_ledger_device_info`. The raw-transport loader is mocked at
 * module boundary so no USB device is actually needed — we feed synthetic
 * GET_APP_AND_VERSION responses and exercise every classification branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseAppAndVersionResponse,
  isDashboardApp,
} from "../src/modules/diagnostics/ledger-device-info.js";

const openRawLedgerTransport = vi.fn();

vi.mock("../src/signing/ledger-device-info-loader.js", () => ({
  openRawLedgerTransport: (...args: unknown[]) =>
    openRawLedgerTransport(...args),
}));

beforeEach(() => {
  openRawLedgerTransport.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a GET_APP_AND_VERSION response Buffer in the standard-format
 * shape the parser expects. Includes the trailing SW bytes (0x90 0x00
 * = success) that the runtime sees from `transport.send()`. */
function buildResponse(appName: string, version: string): Buffer {
  const nameBytes = Buffer.from(appName, "ascii");
  const versionBytes = Buffer.from(version, "ascii");
  return Buffer.concat([
    Buffer.from([0x01]), // format byte
    Buffer.from([nameBytes.length]),
    nameBytes,
    Buffer.from([versionBytes.length]),
    versionBytes,
    Buffer.from([0x90, 0x00]), // SW1 SW2 = success
  ]);
}

describe("parseAppAndVersionResponse", () => {
  it("extracts name + version from a well-formed body (no SW bytes)", () => {
    const resp = buildResponse("Solana", "1.10.2");
    // Strip SW for the direct parse test — the runtime strips them too.
    const body = resp.slice(0, resp.length - 2);
    expect(parseAppAndVersionResponse(body)).toEqual({
      name: "Solana",
      version: "1.10.2",
    });
  });

  it("handles dashboard responses (BOLOS / OS)", () => {
    for (const appName of ["BOLOS", "OS"]) {
      const resp = buildResponse(appName, "2.2.0");
      const body = resp.slice(0, resp.length - 2);
      expect(parseAppAndVersionResponse(body)).toEqual({
        name: appName,
        version: "2.2.0",
      });
    }
  });

  it("throws when nameLen exceeds the body it claims to span", () => {
    // 4 bytes (passes the min-length gate) but nameLen=5 > remaining body.
    expect(() =>
      parseAppAndVersionResponse(Buffer.from([0x01, 0x05, 0x41, 0x42])),
    ).toThrow(/name length 5 exceeds body/);
  });

  it("throws when response is too short for even a format + name-length header", () => {
    expect(() => parseAppAndVersionResponse(Buffer.from([0x01]))).toThrow(
      /too short/,
    );
  });
});

describe("isDashboardApp", () => {
  it("matches BOLOS / OS / LedgerOS", () => {
    expect(isDashboardApp("BOLOS")).toBe(true);
    expect(isDashboardApp("OS")).toBe(true);
    expect(isDashboardApp("LedgerOS")).toBe(true);
  });
  it("does NOT match chain app names", () => {
    for (const app of ["Solana", "Ethereum", "Bitcoin", "Tron"]) {
      expect(isDashboardApp(app)).toBe(false);
    }
  });
});

describe("getLedgerDeviceInfo (integration with mocked transport)", () => {
  it("returns the open chain app name + version + non-dashboard flag", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockResolvedValue(buildResponse("Solana", "1.10.2")),
      close,
    });
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.deviceConnected).toBe(true);
    expect(info.openApp).toEqual({
      name: "Solana",
      version: "1.10.2",
      isDashboard: false,
    });
    expect(info.hint).toContain("Solana app is open");
    expect(close).toHaveBeenCalledOnce();
  });

  it("flags the dashboard state with a specific hint", async () => {
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockResolvedValue(buildResponse("BOLOS", "2.2.0")),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.openApp?.isDashboard).toBe(true);
    expect(info.hint).toMatch(/on the dashboard/i);
  });

  it("returns deviceConnected:false when the transport cannot open (no Ledger detected)", async () => {
    openRawLedgerTransport.mockRejectedValue(new Error("No such device"));
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.deviceConnected).toBe(false);
    expect(info.openApp).toBeUndefined();
    expect(info.hint).toMatch(/No Ledger detected/i);
  });

  it("returns a permission-hint on EACCES (udev rules missing)", async () => {
    openRawLedgerTransport.mockRejectedValue(
      new Error("open /dev/hidraw5: permission denied (EACCES)"),
    );
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.deviceConnected).toBe(false);
    expect(info.hint).toMatch(/udev rules/i);
    expect(info.hint).toMatch(/add_udev_rules\.sh/);
  });

  it("returns the locked hint on LOCKED_DEVICE / 0x5515", async () => {
    openRawLedgerTransport.mockRejectedValue(
      new Error("Ledger device: LOCKED_DEVICE (0x5515)"),
    );
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.deviceConnected).toBe(false);
    expect(info.hint).toMatch(/locked/i);
  });

  it("closes the transport even if send() throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error("USB glitch")),
      close,
    });
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    await expect(getLedgerDeviceInfo()).rejects.toThrow(/USB glitch/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("swallows close() errors so they don't mask the real result", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(buildResponse("Ethereum", "1.13.0"));
    openRawLedgerTransport.mockResolvedValue({
      send,
      close: vi.fn().mockRejectedValue(new Error("close glitch")),
    });
    const { getLedgerDeviceInfo } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const info = await getLedgerDeviceInfo();
    expect(info.deviceConnected).toBe(true);
    expect(info.openApp?.name).toBe("Ethereum");
  });
});

describe("getDeviceStateHint (error-message enrichment)", () => {
  it("returns undefined when the device isn't connected — mapLedgerError already handles it", async () => {
    openRawLedgerTransport.mockRejectedValue(new Error("No such device"));
    const { getDeviceStateHint } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    expect(await getDeviceStateHint("Solana")).toBeUndefined();
  });

  it("returns undefined when the expected app is already open", async () => {
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockResolvedValue(buildResponse("Solana", "1.10.2")),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { getDeviceStateHint } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    expect(await getDeviceStateHint("Solana")).toBeUndefined();
  });

  it("returns a 'switch app' hint when a different chain app is open", async () => {
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockResolvedValue(buildResponse("Bitcoin", "2.3.0")),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { getDeviceStateHint } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const hint = await getDeviceStateHint("Solana");
    expect(hint).toContain("Bitcoin app is open");
    expect(hint).toContain("switch to");
    expect(hint).toContain("Solana");
  });

  it("returns a 'dashboard' hint when the device is on the dashboard", async () => {
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockResolvedValue(buildResponse("BOLOS", "2.2.0")),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { getDeviceStateHint } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    const hint = await getDeviceStateHint("Tron");
    expect(hint).toMatch(/on the dashboard/i);
    expect(hint).toContain("Tron");
  });

  it("returns undefined silently when the probe itself throws (no error-on-error)", async () => {
    openRawLedgerTransport.mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error("USB busy")),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { getDeviceStateHint } = await import(
      "../src/modules/diagnostics/ledger-device-info.js"
    );
    expect(await getDeviceStateHint("Solana")).toBeUndefined();
  });
});
