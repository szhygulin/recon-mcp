/**
 * `get_ledger_device_info` — read-only probe of a directly-connected
 * Ledger's current app state. Sends the dashboard-level GET_APP_AND_VERSION
 * APDU (CLA=0xb0 INS=0x01) so we can answer "which app is open right now?"
 * before the user tries to pair. Lets the agent turn
 *
 *   "open the Solana app and enable blind-signing"
 *
 * into a context-aware hint like
 *
 *   "I see your Bitcoin app is open — switch to Solana (device →
 *   right button → Solana → both buttons)."
 *
 * which is what the broad-audience-onboarding plan (item 2.3) asks for.
 *
 * What's NOT returned (out of scope for v1):
 *   - Which apps are *installed* on the device. That requires either a
 *     Ledger Live internal API call or per-app enumeration via multiple
 *     hw-app-* instantiations — the plan flags this as needing a spike.
 *   - Per-app blind-sign state. `hw-app-solana`'s `getAppConfiguration()`
 *     returns it, but only when the Solana app is the one open — needs
 *     the app-specific wrapper, distinct code path from the dashboard
 *     APDU used here.
 */
import {
  openRawLedgerTransport,
  type RawLedgerTransport,
} from "../../signing/ledger-device-info-loader.js";

/**
 * Apps that ship with Ledger Live and return special dashboard-level
 * names rather than a chain label. If the current app's name matches
 * any of these, the device is on the dashboard (no user app running).
 */
const DASHBOARD_APP_NAMES = new Set(["BOLOS", "OS", "LedgerOS"]);

export interface LedgerDeviceInfo {
  /** Whether a Ledger USB HID transport could be opened right now. */
  deviceConnected: boolean;
  /** App name + version parsed from GET_APP_AND_VERSION. Absent iff
   * `deviceConnected` is false. */
  openApp?: {
    /** App name as the device reports it — "Solana", "Ethereum", "Tron",
     * "Bitcoin", or a dashboard alias like "BOLOS" / "OS". */
    name: string;
    /** App version string, e.g. "1.10.2". */
    version: string;
    /** True when the device is on the dashboard (no user app running). */
    isDashboard: boolean;
  };
  /** Actionable hint for the agent to relay. Always present on the
   * `deviceConnected: false` path; also set for dashboard + wrong-app
   * cases so the agent can surface concrete next steps. */
  hint?: string;
}

/**
 * Parse the raw GET_APP_AND_VERSION response (format 0x01). Response shape
 * documented in Ledger's BOLOS docs — the APDU is dashboard-level so works
 * whether the device is on the dashboard or an app is open.
 *
 *   [0]    format (1 for standard)
 *   [1]    name length N
 *   [2..]  N bytes of ASCII name
 *   [2+N]  version length M
 *   [...]  M bytes of ASCII version
 *   (optional flags byte + 1 byte flags)
 *   [-2,-1] SW1 SW2 (0x9000 on success)
 *
 * The trailing SW bytes are already stripped by the caller.
 */
export function parseAppAndVersionResponse(body: Buffer): {
  name: string;
  version: string;
} {
  if (body.length < 4) {
    throw new Error(
      `GET_APP_AND_VERSION response too short (${body.length} bytes)`,
    );
  }
  let pos = 0;
  // Skip format byte.
  pos += 1;
  const nameLen = body[pos++]!;
  if (pos + nameLen > body.length) {
    throw new Error(
      `GET_APP_AND_VERSION name length ${nameLen} exceeds body ${body.length}`,
    );
  }
  const name = body.slice(pos, pos + nameLen).toString("ascii");
  pos += nameLen;
  if (pos >= body.length) {
    throw new Error(
      `GET_APP_AND_VERSION response missing version-length byte`,
    );
  }
  const versionLen = body[pos++]!;
  if (pos + versionLen > body.length) {
    throw new Error(
      `GET_APP_AND_VERSION version length ${versionLen} exceeds body ${body.length}`,
    );
  }
  const version = body.slice(pos, pos + versionLen).toString("ascii");
  return { name, version };
}

/** Classify whether the app name represents the device dashboard rather
 * than a chain-specific user app. */
export function isDashboardApp(name: string): boolean {
  return DASHBOARD_APP_NAMES.has(name);
}

