import { isTronAddress } from "../config/tron.js";
import { openLedger } from "./tron-usb-loader.js";

/**
 * TRON signing path. BIP-44 coin type 195 (SLIP-44). The hardened account
 * segment is the Ledger Live account index — 0 is the first TRON account,
 * 1 the second, etc. Matches the layout Ledger Live uses internally.
 */
export const DEFAULT_TRON_PATH = "44'/195'/0'/0/0";

/** Arbitrary cap to keep pathological inputs from producing absurd paths. */
const MAX_TRON_ACCOUNT_INDEX = 100;

/**
 * Build the standard Ledger Live TRON BIP-44 path for `accountIndex`.
 * Hardened account segment (matches Ledger Live's own derivation).
 */
export function tronPathForAccountIndex(accountIndex: number): string {
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_TRON_ACCOUNT_INDEX) {
    throw new Error(
      `Invalid TRON accountIndex ${accountIndex} — must be an integer in [0, ${MAX_TRON_ACCOUNT_INDEX}].`
    );
  }
  return `44'/195'/${accountIndex}'/0/0`;
}

/**
 * Extract the Ledger Live account index from a standard TRON path. Returns
 * `null` if the path doesn't match the `44'/195'/<n>'/0/0` shape — callers
 * treat missing indices as "custom path, no account-slot mapping".
 */
export function parseTronAccountIndex(path: string): number | null {
  const m = /^44'\/195'\/(\d+)'\/0\/0$/.exec(path);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

export interface PairedTronEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
  accountIndex: number | null;
}

/**
 * Ledger TRON pairings. Populated by `pair_ledger_tron` and read back by
 * `get_ledger_status` so the agent can resolve "my TRON wallet" / "my second
 * TRON account" without re-probing USB on every read. Keyed by BIP-44 path
 * so users can pair multiple account slots in parallel (e.g. index 0 and
 * index 1). `send_transaction` does NOT trust this cache — it always
 * re-opens the device and verifies the derived address matches `from`
 * before signing.
 */
const pairedTronByPath = new Map<string, PairedTronEntry>();

/** All paired TRON accounts, sorted by `accountIndex` (standard paths first). */
export function getPairedTronAddresses(): PairedTronEntry[] {
  return Array.from(pairedTronByPath.values()).sort((a, b) => {
    if (a.accountIndex === null && b.accountIndex === null) return 0;
    if (a.accountIndex === null) return 1;
    if (b.accountIndex === null) return -1;
    return a.accountIndex - b.accountIndex;
  });
}

/** Look up a paired entry by its derived base58 address. */
export function getPairedTronByAddress(address: string): PairedTronEntry | null {
  for (const entry of pairedTronByPath.values()) {
    if (entry.address === address) return entry;
  }
  return null;
}

export function setPairedTronAddress(entry: Omit<PairedTronEntry, "accountIndex">): PairedTronEntry {
  const full: PairedTronEntry = { ...entry, accountIndex: parseTronAccountIndex(entry.path) };
  pairedTronByPath.set(entry.path, full);
  return full;
}

/** Test-only hook — lets us reset state between suites without juggling module caches. */
export function clearPairedTronAddresses(): void {
  pairedTronByPath.clear();
}

/**
 * USB HID signing for TRON. Unlike EVM (WalletConnect → Ledger Live → device),
 * TRON signs via direct USB because Ledger Live's WalletConnect relay does
 * not honor the `tron:` CAIP namespace (verified 2026-04-14). The user's
 * Ledger must be plugged into the host running the MCP, unlocked, with the
 * TRON app open.
 *
 * Every sign/address call opens a fresh transport and closes it in finally —
 * HID handles are exclusive, so leaving one open blocks `ledger-live` and
 * other Ledger tooling from connecting in parallel.
 */

/**
 * Map the common Ledger status-word failures to user-actionable English.
 * Status words come back as `statusCode` on TransportStatusError and occasionally
 * as part of the message; we normalize by inspecting both.
 */
