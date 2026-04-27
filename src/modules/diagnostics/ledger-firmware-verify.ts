/**
 * `verify_ledger_firmware` — issue #325 P3.
 *
 * Reads the connected Ledger's Secure Element firmware version via
 * the dashboard-only `getDeviceInfo` APDU, asserts it matches a
 * canonical manifest of known-good Ledger releases, returns the
 * parsed info plus a verdict. Caller is the user (typically once per
 * device, at first-pair time or after an OS update); not invoked
 * automatically from any signing flow because the APDU requires the
 * device to be in dashboard mode (no app open) — folding it into
 * signing flows would force a "close app → verify → re-open app"
 * dance on every signature.
 *
 * Threat model addressed:
 *   - Downgrade attack via factory-reset / re-flash to a firmware
 *     version with publicly disclosed CVEs
 *   - Counterfeit / cloned hardware reporting a target_id outside
 *     Ledger's known device-class set
 *
 * NOT addressed (covered by P1 SE-attestation, deferred):
 *   - Device reporting a canonical version + targetId but running
 *     malicious-but-Ledger-signed code installed via a dev-mode
 *     override
 *   - Full SE compromise where the firmware-version response is
 *     fabricated by an attacker who controls the SE
 *
 * UX flow:
 *   1. User unplugs + replugs the Ledger, OR closes any open app
 *      (returns to dashboard menu)
 *   2. Agent calls `verify_ledger_firmware`
 *   3. Tool returns { status, deviceModel, seVersion, mcuVersion,
 *      targetId, ... } — agent surfaces the verdict to the user
 *   4. On `status: "below-floor"`, the user must update via Ledger
 *      Live Manager before any signing flows succeed.
 *   5. On `status: "warn"`, the firmware is at-or-above floor but
 *      not in our known-good list (likely a fresh Ledger release we
 *      haven't manifest-bumped yet). Surface but proceed.
 */
import { getLedgerFirmwareInfo } from "../../signing/dashboard-info.js";
import {
  assertCanonicalLedgerFirmware,
  CANONICAL_LEDGER_FIRMWARE,
  type FirmwareVerdict,
} from "../../signing/canonical-firmware.js";

export interface VerifyLedgerFirmwareResult {
  /**
   *   - "verified" — firmware is in our known-good list
   *   - "warn" — firmware is at-or-above the per-model floor but not
   *     in known-good (proceed but surface to user)
   *   - "below-floor" — firmware is below the supported floor; refuse
   *     signing flows until the user upgrades
   *   - "unknown-device" — target_id doesn't match any known Ledger
   *     device class
   *   - "no-device" — no Ledger detected over USB HID
   *   - "wrong-mode" — device is connected but an app is open (need
   *     to close apps before retrying)
   *   - "error" — unexpected failure; `errorMessage` carries the
   *     details for the agent to relay
   */
  status:
    | "verified"
    | "warn"
    | "below-floor"
    | "unknown-device"
    | "no-device"
    | "wrong-mode"
    | "error";
  /** 4-byte target_id, hex (when device responded). */
  targetId?: string;
  /** Resolved device model — "nanoSP" / "nanoX" / "stax" / "flex" / "unknown". */
  deviceModel?: string;
  /** SE firmware version, e.g. "2.4.2" (when device responded). */
  seVersion?: string;
  /** MCU bootloader version, e.g. "2.61" (when device responded). */
  mcuVersion?: string;
  /** Hex-encoded BOLOS device flags (4 bytes; onboarded / PIN-set / etc). */
  flagsHex?: string;
  /** Human-readable verdict line for the agent to surface to the user. */
  message: string;
  /** When status === "warn" or "below-floor": expected canonical floor. */
  expectedMinSeVersion?: string;
  /** When status === "verified" or "warn": the model's `knownGood` list. */
  knownGood?: readonly string[];
  /** Raw error message on `status: "error"`. */
  errorMessage?: string;
}

export async function verifyLedgerFirmware(): Promise<VerifyLedgerFirmwareResult> {
  let info;
  try {
    info = await getLedgerFirmwareInfo();
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/an app is open|dashboard cla|cla not supported|ins not supported/i.test(message)) {
      return {
        status: "wrong-mode",
        message:
          "Connected Ledger has an app open. Close every Ledger app (back to the " +
          "dashboard / home menu) and retry — firmware verification only works in " +
          "dashboard mode.",
      };
    }
    if (/no.+device|cannot open device|no such file/i.test(message)) {
      return {
        status: "no-device",
        message:
          "No Ledger device detected over USB. Plug in the Ledger, unlock it with " +
          "your PIN, and retry. Make sure no other app (Ledger Live, Sparrow, etc.) " +
          "is holding the USB transport.",
      };
    }
    return {
      status: "error",
      message: `Failed to read firmware info: ${message}`,
      errorMessage: message,
    };
  }

  const { targetId, deviceModel, seVersion, mcuVersion, flagsHex } = info;
  // Unknown target_id never reaches the assertion (the assertion
  // throws, but we want to return a structured "unknown-device" result
  // here, not propagate the throw to the caller as an error status).
  if (deviceModel === "unknown") {
    return {
      status: "unknown-device",
      targetId,
      deviceModel,
      seVersion,
      mcuVersion,
      flagsHex,
      message:
        `Connected device's target_id 0x${targetId} doesn't match any known Ledger ` +
        `model. The device may be too new for this MCP version (try updating), a ` +
        `discontinued model (Nano S legacy), or counterfeit.`,
    };
  }

  let verdict: FirmwareVerdict;
  try {
    verdict = assertCanonicalLedgerFirmware({ deviceModel, seVersion });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const entry = CANONICAL_LEDGER_FIRMWARE[deviceModel];
    return {
      status: "below-floor",
      targetId,
      deviceModel,
      seVersion,
      mcuVersion,
      flagsHex,
      expectedMinSeVersion: entry.minSeVersion,
      knownGood: entry.knownGood,
      message,
    };
  }

  const entry = CANONICAL_LEDGER_FIRMWARE[deviceModel];
  if (verdict.status === "warn") {
    return {
      status: "warn",
      targetId,
      deviceModel,
      seVersion,
      mcuVersion,
      flagsHex,
      expectedMinSeVersion: entry.minSeVersion,
      knownGood: entry.knownGood,
      message: verdict.reason,
    };
  }
  return {
    status: "verified",
    targetId,
    deviceModel,
    seVersion,
    mcuVersion,
    flagsHex,
    knownGood: entry.knownGood,
    message:
      `${entry.label} SE firmware v${seVersion} matches canonical manifest. ` +
      `MCU v${mcuVersion}, target_id 0x${targetId}.`,
  };
}