function buildHint(openApp: { name: string; isDashboard: boolean }): string | undefined {
  if (openApp.isDashboard) {
    return (
      "Device is on the dashboard (no app running). Open the app for the " +
      "chain you want to use — scroll with the side buttons, both buttons " +
      "to select. TRON / Solana apps need to be open to pair (USB HID); " +
      "Ledger Live handles EVM via WalletConnect without an on-device app."
    );
  }
  // Chain app is open — pass through the name so the agent can tailor
  // advice (e.g. "you need the Solana app but Bitcoin is open").
  return `${openApp.name} app is open on the device.`;
}

/** Translate a transport-open error into a user-friendly hint. */
function hintForOpenError(msg: string): string {
  if (/No such device|not found|no device/i.test(msg)) {
    return (
      "No Ledger detected over USB. Plug in the device, unlock it with " +
      "your PIN, and on Linux ensure Ledger udev rules are installed " +
      "(see `vaultpilot-mcp-setup` output or github.com/LedgerHQ/udev-rules)."
    );
  }
  if (/permission denied|EACCES/i.test(msg)) {
    return (
      "Permission denied opening the Ledger USB device. On Linux this is " +
      "usually missing udev rules — install via " +
      "`wget -q -O - https://raw.githubusercontent.com/LedgerHQ/udev-rules/master/add_udev_rules.sh | sudo bash`, " +
      "then replug the Ledger."
    );
  }
  if (/locked|LOCKED_DEVICE|0x5515/i.test(msg)) {
    return "Ledger detected but locked. Unlock the device with your PIN.";
  }
  return `Could not open Ledger transport: ${msg}`;
}

/**
 * Compute a one-line, error-message-appendable hint based on the current
 * device state, given the expected app name (e.g. `"Solana"`, `"Tron"`).
 *
 * Designed for catch-blocks in `pair_ledger_solana` / `pair_ledger_tron`
 * (and future signing flows) so a generic `mapLedgerError` message like
 * *"Ledger is connected but the Tron app isn't open"* can be enriched
 * with what's *actually* open right now: *"...your Bitcoin app is open
 * — switch to Tron."*
 *
 * Returns `undefined` (caller appends nothing) when:
 *   - The probe itself fails (no point making one error message about
 *     a different probe's failure).
 *   - The device isn't connected — `mapLedgerError` already handles
 *     that case with its own "plug in / unlock" guidance.
 *   - The expected app IS already open — the original error must be
 *     about something else (locked, USB glitch, …) and a "wrong app"
 *     hint would be misleading.
 *
 * Otherwise returns a single sentence describing what to do.
 */
export async function getDeviceStateHint(
  expectedApp: string,
): Promise<string | undefined> {
  let info: LedgerDeviceInfo;
  try {
    info = await getLedgerDeviceInfo();
  } catch {
    return undefined;
  }
  if (!info.deviceConnected || !info.openApp) return undefined;
  if (info.openApp.name === expectedApp) return undefined;
  if (info.openApp.isDashboard) {
    return (
      `Device is on the dashboard right now — open the ${expectedApp} ` +
      `app on-device (scroll with the side buttons, both buttons to select).`
    );
  }
  return (
    `Device probe says the ${info.openApp.name} app is open — switch to ` +
    `the ${expectedApp} app on-device (scroll with the side buttons, both ` +
    `buttons to select), then retry.`
  );
}

/**
 * Probe the currently-connected Ledger's app state. Opens a raw USB HID
 * transport, issues GET_APP_AND_VERSION, closes the transport. One USB
 * roundtrip; safe to call multiple times.
 */
export async function getLedgerDeviceInfo(
  _args: Record<string, never> = {},
): Promise<LedgerDeviceInfo> {
  let transport: RawLedgerTransport;
  try {
    transport = await openRawLedgerTransport();
  } catch (e) {
    return {
      deviceConnected: false,
      hint: hintForOpenError((e as Error).message ?? String(e)),
    };
  }
  try {
    const resp = await transport.send(0xb0, 0x01, 0x00, 0x00);
    // The last 2 bytes are SW1+SW2 — strip for the parse. hw-transport's
    // `send` already throws on non-0x9000 SW, so we don't need to inspect.
    const body = resp.slice(0, resp.length - 2);
    const { name, version } = parseAppAndVersionResponse(body);
    const dashboard = isDashboardApp(name);
    const openApp = { name, version, isDashboard: dashboard };
    return {
      deviceConnected: true,
      openApp,
      hint: buildHint(openApp),
    };
  } finally {
    await transport.close().catch(() => {
      // Ignore close-time errors — the probe already succeeded /
      // failed before we got here; surfacing a close error would mask
      // the real result.
    });
  }
}
