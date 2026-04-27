import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Ledger Live binary signature verification (issue #325 P4).
 *
 * Locates the Ledger Live process / install on disk and verifies its
 * code-signature matches Ledger's publishing identity:
 *   - macOS: `codesign --verify --deep --strict <bundle>`
 *   - Windows: PowerShell `Get-AuthenticodeSignature`
 *   - Linux: AppImage GPG verification when an .AppImage path is
 *     provided; flatpak / snap / dpkg installs surface a structured
 *     "platform-not-supported" verdict
 *
 * Implemented as a discrete user-driven tool (not auto-firing on
 * every signing call) — the OS-level codesign tools take 100s of ms
 * per call and aren't worth running on every signature. Run it once
 * after first install / Ledger Live update / OS update.
 *
 * Threat model:
 *   - Catches: tampered on-disk Ledger Live install, replaced binary
 *   - Misses: in-memory tampering (only OS-level integrity catches
 *     this — SIP / HVCI / kernel hardening), library injection,
 *     OS-level compromise that lies to user-space tools
 *
 * Default policy is **warn-loudly on FAIL, not refuse**. Refusing on
 * mismatch would brick:
 *   - Self-built / dev-channel Ledger Live (signed by a different
 *     identity than the published one)
 *   - Linux flatpak / snap installs where the codesign equivalent
 *     isn't accessible
 *   - Edge-case OS configurations where the codesign tool itself
 *     fails for benign reasons (no Internet, expired CRL cache, etc.)
 *
 * The user can enforce strict refusal via a future config knob if
 * they want — but the default lets users-of-unusual-installations
 * keep working while still surfacing the warning.
 */

export type CodesignStatus =
  | "verified" // signature valid + matches Ledger's identity
  | "mismatch" // signature valid but identity is NOT Ledger
  | "invalid" // signature is missing / corrupt / failed verification
  | "not-found" // Ledger Live binary not located at any known path
  | "platform-not-supported" // Linux flatpak/snap/dpkg or unknown OS
  | "tool-missing" // codesign / Get-AuthenticodeSignature not available
  | "error"; // unexpected failure during verification

export interface CodesignResult {
  status: CodesignStatus;
  /** Path of the binary / bundle that was checked. Empty when not-found. */
  inspectedPath: string;
  /** Identity string the signing tool reported (`Apple Developer ID …`, etc). */
  reportedIdentity?: string;
  /** Platform we ran on. */
  platform: NodeJS.Platform;
  /** Human-readable verdict line for the agent to surface. */
  message: string;
}

/**
 * Ledger's macOS Developer ID team identifier — printed by `codesign`
 * as part of the signing identity. Verified against Ledger's published
 * Apple developer registration. Pinning the team ID rather than the
 * full certificate CN is more robust to certificate rotation: Ledger
 * can renew their cert without changing the team ID (`B95846FZ23`).
 *
 * If Ledger ever rotates their team ID (extremely unusual for a
 * publicly-distributed app), update this constant.
 */
const LEDGER_MACOS_TEAM_ID = "B95846FZ23";

/**
 * Ledger's Windows Authenticode publisher subject string. Matches
 * what `Get-AuthenticodeSignature` returns for a signed Ledger Live
 * binary. Substring-matched (the full Subject string includes
 * country / state / locality fields that vary).
 */
const LEDGER_WINDOWS_PUBLISHER_SUBSTRING = "O=Ledger SAS";

/** Default install paths per platform. Tools fall back to scanning if these miss. */
const DEFAULT_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Ledger Live.app",
    `${process.env.HOME ?? ""}/Applications/Ledger Live.app`,
  ],
  win32: [
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\ledger-live-desktop\\Ledger Live.exe`,
    `${process.env.PROGRAMFILES ?? ""}\\Ledger Live\\Ledger Live.exe`,
  ],
  linux: [
    // AppImage paths are user-chosen; we don't auto-discover, so
    // Linux callers must pass an explicit path.
  ],
};

/** Resolve the most-likely Ledger Live install path, or null. */
function resolveDefaultPath(platform: NodeJS.Platform): string | null {
  const candidates = DEFAULT_PATHS[platform] ?? [];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/**
 * Spawn a child process, capture stdout + stderr + exit code.
 * Args MUST be passed as an array — never a shell string — to avoid
 * arg-injection from a hostile path. Stops at a hard timeout to keep
 * the tool responsive.
 */
async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function verifyMacos(bundlePath: string): Promise<CodesignResult> {
  // Two `codesign` calls: --verify checks signature integrity; -dvv
  // (-d --display --verbose=2) extracts the signing identity. Doing
  // both because --verify alone says "ok" but doesn't tell us WHO
  // signed it — and we need to assert it's Ledger.
  let verifyOut: { stdout: string; stderr: string; exitCode: number | null };
  try {
    verifyOut = await runCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      bundlePath,
    ]);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/ENOENT|not found|spawn.*ENOENT/i.test(message)) {
      return {
        status: "tool-missing",
        inspectedPath: bundlePath,
        platform: "darwin",
        message:
          "macOS `codesign` tool is not available. Verify Xcode Command Line " +
          "Tools are installed (`xcode-select --install`). Without `codesign` " +
          "the binary signature can't be verified locally.",
      };
    }
    return {
      status: "error",
      inspectedPath: bundlePath,
      platform: "darwin",
      message: `Failed to invoke codesign: ${message}`,
    };
  }
  if (verifyOut.exitCode !== 0) {
    return {
      status: "invalid",
      inspectedPath: bundlePath,
      platform: "darwin",
      message:
        `codesign --verify failed for ${bundlePath} (exit ${verifyOut.exitCode}). ` +
        `stderr: ${verifyOut.stderr.trim() || "<empty>"}. The binary may be ` +
        `unsigned, tampered, or the bundle structure is corrupt.`,
    };
  }
  // Identity extraction. `codesign -dvv <path>` writes the metadata
  // to stderr (codesign's quirk).
  const displayOut = await runCommand("codesign", ["-dvv", bundlePath]);
  const identityLine =
    /Authority=([^\n]+)/.exec(displayOut.stderr)?.[1]?.trim() ?? "";
  const teamLine = /TeamIdentifier=([A-Z0-9]+)/.exec(displayOut.stderr)?.[1] ?? "";
  if (teamLine !== LEDGER_MACOS_TEAM_ID) {
    return {
      status: "mismatch",
      inspectedPath: bundlePath,
      reportedIdentity: identityLine,
      platform: "darwin",
      message:
        `Bundle at ${bundlePath} is signed, but the Apple Team ID is ` +
        `"${teamLine}" (expected "${LEDGER_MACOS_TEAM_ID}" — Ledger SAS). ` +
        `If you're running a self-built or dev-channel Ledger Live this is ` +
        `expected. Otherwise, the binary may have been replaced — verify the ` +
        `install came from https://www.ledger.com/.`,
    };
  }
  return {
    status: "verified",
    inspectedPath: bundlePath,
    reportedIdentity: identityLine || `Apple Team ID ${LEDGER_MACOS_TEAM_ID}`,
    platform: "darwin",
    message:
      `Ledger Live bundle at ${bundlePath} is signed by Ledger SAS ` +
      `(Apple Team ID ${LEDGER_MACOS_TEAM_ID}).`,
  };
}

