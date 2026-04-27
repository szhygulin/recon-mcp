import { PublicKey } from "@solana/web3.js";
import { openLedger } from "./solana-usb-loader.js";
import { existsSync } from "node:fs";
import { getConfigPath, patchUserConfig, readUserConfig } from "../config/user-config.js";
import type { PairedSolanaEntry } from "../types/index.js";
import { assertCanonicalLedgerApp } from "./canonical-apps.js";

export type { PairedSolanaEntry };

/**
 * Solana signing path. BIP-44 coin type 501 (SLIP-44). Unlike TRON
 * (`44'/195'/<n>'/0/0`), Ledger Live Solana uses a 3-segment path — all
 * hardened — and no `change`/`index` suffix. Verified against Ledger Live
 * e2e test fixtures (`libs/ledger-live-common/src/e2e/enum/Account.ts`).
 *
 * `accountIndex` maps 1:1 to Ledger Live's Solana account slot: index 0 is
 * the first Solana account you see in Ledger Live, 1 is the second, etc.
 */
export const DEFAULT_SOLANA_PATH = "44'/501'/0'";

/** Arbitrary cap to keep pathological inputs from producing absurd paths. */
const MAX_SOLANA_ACCOUNT_INDEX = 100;

/** Build the standard Ledger Live Solana BIP-44 path for `accountIndex`. */
export function solanaPathForAccountIndex(accountIndex: number): string {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_SOLANA_ACCOUNT_INDEX
  ) {
    throw new Error(
      `Invalid Solana accountIndex ${accountIndex} — must be an integer in [0, ${MAX_SOLANA_ACCOUNT_INDEX}].`,
    );
  }
  return `44'/501'/${accountIndex}'`;
}

/**
 * Extract the Ledger Live account index from a standard Solana path.
 * Returns `null` if the path doesn't match the `44'/501'/<n>'` shape.
 */
