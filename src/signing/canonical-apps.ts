/**
 * Canonical Ledger app version manifest.
 *
 * Ships as part of the device-trust verification roadmap (issue #325, P2):
 * before forwarding any signing request, the MCP confirms the open Ledger
 * app's reported version is at or above a hardcoded floor. Catches:
 *   - Downgrade attacks against vulnerable plugin / parser versions
 *   - Rogue community apps whose `getAppConfiguration` /
 *     `getAppAndVersion` reports a version below any known-good Ledger
 *     release (e.g. forks that haven't shipped a tagged release yet)
 *
 * Misses (out-of-scope here, see the issue's "What CANNOT be added"):
 *   - Tampered apps reporting the canonical name + version but containing
 *     different binary — the SE's app-authentication at install time
 *     covers this. P1 (SE attestation challenge) would shrink the gap.
 *   - Novel Ledger app versions released faster than we update this
 *     table. Mitigation: bump `minVersion` when a vuln in a plugin
 *     forces a floor; otherwise leave the floor at the oldest version
 *     we've actually verified parses our PSBTs correctly.
 *
 * Maintenance: when a new Ledger app version ships, add it to
 * `knownGood`. When a version contains a security fix worth forcing the
 * user to upgrade past, raise `minVersion` to that release. Both are
 * surfaced in operator-visible warnings (knownGood) or hard refusals
 * (minVersion) at every signing call site.
 *
 * The four entries below cover every USB-direct chain in this server.
 * EVM chains route through Ledger Live over WalletConnect; the MCP
 * cannot reach the SE directly there, so app-version verification is
 * delegated to whatever genuine-check Ledger Live performed at
 * connect time. See issue #325 P5 for a complementary check on the WC
 * peer side.
 */

export interface CanonicalAppEntry {
  /**
   * Lower bound on `<major>.<minor>.<patch>`. Refuse to sign when the
   * device reports a version strictly below this. Cumulative — bump
   * when a vuln forces upgrade past a release.
   */
  minVersion: string;
  /**
   * Versions explicitly verified as compatible with this MCP's PSBT /
   * tx encoding. Versions ≥ `minVersion` but absent from `knownGood`
   * trigger an operator-visible warning (logged to stderr) instead of a
   * refusal — letting users adopt fresh Ledger releases without a
   * server release first, while still capturing telemetry on what's
   * out there.
   */
  knownGood: readonly string[];
}

/**
 * Canonical app manifest. Names match exactly what the Ledger device
 * reports in `getAppAndVersion().name` (BTC/LTC dashboard call) or are
 * implied by which app-class APDU the signer opens (Solana/TRON, where
 * the device returns 0x6E00 if a different app is open).
 *
 * Bitcoin Test / BTC are accepted aliases for "Bitcoin" — older Ledger
 * BTC app forks reported these synonyms.
 */
export const CANONICAL_LEDGER_APPS: Readonly<Record<string, CanonicalAppEntry>> = {
  Bitcoin: {
    // BTC app < 2.1.0 lacks wallet-policy support and PSBT v0/v2 nuances
    // we depend on (issue #213 nonWitnessUtxo enforcement). 2.4.0 is the
    // floor where issue #213 + #254 + #264 are all behaviorally stable.
    minVersion: "2.4.0",
    knownGood: ["2.4.6", "2.4.11"],
  },
  Litecoin: {
    // Same SDK as Bitcoin app; same floor logic.
    minVersion: "2.4.0",
    knownGood: ["2.4.11"],
  },
  Solana: {
    // Solana app < 1.10.0 lacks the `signOffchainMessage` APDU we use
    // for Off-Chain Signing (Marinade unstake-immediate, etc).
    minVersion: "1.10.0",
    knownGood: ["1.12.1", "1.12.2"],
  },
  Tron: {
    // Tron app < 0.7.0 has known integer-overflow bugs in the freeze-v2
    // parser (TRON Stake 2.0); 0.7.0 is the first version that decodes
    // freeze-v2 + delegate-resource correctly on-screen.
    minVersion: "0.7.0",
    knownGood: ["0.7.4", "0.7.5"],
  },
};

/**
 * Aliases the device may report for each canonical app. Some firmware
 * versions / forks report short codes ("BTC", "LTC") or `Test`-suffixed
 * names; treat them all as the canonical entry.
 */
const APP_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Bitcoin: ["Bitcoin", "Bitcoin Test", "BTC"],
  Litecoin: ["Litecoin", "Litecoin Test", "LTC"],
  // Solana / TRON only ever report their canonical name (the API class
  // gates on it), but we list them for completeness so adding aliases
  // here is the only edit needed.
  Solana: ["Solana"],
  Tron: ["Tron"],
};