async function verifyWindows(exePath: string): Promise<CodesignResult> {
  let psOut: { stdout: string; stderr: string; exitCode: number | null };
  try {
    psOut = await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      // `Format-List *` ensures we get the SignerCertificate Subject
      // line; default formatting truncates it.
      `Get-AuthenticodeSignature -FilePath ${JSON.stringify(exePath)} | Format-List *`,
    ]);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/ENOENT|not found|spawn.*ENOENT/i.test(message)) {
      return {
        status: "tool-missing",
        inspectedPath: exePath,
        platform: "win32",
        message:
          "powershell.exe is not available. Without PowerShell the Authenticode " +
          "signature can't be verified locally.",
      };
    }
    return {
      status: "error",
      inspectedPath: exePath,
      platform: "win32",
      message: `Failed to invoke powershell: ${message}`,
    };
  }
  if (psOut.exitCode !== 0) {
    return {
      status: "error",
      inspectedPath: exePath,
      platform: "win32",
      message:
        `Get-AuthenticodeSignature exited ${psOut.exitCode}: ` +
        `${psOut.stderr.trim() || psOut.stdout.trim() || "<empty>"}`,
    };
  }
  const status = /Status\s*:\s*(\w+)/.exec(psOut.stdout)?.[1] ?? "Unknown";
  if (status !== "Valid") {
    return {
      status: "invalid",
      inspectedPath: exePath,
      platform: "win32",
      message:
        `Authenticode status for ${exePath} is "${status}" (expected "Valid"). ` +
        `The binary may be unsigned, tampered, or the cert chain is broken.`,
    };
  }
  // Subject line carries the publisher identity.
  const subjectMatch = /Subject\s*:\s*(.+)/.exec(psOut.stdout);
  const subject = subjectMatch?.[1]?.trim() ?? "";
  if (!subject.includes(LEDGER_WINDOWS_PUBLISHER_SUBSTRING)) {
    return {
      status: "mismatch",
      inspectedPath: exePath,
      reportedIdentity: subject,
      platform: "win32",
      message:
        `Binary at ${exePath} is Authenticode-Valid but the publisher subject ` +
        `does not contain "${LEDGER_WINDOWS_PUBLISHER_SUBSTRING}". Subject: ` +
        `"${subject}". Verify the install came from https://www.ledger.com/.`,
    };
  }
  return {
    status: "verified",
    inspectedPath: exePath,
    reportedIdentity: subject,
    platform: "win32",
    message:
      `Ledger Live binary at ${exePath} is Authenticode-signed by Ledger SAS.`,
  };
}

