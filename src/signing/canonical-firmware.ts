import type { LedgerDeviceModel } from "./dashboard-info.js";

/**
 * Canonical Ledger firmware manifest (issue #325 P3). Mirrors the
 * shape of `canonical-apps.ts` but keyed by hardware model: the
 * `seVersion` reported by the dashboard `getDeviceInfo` APDU varies
 * per device (Nano S Plus / Nano X / Stax / Flex each have their own
 * firmware track).
 *
 * Same maintenance pattern as the app manifest:
 *   - Bump `minSeVersion` when a vuln in the SE firmware forces an
 *     upgrade past a release (refusal — hard gate).
 *   - Add new releases to `knownGood` as Ledger ships them (warning
 *     when a version is at-or-above the floor but not in knownGood,
 *     so users can adopt fresh releases without a server bump).
 *
 * What this catches:
 *   - Downgrade attacks against firmware versions with known CVEs
 *   - Devices whose firmware is so old we can't reasonably claim
 *     compatibility with our PSBT / message-signing flows
 *
 * What this misses (covered by P1 SE-attestation, deferred):
 *   - Cloned hardware reporting a canonical version + targetId
 *   - SE running a malicious-but-Ledger-signed app installed via
 *     a dev-mode override
 *   - Novel firmware zero-days
 *
 * Floor rationale: Ledger has shipped consolidated security fixes in
 * the early-2024 releases for each device family (Nano S Plus 1.1.0,
 * Nano X 2.2.0, Stax 1.5.0, Flex 1.0.0). Lower than that and we'd be
 * accepting devices with publicly-disclosed transport-layer issues.
 * Verify against the Ledger Security Bulletins page when a fresh
 * release lands.
 */

export interface CanonicalFirmwareEntry {
  /** Lower bound on `seVersion` (Secure Element firmware). */
  minSeVersion: string;
  /** Versions explicitly verified against this MCP's flows. */
  knownGood: readonly string[];
  /** User-friendly device label for error messages. */
  label: string;
}

export const CANONICAL_LEDGER_FIRMWARE: Readonly<
  Record<Exclude<LedgerDeviceModel, "unknown">, CanonicalFirmwareEntry>
> = {
  nanoSP: {
    minSeVersion: "1.1.0",
    knownGood: ["1.1.0", "1.1.1", "1.2.0"],
    label: "Nano S Plus",
  },
  nanoX: {
    minSeVersion: "2.2.0",
    knownGood: ["2.2.1", "2.2.3", "2.4.0"],
    label: "Nano X",
  },
  stax: {
    minSeVersion: "1.5.0",
    knownGood: ["1.5.0", "1.5.1"],
    label: "Stax",
  },
  flex: {
    minSeVersion: "1.0.0",
    knownGood: ["1.0.0", "1.0.1"],
    label: "Flex",
  },
};

function compareSemver(a: string, b: string): number {
  const parse = (s: string): [number, number, number] => {
    const parts = s.split(".").map((n) => {
      const v = parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Operator-visible warning logger. Tests stub via the exported hook.
 */
type WarnHook = (message: string) => void;
let warnHook: WarnHook = (msg) => {
  console.warn(msg);
};

export function _setCanonicalFirmwareWarnHook(hook: WarnHook): WarnHook {
  const prev = warnHook;
  warnHook = hook;
  return prev;
}

export type FirmwareVerdict =
  | { status: "verified"; deviceModel: LedgerDeviceModel; seVersion: string }
  | {
      status: "warn";
      deviceModel: LedgerDeviceModel;
      seVersion: string;
      reason: string;
    };

export interface AssertCanonicalFirmwareArgs {
  deviceModel: LedgerDeviceModel;
  seVersion: string;
}

/**
 * Validate a device's reported firmware against the canonical manifest.
 *
 *   - `unknown` device model → throw (we don't have a floor for it,
 *     and accepting silently would defeat the check's purpose)
 *   - `seVersion` below `minSeVersion` → throw
 *   - `seVersion` ≥ floor but absent from `knownGood` → warn-and-return
 *     a "warn" verdict (lets users adopt fresh releases without
 *     waiting for a manifest bump)
 *   - Otherwise → return a "verified" verdict
 */
export function assertCanonicalLedgerFirmware(
  args: AssertCanonicalFirmwareArgs,
): FirmwareVerdict {
  const { deviceModel, seVersion } = args;
  if (deviceModel === "unknown") {
    throw new Error(
      `Device's target_id does not match any known Ledger model. The device may ` +
        `be too new for this MCP version, a discontinued model (Nano S legacy), ` +
        `or a counterfeit. Refusing to mark firmware verified.`,
    );
  }
  const entry = CANONICAL_LEDGER_FIRMWARE[deviceModel];
  if (compareSemver(seVersion, entry.minSeVersion) < 0) {
    throw new Error(
      `Ledger ${entry.label} SE firmware v${seVersion} is below the minimum ` +
        `supported version ${entry.minSeVersion}. Update via Ledger Live ` +
        `(Manager) and retry. Older firmware may have publicly-disclosed CVEs ` +
        `or transport-layer issues; the floor enforces upgrade past them.`,
    );
  }
  if (!entry.knownGood.includes(seVersion)) {
    const reason =
      `${entry.label} SE firmware v${seVersion} is at or above the minimum ` +
      `(${entry.minSeVersion}) but not on the known-good list ` +
      `(${entry.knownGood.join(", ")}). Proceeding; consider opening an issue ` +
      `at https://github.com/szhygulin/vaultpilot-mcp/issues so the manifest ` +
      `can be updated.`;
    warnHook(`[vaultpilot] ${reason}`);
    return { status: "warn", deviceModel, seVersion, reason };
  }
  return { status: "verified", deviceModel, seVersion };
}
