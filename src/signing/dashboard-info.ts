import { openRawLedgerTransport } from "./ledger-device-info-loader.js";

/**
 * Dashboard-mode APDU helpers — read the device's Secure Element and
 * MCU firmware version directly from the BOLOS dashboard. Used by the
 * `verify_ledger_firmware` tool (issue #325 P3).
 *
 * The `getDeviceInfo` APDU (`CLA=0xE0, INS=0x01, P1=0x00, P2=0x00`)
 * works ONLY when the device is in dashboard mode (no app open). With
 * any chain-app open, the device returns `0x6E00` / `0x6D00` (CLA not
 * supported). This is why firmware verification can't be inlined into
 * signing flows the way app-version pinning is — it requires the user
 * to actively close apps and run the verification as a discrete step.
 *
 * Response shape (per Ledger BOLOS spec; tolerant to trailing bytes
 * because newer firmware tacks on additional metadata):
 *
 *   target_id_length    (1 byte; expected = 4)
 *   target_id           (4 bytes BE — encodes device model)
 *   se_version_length   (1 byte)
 *   se_version          (ASCII, e.g. "2.4.2")
 *   flags_length        (1 byte; expected = 4)
 *   flags               (4 bytes — onboarded/PIN-set/etc)
 *   mcu_version_length  (1 byte)
 *   mcu_version         (ASCII, null-terminated; e.g. "2.61\0")
 *   [optional] mcu_hash (32 bytes, present on newer firmware)
 *
 * `target_id` is a 4-byte device-class identifier maintained by Ledger.
 * Mapping below covers every modern Ledger; legacy Nano S (target_id
 * 0x31100002) is intentionally absent because Ledger has discontinued
 * security updates for it.
 */

export type LedgerDeviceModel = "nanoSP" | "nanoX" | "stax" | "flex" | "unknown";

const TARGET_ID_TO_MODEL: Readonly<Record<string, LedgerDeviceModel>> = {
  "31100003": "nanoX",
  "31100004": "nanoSP",
  "33000004": "stax",
  "33100004": "flex",
};

export function deviceModelFromTargetId(targetIdHex: string): LedgerDeviceModel {
  return TARGET_ID_TO_MODEL[targetIdHex.toLowerCase()] ?? "unknown";
}

export interface LedgerFirmwareInfo {
  /** 4-byte target ID, hex (lowercase, no `0x`). */
  targetId: string;
  /** Resolved device model. `unknown` for unrecognized target IDs. */
  deviceModel: LedgerDeviceModel;
  /** Secure Element firmware version, e.g. "2.4.2". */
  seVersion: string;
  /** MCU bootloader version, e.g. "2.61". */
  mcuVersion: string;
  /** 4-byte flags hex (BOLOS device flags — onboarded / PIN-set / etc). */
  flagsHex: string;
}

/**
 * Parse the raw response bytes from `CLA=0xE0 INS=0x01`. Tolerates
 * trailing bytes (mcu_hash on newer firmware) and unexpected component
 * lengths (validates ≤ remaining-length rather than == expected, so a
 * future firmware that grows a field doesn't blow up the parser).
 */
export function parseDashboardInfo(buf: Buffer): LedgerFirmwareInfo {
  if (buf.length < 8) {
    throw new Error(
      `getDeviceInfo response too short (${buf.length} bytes) — expected ≥ 8.`,
    );
  }
  let i = 0;
  const readLengthPrefixed = (label: string): Buffer => {
    if (i >= buf.length) {
      throw new Error(`getDeviceInfo response truncated reading ${label} length.`);
    }
    const len = buf[i++];
    if (i + len > buf.length) {
      throw new Error(
        `getDeviceInfo response truncated reading ${label} (need ${len} bytes, ` +
          `${buf.length - i} remaining).`,
      );
    }
    const slice = buf.subarray(i, i + len);
    i += len;
    return slice;
  };
  const targetIdBytes = readLengthPrefixed("target_id");
  const seVersionBytes = readLengthPrefixed("se_version");
  const flagsBytes = readLengthPrefixed("flags");
  const mcuVersionBytes = readLengthPrefixed("mcu_version");

  const targetId = targetIdBytes.toString("hex");
  const seVersion = seVersionBytes.toString("ascii");
  // mcu_version is sometimes null-terminated; strip a trailing 0x00.
  const mcuVersionRaw = mcuVersionBytes.toString("ascii");
  const mcuVersion = mcuVersionRaw.replace(/\0+$/, "");
  const flagsHex = flagsBytes.toString("hex");

  return {
    targetId,
    deviceModel: deviceModelFromTargetId(targetId),
    seVersion,
    mcuVersion,
    flagsHex,
  };
}

/**
 * Open a USB transport, issue the dashboard `getDeviceInfo` APDU,
 * close the transport, return the parsed firmware info.
 *
 * Throws with a user-friendly hint when the APDU is rejected because
 * an app is open (the device returns `0x6D00` / `0x6E00` / `0x6511`
 * depending on the open app and firmware version). The user should
 * close all apps before retrying — only the BOLOS dashboard exposes
 * this APDU.
 */
export async function getLedgerFirmwareInfo(): Promise<LedgerFirmwareInfo> {
  const transport = await openRawLedgerTransport();
  try {
    const response = await transport.send(0xe0, 0x01, 0x00, 0x00);
    // The @ledgerhq transport class strips the 2-byte status word on
    // success (0x9000 = OK) and throws on non-9000, so what we receive
    // here is the data payload only.
    return parseDashboardInfo(response);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // The device returns 0x6D00 / 0x6E00 / 0x6511 for "wrong CLA" /
    // "INS not supported" / "wrong INS for current state" — all of
    // which point at "an app is open and dashboard CLA is rejected."
    if (
      /0x6d00|0x6e00|0x6511|cla not supported|ins not supported/i.test(message)
    ) {
      throw new Error(
        `Cannot read firmware info while an app is open on the device. ` +
          `Close every Ledger app (return to the dashboard menu — usually ` +
          `the gear / "Open" cancellation) and retry. The dashboard CLA ` +
          `(0xE0/0x01) only responds in dashboard mode.`,
      );
    }
    throw err;
  } finally {
    await transport.close().catch(() => {});
  }
}