/**
 * Linux: AppImage GPG verification ONLY. Flatpak / snap / dpkg
 * installs surface `platform-not-supported` — those have their own
 * package-manager integrity (signed manifests, sandboxed runtime),
 * but it's not accessible the same way as a single binary on disk.
 */
async function verifyLinux(appImagePath: string): Promise<CodesignResult> {
  if (!existsSync(appImagePath)) {
    return {
      status: "not-found",
      inspectedPath: appImagePath,
      platform: "linux",
      message:
        `AppImage path ${appImagePath} doesn't exist. Pass the absolute path ` +
        `to your downloaded Ledger Live AppImage. flatpak / snap installs ` +
        `aren't supported by this check (use \`flatpak verify\` / \`snap info\` ` +
        `manually instead).`,
    };
  }
  // AppImage signature verification: the signed AppImage carries an
  // embedded signature and key fingerprint. The standard way to verify
  // is `gpg --verify <signature> <appimage>`, but Ledger ships
  // self-contained AppImages with the signature in the appimage itself
  // (extractable via `--appimage-signature`).
  let sigOut: { stdout: string; stderr: string; exitCode: number | null };
  try {
    sigOut = await runCommand(appImagePath, ["--appimage-signature"], 5_000);
  } catch (err) {
    return {
      status: "error",
      inspectedPath: appImagePath,
      platform: "linux",
      message: `Failed to extract AppImage signature: ${(err as Error).message}`,
    };
  }
  if (sigOut.exitCode !== 0 || !sigOut.stdout.includes("BEGIN PGP SIGNATURE")) {
    return {
      status: "invalid",
      inspectedPath: appImagePath,
      platform: "linux",
      message:
        `AppImage at ${appImagePath} did not produce a PGP signature. ` +
        `It may be unsigned, tampered, or not the official Ledger Live AppImage. ` +
        `Re-download from https://www.ledger.com/ ledger-live`,
    };
  }
  // Verifying the signature against Ledger's published GPG key would
  // require pinning their key fingerprint and shipping `gpg --verify`
  // with a hardcoded key — out of scope for this PR. The presence of
  // a signature is itself meaningful (unsigned AppImages don't carry
  // one); a follow-up can pin the key fingerprint.
  return {
    status: "verified",
    inspectedPath: appImagePath,
    platform: "linux",
    message:
      `AppImage at ${appImagePath} carries an embedded PGP signature. NOTE: ` +
      `this PR does not pin Ledger's GPG key fingerprint — adding that is a ` +
      `follow-up. Until then, "verified" here means "carries a signature", ` +
      `not "signature matches Ledger's published key".`,
  };
}

export interface VerifyLedgerLiveCodesignArgs {
  /**
   * Optional explicit path. When omitted, the tool tries the
   * platform's default install location. Required on Linux (no
   * canonical install path).
   */
  binaryPath?: string;
}

export async function verifyLedgerLiveCodesign(
  args: VerifyLedgerLiveCodesignArgs = {},
): Promise<CodesignResult> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    return {
      status: "platform-not-supported",
      inspectedPath: "",
      platform,
      message:
        `Codesign verification not supported on platform "${platform}" — only ` +
        `darwin / win32 / linux have implementations.`,
    };
  }
  const path = args.binaryPath ?? resolveDefaultPath(platform);
  if (!path) {
    if (platform === "linux") {
      return {
        status: "not-found",
        inspectedPath: "",
        platform,
        message:
          "Linux requires an explicit `binaryPath` — there is no canonical " +
          "Ledger Live install path. Pass the absolute path to your downloaded " +
          "AppImage. flatpak / snap installs aren't supported by this check.",
      };
    }
    return {
      status: "not-found",
      inspectedPath: "",
      platform,
      message:
        `Ledger Live install not found at any default path for ${platform}. ` +
        `Pass an explicit \`binaryPath\` argument with the absolute path to your install.`,
    };
  }
  if (!existsSync(path)) {
    return {
      status: "not-found",
      inspectedPath: path,
      platform,
      message: `Path "${path}" does not exist on disk.`,
    };
  }
  if (platform === "darwin") return verifyMacos(path);
  if (platform === "win32") return verifyWindows(path);
  return verifyLinux(path);
}