export function parseSolanaAccountIndex(path: string): number | null {
  const m = /^44'\/501'\/(\d+)'$/.exec(path);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Ledger Solana pairings. Same role as `pairedTronByPath` — populated by
 * `pair_ledger_solana`, read back by `get_ledger_status`. `send_transaction`
 * does NOT trust this cache: it always re-opens the device and verifies
 * the derived address matches `tx.from` before signing.
 *
 * Persisted to `~/.vaultpilot-mcp/config.json` (UserConfig.pairings.solana)
 * — public addresses + paths only, no secrets — so a server restart
 * doesn't force a re-pair. The persistence is write-through on
 * `setPairedSolanaAddress` and lazy-load on first read.
 */
const pairedSolanaByPath = new Map<string, PairedSolanaEntry>();
let pairedSolanaHydrated = false;

/**
 * Hydrate the in-memory Map from disk on first access. Idempotent — sets a
 * sticky flag so subsequent reads are O(1). Tests can reset by calling
 * `clearPairedSolanaAddresses` (which also clears the on-disk slice).
 */
function ensurePairedSolanaHydrated(): void {
  if (pairedSolanaHydrated) return;
  pairedSolanaHydrated = true;
  const persisted = readUserConfig()?.pairings?.solana ?? [];
  for (const entry of persisted) {
    pairedSolanaByPath.set(entry.path, entry);
  }
}

/** Snapshot in-memory entries to disk via patchUserConfig (preserves other config slices). */
function persistPairedSolana(): void {
  patchUserConfig({
    pairings: { solana: Array.from(pairedSolanaByPath.values()) },
  });
}

export function getPairedSolanaAddresses(): PairedSolanaEntry[] {
  ensurePairedSolanaHydrated();
  return Array.from(pairedSolanaByPath.values()).sort((a, b) => {
    if (a.accountIndex === null && b.accountIndex === null) return 0;
    if (a.accountIndex === null) return 1;
    if (b.accountIndex === null) return -1;
    return a.accountIndex - b.accountIndex;
  });
}

export function getPairedSolanaByAddress(address: string): PairedSolanaEntry | null {
  ensurePairedSolanaHydrated();
  for (const entry of pairedSolanaByPath.values()) {
    if (entry.address === address) return entry;
  }
  return null;
}

export function setPairedSolanaAddress(
  entry: Omit<PairedSolanaEntry, "accountIndex">,
): PairedSolanaEntry {
  ensurePairedSolanaHydrated();
  const full: PairedSolanaEntry = {
    ...entry,
    accountIndex: parseSolanaAccountIndex(entry.path),
  };
  pairedSolanaByPath.set(entry.path, full);
  persistPairedSolana();
  return full;
}

/**
 * Reset both the in-memory Map and the on-disk slice. Used by tests to
 * isolate suites and by future "forget paired devices" UX. Clears the
 * `pairedSolanaHydrated` flag so the NEXT read re-hydrates from disk
 * (in tests with HOME swapped to a tmp dir, the new dir starts empty,
 * which is what we want).
 */
export function clearPairedSolanaAddresses(): void {
  pairedSolanaByPath.clear();
  pairedSolanaHydrated = false;
  // Only write the empty slice if the ACTIVE config file exists — avoids
  // creating `~/.vaultpilot-mcp/` on a fresh install just to record "no
  // pairings", and avoids triggering the legacy-dir migration if only the
  // pre-rename `~/.recon-crypto-mcp/config.json` is present (`readUserConfig`
  // falls through to the legacy path; we want the active path here).
  if (existsSync(getConfigPath())) {
    patchUserConfig({ pairings: { solana: [] } });
  }
}

/**
 * USB HID signing for Solana. Ledger Live does NOT expose Solana accounts
 * over WalletConnect (confirmed 2026-04-23; see
 * `project_ledger_live_solana_wc.md`), so we sign via direct USB. The
 * user's Ledger must be plugged into the host, unlocked, with the Solana
 * app open.
 *
 * Every sign/address call opens a fresh transport and closes it in the
 * `finally` — HID handles are exclusive, leaving one open blocks other
 * Ledger tooling.
 */

/**
 * Map common Ledger status-word failures to user-actionable English.
 * Mirrors `mapLedgerError` in `tron-usb-signer.ts` but references the
 * Solana app.
 */
function mapLedgerError(e: unknown, ctx: string): Error {
  const err = e as { statusCode?: number; message?: string; name?: string };
  const sw = err?.statusCode;
  const msg = err?.message ?? String(e);
  // 0x6511 / 0x6E00 / 0x6D00: CLA not supported — wrong app (or dashboard).
  if (sw === 0x6511 || sw === 0x6e00 || sw === 0x6d00) {
    return new Error(
      `Ledger is connected but the Solana app isn't open. On the device, open the "Solana" app and retry (${ctx}).`,
    );
  }
  // 0x5515 / 0x6B0C: device locked.
  if (sw === 0x5515 || sw === 0x6b0c) {
    return new Error(
      `Ledger device is locked. Enter your PIN on the device and retry (${ctx}).`,
    );
  }
  // 0x6985: user rejected.
  if (
    sw === 0x6985 ||
    /conditions.*not.*satisfied/i.test(msg) ||
    /denied by the user/i.test(msg)
  ) {
    return new Error(`User rejected the transaction on the Ledger device (${ctx}).`);
  }
  // 0x6808 on Solana app: "blind-sign required but not enabled".
  if (sw === 0x6808 || /blind.sign/i.test(msg)) {
    return new Error(
      `The Solana app refused to sign because the tx needs blind-signing — most commonly a ` +
        `transfer to an address that doesn't have an associated token account yet (the tx has ` +
        `to create the account, which the Solana app can't clear-sign). On the device, go to ` +
        `Solana app → Settings → "Allow blind signing" → enable, then retry (${ctx}).`,
    );
  }
  // No device / cannot open HID — surfaces differently by OS.
  if (
    /cannot open device/i.test(msg) ||
    /no device/i.test(msg) ||
    /NoDevice/i.test(msg)
  ) {
    return new Error(
      `No Ledger device detected over USB. Plug the device in, unlock it, open the Solana app, and retry. ` +
        `On Linux, ensure Ledger's udev rules are installed (see https://github.com/LedgerHQ/udev-rules) ` +
        `otherwise hidraw access fails with "permission denied" (${ctx}).`,
    );
  }
  return new Error(`Ledger Solana ${ctx} failed: ${msg}`);
}

async function openSolanaApp() {
  let ledger;
  try {
    ledger = await openLedger();
  } catch (e) {
    throw mapLedgerError(e, "open");
  }
  const { app, transport } = ledger;
  let appVersion: string;
  try {
    const cfg = await app.getAppConfiguration();
    appVersion = cfg.version;
  } catch (e) {
    await transport.close().catch(() => {});
    throw mapLedgerError(e, "app-open check");
  }
  // Canonical-version pin (issue #325 P2). The Solana app-class APDUs
  // already gate on the open app via CLA mismatch (wrong app → 0x6E00
  // surfaced as an open-error above), so we pass "Solana" as the
  // implicit name and let the helper assert the version floor.
  try {
    assertCanonicalLedgerApp({
      reportedName: "Solana",
      reportedVersion: appVersion,
      expectedNames: ["Solana"],
    });
  } catch (e) {
    await transport.close().catch(() => {});
    throw e;
  }
  return { app, transport, appVersion };
}

/** Module-local serialization for HID transport calls. Same primitive TRON uses. */
let usbLock: Promise<void> = Promise.resolve();
async function withUsbLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = usbLock;
  let release!: () => void;
  usbLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

/**
 * Query the device for its Solana address at `path`. Used by
 * `pair_ledger_solana` to cache the address for subsequent sign calls, and
 * as the identity check before signing. The Ledger app returns a 32-byte
 * raw pubkey buffer; we base58-encode via `@solana/web3.js` `PublicKey`.
 */
export async function getSolanaLedgerAddress(
  path: string = DEFAULT_SOLANA_PATH,
): Promise<{ address: string; publicKey: string; path: string; appVersion: string }> {
  return withUsbLock(async () => {
    const { app, transport, appVersion } = await openSolanaApp();
    try {
      const { address: addressBuf } = await app.getAddress(path, false);
      if (!(addressBuf instanceof Buffer) || addressBuf.length !== 32) {
        throw new Error(
          `Ledger returned an unexpected Solana address buffer (length ${addressBuf?.length ?? "?"}, ` +
            `expected 32). Is the Solana app open on the device?`,
        );
      }
      const pubkey = new PublicKey(addressBuf);
      const address = pubkey.toBase58();
      return {
        address,
        publicKey: addressBuf.toString("hex"),
        path,
        appVersion,
      };
    } catch (e) {
      throw mapLedgerError(e, "getAddress");
    } finally {
      await transport.close().catch(() => {});
    }
  });
}

export interface SolanaSignRequest {
  /** Serialized Solana tx MESSAGE bytes (from `tx.serializeMessage()`). Not the full tx. */
  messageBytes: Buffer;
  /** Base58 `from` address from the prepared tx. Device must match, else we refuse. */
  expectedFrom: string;
  /** BIP-44 path override. Defaults to `m/44'/501'/0'`. */
  path?: string;
}

/**
 * Open USB, assert the device address matches `expectedFrom`, sign the
 * message bytes, and return the 64-byte Ed25519 signature. Fresh transport
 * per call; closed in `finally`.
 */
export async function signSolanaTxOnLedger(
  req: SolanaSignRequest,
): Promise<{ signature: Buffer; signerAddress: string }> {
  const path = req.path ?? DEFAULT_SOLANA_PATH;
  return withUsbLock(async () => {
    const { app, transport } = await openSolanaApp();
    try {
      const { address: addressBuf } = await app.getAddress(path, false);
      const derivedAddress = new PublicKey(addressBuf).toBase58();
      if (derivedAddress !== req.expectedFrom) {
        throw new Error(
          `SECURITY: Ledger device address (${derivedAddress}) does not match the prepared tx's \`from\` ` +
            `(${req.expectedFrom}). Do NOT retry until you know which of these two is the cause: ` +
            `(1) the wrong Ledger is connected, or (2) the \`from\` field in the prepared tx was ` +
            `tampered with between prepare and send. Check the device — if the address it derives ` +
            `on-screen is the one you expected (${derivedAddress}), the tx's \`from\` was altered: ` +
            `abort, re-prepare from scratch, and compare the new preview's \`from\` against user ` +
            `intent. If the address on-screen is not your expected account, connect the correct ` +
            `Ledger or re-prepare the tx for the Ledger-derived address via \`pair_ledger_solana\`.`,
        );
      }
      const { signature } = await app.signTransaction(path, req.messageBytes);
      if (!(signature instanceof Buffer) || signature.length !== 64) {
        throw new Error(
          `SECURITY: Ledger returned an unexpected signature shape (length ${signature?.length ?? "?"}, ` +
            `expected 64 bytes Ed25519). Do NOT broadcast this signature. Reconnect the Ledger, ` +
            `reopen the Solana app, and re-prepare the transaction. If the error repeats on a clean ` +
            `reconnect, treat the host's USB/HID path as potentially compromised and stop using it ` +
            `for signing until investigated.`,
        );
      }
      return { signature, signerAddress: derivedAddress };
    } catch (e) {
      throw mapLedgerError(e, "signTransaction");
    } finally {
      await transport.close().catch(() => {});
    }
  });
}