/** Resolve a device-reported app name to a canonical entry key, or null. */
function resolveCanonicalKey(reportedName: string): string | null {
  for (const [canonical, aliases] of Object.entries(APP_NAME_ALIASES)) {
    if (aliases.includes(reportedName)) return canonical;
  }
  return null;
}

/**
 * Compare two `<major>.<minor>.<patch>` strings. Missing components
 * coerce to 0; non-numeric segments coerce to 0 (worst-case, fails
 * the floor check rather than crashing). Returns -1 / 0 / 1.
 */
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
 * Operator-visible warning logger. Tests stub this via the exported
 * `_setCanonicalAppWarnHook` so they can assert warning emission
 * without polluting test output.
 */
type WarnHook = (message: string) => void;
let warnHook: WarnHook = (msg) => {
  console.warn(msg);
};

/** Test hook: override the warning emitter. Returns the previous hook. */
export function _setCanonicalAppWarnHook(hook: WarnHook): WarnHook {
  const prev = warnHook;
  warnHook = hook;
  return prev;
}

export interface AssertCanonicalAppArgs {
  /**
   * Name as reported by the device (BTC/LTC dashboard call returns
   * this; for Solana/TRON pass the chain key directly — the API class
   * already gates on the open app via APDU CLA mismatch).
   */
  reportedName: string;
  /** Version string from the device. */
  reportedVersion: string;
  /**
   * Optional whitelist of canonical names this signer accepts. Lets
   * BTC signers accept "Bitcoin" / "Bitcoin Test" / "BTC" while
   * refusing if the device somehow reports a different chain's app.
   * Pass `["Bitcoin"]` for BTC signers, `["Solana"]` for Solana, etc.
   * When omitted, ANY canonical app is accepted (used by neutral
   * pairing / status flows).
   */
  expectedNames?: readonly string[];
}

/**
 * Validate a Ledger app name + version against the canonical manifest.
 * Throws on:
 *   - Reported name not in the manifest
 *   - Reported name not in `expectedNames` (when provided)
 *   - Reported version below `minVersion`
 *
 * Emits a warn-level log when the version is at-or-above the floor but
 * not in `knownGood` — operator visibility for fresh releases that
 * passed install-time auth on the device but haven't been folded into
 * this MCP's manifest yet. Lets users adopt the fresh release without
 * waiting for a server bump.
 */
export function assertCanonicalLedgerApp(args: AssertCanonicalAppArgs): void {
  const { reportedName, reportedVersion, expectedNames } = args;
  const canonicalKey = resolveCanonicalKey(reportedName);
  if (canonicalKey === null) {
    throw new Error(
      `Ledger reports the open app as "${reportedName}" v${reportedVersion}, ` +
        `which is not a known Ledger app. Refusing to sign — install the official ` +
        `Ledger app for this chain via Ledger Live (Manager) and retry.`,
    );
  }
  if (expectedNames && expectedNames.length > 0) {
    if (!expectedNames.includes(canonicalKey)) {
      throw new Error(
        `Ledger reports the open app as "${reportedName}" v${reportedVersion}, ` +
          `but this signing flow expected one of: ${expectedNames.join(", ")}. ` +
          `Open the correct app on the device and retry.`,
      );
    }
  }
  const entry = CANONICAL_LEDGER_APPS[canonicalKey];
  if (!entry) {
    // Type-guard belt-and-suspenders: resolveCanonicalKey returned a
    // key that isn't in the manifest. Should be impossible.
    throw new Error(
      `Internal error: canonicalKey "${canonicalKey}" missing from CANONICAL_LEDGER_APPS.`,
    );
  }
  if (compareSemver(reportedVersion, entry.minVersion) < 0) {
    throw new Error(
      `Ledger ${canonicalKey} app v${reportedVersion} is below the minimum supported ` +
        `version ${entry.minVersion}. Update via Ledger Live (Manager) and retry. ` +
        `Older versions may have parser bugs or known security issues that the floor ` +
        `is set to enforce upgrade past.`,
    );
  }
  if (!entry.knownGood.includes(reportedVersion)) {
    warnHook(
      `[vaultpilot] Ledger ${canonicalKey} app v${reportedVersion} is at or above the ` +
        `minimum (${entry.minVersion}) but is not on the known-good list ` +
        `(${entry.knownGood.join(", ")}). Proceeding; consider opening an issue at ` +
        `https://github.com/szhygulin/vaultpilot-mcp/issues so the manifest can be updated.`,
    );
  }
}
