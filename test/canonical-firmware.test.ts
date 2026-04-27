import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CANONICAL_LEDGER_FIRMWARE,
  assertCanonicalLedgerFirmware,
  _setCanonicalFirmwareWarnHook,
} from "../src/signing/canonical-firmware.ts";

/**
 * Unit tests for the canonical firmware manifest (issue #325 P3).
 * Pure — no transport, no parser.
 */

let warnings: string[] = [];
let restoreWarnHook: ReturnType<typeof _setCanonicalFirmwareWarnHook>;

beforeEach(() => {
  warnings = [];
  restoreWarnHook = _setCanonicalFirmwareWarnHook((msg) => {
    warnings.push(msg);
  });
});

afterEach(() => {
  _setCanonicalFirmwareWarnHook(restoreWarnHook);
});

describe("assertCanonicalLedgerFirmware — accept", () => {
  it("returns 'verified' for a known-good Nano S Plus firmware", () => {
    const verdict = assertCanonicalLedgerFirmware({
      deviceModel: "nanoSP",
      seVersion: "1.1.1",
    });
    expect(verdict.status).toBe("verified");
    expect(warnings).toEqual([]);
  });

  it("returns 'verified' for known-good Nano X / Stax / Flex firmware", () => {
    const cases = [
      { deviceModel: "nanoX" as const, seVersion: "2.2.3" },
      { deviceModel: "stax" as const, seVersion: "1.5.0" },
      { deviceModel: "flex" as const, seVersion: "1.0.0" },
    ];
    for (const { deviceModel, seVersion } of cases) {
      const verdict = assertCanonicalLedgerFirmware({ deviceModel, seVersion });
      expect(verdict.status).toBe("verified");
    }
  });
});

describe("assertCanonicalLedgerFirmware — refuse", () => {
  it("throws on `unknown` device model", () => {
    expect(() =>
      assertCanonicalLedgerFirmware({
        deviceModel: "unknown",
        seVersion: "1.0.0",
      }),
    ).toThrow(/does not match any known Ledger model/);
  });

  it("throws when seVersion is below the floor", () => {
    expect(() =>
      assertCanonicalLedgerFirmware({
        deviceModel: "nanoSP",
        seVersion: "1.0.5",
      }),
    ).toThrow(/below the minimum supported version 1\.1\.0/);
  });

  it("throws when Nano X firmware is below the 2.2.0 floor", () => {
    expect(() =>
      assertCanonicalLedgerFirmware({
        deviceModel: "nanoX",
        seVersion: "2.0.5",
      }),
    ).toThrow(/below the minimum supported version 2\.2\.0/);
  });
});

describe("assertCanonicalLedgerFirmware — warn-but-accept", () => {
  it("warns when seVersion is at-or-above floor but not in knownGood", () => {
    const verdict = assertCanonicalLedgerFirmware({
      deviceModel: "nanoSP",
      seVersion: "1.3.0",
    });
    expect(verdict.status).toBe("warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not on the known-good list/);
  });

  it("does not warn for an explicit known-good entry", () => {
    const verdict = assertCanonicalLedgerFirmware({
      deviceModel: "nanoSP",
      seVersion: "1.1.0",
    });
    expect(verdict.status).toBe("verified");
    expect(warnings).toEqual([]);
  });
});

describe("CANONICAL_LEDGER_FIRMWARE shape", () => {
  it("covers every modern Ledger device class", () => {
    expect(Object.keys(CANONICAL_LEDGER_FIRMWARE).sort()).toEqual([
      "flex",
      "nanoSP",
      "nanoX",
      "stax",
    ]);
  });

  it("every entry has minSeVersion + ≥1 knownGood + label", () => {
    for (const [model, entry] of Object.entries(CANONICAL_LEDGER_FIRMWARE)) {
      expect(entry.minSeVersion, `${model} minSeVersion`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.knownGood.length, `${model} knownGood`).toBeGreaterThanOrEqual(1);
      expect(entry.label.length, `${model} label`).toBeGreaterThan(0);
    }
  });
});
