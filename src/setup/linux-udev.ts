/**
 * Linux-only helper: detect whether Ledger's udev rules are installed and,
 * if not, surface the exact install command for the user to run.
 *
 * Why not auto-run sudo:
 *   - Adds supply-chain risk (one-shot curl | bash from a third-party repo).
 *   - Requires stdin hand-off to the sudo password prompt mid-wizard, which
 *     interacts badly with our own readline loop.
 *   - User sees exactly what they're about to run and can opt out.
 *
 * The command we print pulls Ledger's officially-maintained install script
 * via wget + pipes to sudo bash; users who prefer manual review can click
 * through to the repo and apply the rules themselves.
 *
 * Called only when `process.platform === "linux"`. No-op on macOS / Windows
 * (the former doesn't need udev; the latter uses WinUSB + Ledger's driver).
 */
import { existsSync } from "node:fs";

/**
 * Ledger's official rules file. Installed by their script at this path.
 * Matches Ledger's documented location; checking it is the reliable
 * "are rules installed?" signal.
 */
const LEDGER_UDEV_RULES_PATH = "/etc/udev/rules.d/20-hw1.rules";

/**
 * One-liner that fetches + installs + reloads. Matches Ledger's official
 * README at github.com/LedgerHQ/udev-rules (verified 2026-04-25). Print as-is
 * for the user to paste; do not eval.
 */
export const LEDGER_UDEV_INSTALL_COMMAND =
  "wget -q -O - https://raw.githubusercontent.com/LedgerHQ/udev-rules/master/add_udev_rules.sh | sudo bash";

export interface LedgerUdevStatus {
  /** True on platforms that don't need udev rules (macOS / Windows). */
  notApplicable: boolean;
  /** Whether `/etc/udev/rules.d/20-hw1.rules` exists. */
  rulesInstalled: boolean;
}

export function checkLedgerUdevStatus(): LedgerUdevStatus {
  if (process.platform !== "linux") {
    return { notApplicable: true, rulesInstalled: true };
  }
  return {
    notApplicable: false,
    rulesInstalled: existsSync(LEDGER_UDEV_RULES_PATH),
  };
}

/**
 * Emit setup-wizard output about udev state. Called from `src/setup.ts` on
 * Linux only; no-op on other platforms.
 *
 * Design: always print a one-line status so the user sees it. If rules are
 * missing, also print the install command with a short why + mitigation
 * note. No interactive prompt — running sudo during the setup wizard
 * conflicts with our readline loop and the user gets a cleaner experience
 * running the command themselves in a separate terminal or after exiting
 * setup.
 */
export function reportLedgerUdevStatus(): void {
  const status = checkLedgerUdevStatus();
  if (status.notApplicable) return;

  console.log("\n--- Ledger udev rules (Linux only) ---");
  if (status.rulesInstalled) {
    console.log(`  OK: ${LEDGER_UDEV_RULES_PATH} exists.`);
    return;
  }
  console.log(
    "  MISSING: Ledger's udev rules are not installed, so USB HID access to",
  );
  console.log(
    "  your Ledger device will fail with \"permission denied\" when pairing",
  );
  console.log(
    "  for TRON or Solana signing. Install them now by running this one-liner",
  );
  console.log("  in a separate terminal (requires sudo):");
  console.log("");
  console.log(`      ${LEDGER_UDEV_INSTALL_COMMAND}`);
  console.log("");
  console.log(
    "  Source: https://github.com/LedgerHQ/udev-rules — Ledger's officially",
  );
  console.log(
    "  maintained rules file. After running, unplug + replug your Ledger",
  );
  console.log(
    "  (the new rules only apply to new device connections). WalletConnect-",
  );
  console.log(
    "  based EVM signing via Ledger Live isn't affected — this only matters",
  );
  console.log("  for the direct-USB TRON and Solana paths.");
}