function mapLedgerError(e: unknown, ctx: string): Error {
  const err = e as { statusCode?: number; message?: string; name?: string };
  const sw = err?.statusCode;
  const msg = err?.message ?? String(e);
  // 0x6511 / 0x6E00 / 0x6D00: CLA not supported — wrong app (or dashboard).
  if (sw === 0x6511 || sw === 0x6e00 || sw === 0x6d00) {
    return new Error(
      `Ledger is connected but the TRON app isn't open. On the device, open the "Tron" app and retry (${ctx}).`
    );
  }
  // 0x5515 / 0x6B0C: device locked.
  if (sw === 0x5515 || sw === 0x6b0c) {
    return new Error(`Ledger device is locked. Enter your PIN on the device and retry (${ctx}).`);
  }
  // 0x6985: user rejected.
  if (sw === 0x6985 || /conditions.*not.*satisfied/i.test(msg) || /denied by the user/i.test(msg)) {
    return new Error(`User rejected the transaction on the Ledger device (${ctx}).`);
  }
  // No device / cannot open HID — surfaces differently by OS.
  if (/cannot open device/i.test(msg) || /no device/i.test(msg) || /NoDevice/i.test(msg)) {
    return new Error(
      `No Ledger device detected over USB. Plug the device in, unlock it, open the TRON app, and retry. ` +
        `On Linux, ensure Ledger's udev rules are installed (see https://github.com/LedgerHQ/udev-rules) ` +
        `otherwise hidraw access fails with "permission denied" (${ctx}).`
    );
  }
  return new Error(`Ledger TRON ${ctx} failed: ${msg}`);
}

async function openTronApp() {
  let ledger;
  try {
    ledger = await openLedger();
  } catch (e) {
    throw mapLedgerError(e, "open");
  }
  const { app, transport } = ledger;
  let appVersion: string;
  try {
    // Probe app config — confirms the TRON app is actually open. If the
    // dashboard is on screen this returns 0x6511 (CLA not supported) and
    // we surface the correct "open TRON app" message.
    const cfg = await app.getAppConfiguration();
    appVersion = cfg.version;
  } catch (e) {
    await transport.close().catch(() => {});
    throw mapLedgerError(e, "app-open check");
  }
  return { app, transport, appVersion };
}

/**
 * Query the device for its TRON address at `path`. Used by `pair_ledger_tron`
 * to cache the address for subsequent sign calls, and as the identity check
 * before signing.
 */
export async function getTronLedgerAddress(
  path: string = DEFAULT_TRON_PATH
): Promise<{ address: string; publicKey: string; path: string; appVersion: string }> {
  const { app, transport, appVersion } = await openTronApp();
  try {
    const { address, publicKey } = await app.getAddress(path, false);
    if (!isTronAddress(address)) {
      throw new Error(
        `Ledger returned an address that doesn't look like a TRON mainnet address: "${address}". ` +
          `Is the TRON (not Tron-classic / testnet) app open on the device?`
      );
    }
    return { address, publicKey, path, appVersion };
  } catch (e) {
    throw mapLedgerError(e, "getAddress");
  } finally {
    await transport.close().catch(() => {});
  }
}

export interface TronSignRequest {
  /** Hex-encoded raw_data to sign — exactly what TronGrid returned at prepare time. */
  rawDataHex: string;
  /** Base58 `from` from the prepared tx. The device address must match, or we refuse. */
  expectedFrom: string;
  /**
   * Ledger-signed token descriptors used to render TRC-20 transfer amounts
   * on-device. Pass `[]` for canonical tokens — the TRON app has hardcoded
   * support for USDT. Non-USDT TRC-20 amounts may display as raw hex without
   * a descriptor; Phase 3 accepts that tradeoff.
   */
  tokenSignatures?: string[];
  /** BIP-44 path override. Defaults to m/44'/195'/0'/0/0. */
  path?: string;
}

/**
 * Open USB, assert the device address matches `expectedFrom`, sign
 * `rawDataHex`, and return the hex signature ready to be attached to the
 * TronGrid transaction envelope for broadcast.
 *
 * Fresh transport open per call — avoids holding the HID handle across
 * multiple async operations where a disconnect could leave it dangling.
 */
export async function signTronTxOnLedger(
  req: TronSignRequest
): Promise<{ signature: string; signerAddress: string }> {
  const path = req.path ?? DEFAULT_TRON_PATH;
  const { app, transport } = await openTronApp();
  try {
    const { address } = await app.getAddress(path, false);
    if (address !== req.expectedFrom) {
      throw new Error(
        `Ledger device address (${address}) does not match the prepared tx's \`from\` ` +
          `(${req.expectedFrom}). Either connect the Ledger that holds keys for \`from\`, ` +
          `or re-prepare the tx for the Ledger-derived address (\`pair_ledger_tron\`).`
      );
    }
    const signature = await app.signTransaction(
      path,
      req.rawDataHex,
      req.tokenSignatures ?? []
    );
    // Ledger returns the signature as a hex string (65 bytes: r || s || v).
    if (!/^[0-9a-fA-F]{130}$/.test(signature)) {
      throw new Error(
        `Ledger returned an unexpected signature shape (length ${signature.length}). Expected 130 hex chars.`
      );
    }
    return { signature, signerAddress: address };
  } catch (e) {
    throw mapLedgerError(e, "signTransaction");
  } finally {
    await transport.close().catch(() => {});
  }
}
