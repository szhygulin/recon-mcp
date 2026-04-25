import { existsSync } from "node:fs";
import {
  openLedger,
  getAppAndVersion,
  type BtcAddressFormat,
  type BtcLedgerTransport,
} from "./btc-usb-loader.js";
import { getConfigPath, patchUserConfig, readUserConfig } from "../config/user-config.js";
import type { PairedBitcoinEntry } from "../types/index.js";

export type { PairedBitcoinEntry };

/**
 * Bitcoin BIP-44/49/84/86 paths — one purpose per address format. Per
 * SLIP-44 + the relevant BIPs:
 *
 *   - BIP-44 (legacy P2PKH):              `44'/0'/<account>'/0/0`
 *   - BIP-49 (P2SH-wrapped segwit):       `49'/0'/<account>'/0/0`
 *   - BIP-84 (native segwit P2WPKH):      `84'/0'/<account>'/0/0`
 *   - BIP-86 (taproot P2TR):              `86'/0'/<account>'/0/0`
 *
 * Path layout matches Ledger Live's so account-index 0 in this server
 * corresponds to the first Bitcoin account in Ledger Live for each
 * address type.
 *
 * The 5-segment shape (`<purpose>'/0'/<account>'/0/0`) drills all the way
 * to the first receive address (`change=0, index=0`). The Ledger BTC app
 * accepts any prefix (down to `m/<purpose>'/0'/<account>'`) for the
 * account-level xpub; for our pair-and-cache flow we ask for the leaf
 * receive address directly so the user sees a concrete `bc1p…` value
 * during pairing rather than an xpub.
 */
const MAX_BTC_ACCOUNT_INDEX = 100;

export const BTC_ADDRESS_TYPES = [
  "legacy",
  "p2sh-segwit",
  "segwit",
  "taproot",
] as const;

export type BtcAddressType = (typeof BTC_ADDRESS_TYPES)[number];

/**
 * Map our address-type label → Ledger BTC app's `format` enum + the
 * BIP-44 purpose number. Single source of truth so paths and formats
 * never drift.
 */
const TYPE_META: Record<
  BtcAddressType,
  { purpose: number; format: BtcAddressFormat }
> = {
  legacy: { purpose: 44, format: "legacy" },
  "p2sh-segwit": { purpose: 49, format: "p2sh" },
  segwit: { purpose: 84, format: "bech32" },
  taproot: { purpose: 86, format: "bech32m" },
};

export function btcPathForAccountIndex(
  accountIndex: number,
  addressType: BtcAddressType,
): string {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BTC_ACCOUNT_INDEX
  ) {
    throw new Error(
      `Invalid Bitcoin accountIndex ${accountIndex} — must be an integer in [0, ${MAX_BTC_ACCOUNT_INDEX}].`,
    );
  }
  const { purpose } = TYPE_META[addressType];
  return `${purpose}'/0'/${accountIndex}'/0/0`;
}

const BTC_PATH_RE = /^(44|49|84|86)'\/0'\/(\d+)'\/0\/0$/;

/**
 * Parse the address type + account index out of a BTC BIP-44 path.
 * Returns null when the path doesn't match the standard 5-segment
 * `<purpose>'/0'/<account>'/0/0` shape — a custom path we'd cache but
 * couldn't index.
 */
export function parseBtcPath(
  path: string,
): { addressType: BtcAddressType; accountIndex: number } | null {
  const m = BTC_PATH_RE.exec(path);
  if (!m) return null;
  const purpose = Number(m[1]);
  const accountIndex = Number(m[2]);
  if (!Number.isInteger(accountIndex)) return null;
  for (const t of BTC_ADDRESS_TYPES) {
    if (TYPE_META[t].purpose === purpose) {
      return { addressType: t, accountIndex };
    }
  }
  return null;
}

/**
 * Module-local serialization for HID transport calls. USB-HID is
 * single-tenant — opening a second transport while the first is in
 * flight throws "device busy". Same primitive Solana / TRON signers use.
 */
let usbLock: Promise<void> = Promise.resolve();
export async function withBtcUsbLock<T>(fn: () => Promise<T>): Promise<T> {
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

interface DerivedAddress {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  addressType: BtcAddressType;
  accountIndex: number;
}

/**
 * Open the BTC app, derive the address at `path` for `addressType`, and
 * close. Single round-trip per call. The caller is responsible for
 * batching when deriving multiple paths — `pair_ledger_btc` reuses the
 * same transport for all four BIP-44 / BIP-49 / BIP-84 / BIP-86 paths.
 */
export async function getBtcLedgerAddress(
  path: string,
  addressType: BtcAddressType,
): Promise<DerivedAddress> {
  return withBtcUsbLock(async () => {
    const { app, transport, rawTransport } = await openLedger();
    try {
      const appVer = await getAppAndVersion(rawTransport);
      if (
        appVer.name !== "Bitcoin" &&
        appVer.name !== "Bitcoin Test" &&
        appVer.name !== "BTC"
      ) {
        throw new Error(
          `Ledger reports the open app as "${appVer.name}" v${appVer.version}, but Bitcoin is required. ` +
            `Open the Bitcoin app on your device and retry.`,
        );
      }
      const { format } = TYPE_META[addressType];
      const out = await app.getWalletPublicKey(path, { format });
      const parsed = parseBtcPath(path);
      const accountIndex = parsed?.accountIndex ?? 0;
      return {
        address: out.bitcoinAddress,
        publicKey: out.publicKey,
        path,
        appVersion: appVer.version,
        addressType,
        accountIndex,
      };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

/**
 * Derive ALL four address types for one account index in a single
 * USB-HID session. Reuses the open transport so the user only sees one
 * "approve on device" prompt per type if they have `display: true`
 * configured (we don't pass it in pairing — Ledger's BTC app shows the
 * derivation on-screen on signing, not on derivation by default).
 */
export async function deriveBtcLedgerAccount(
  accountIndex: number,
): Promise<{ appVersion: string; entries: DerivedAddress[] }> {
  return withBtcUsbLock(async () => {
    const { app, transport, rawTransport } = await openLedger();
    try {
      const appVer = await getAppAndVersion(rawTransport);
      if (
        appVer.name !== "Bitcoin" &&
        appVer.name !== "Bitcoin Test" &&
        appVer.name !== "BTC"
      ) {
        throw new Error(
          `Ledger reports the open app as "${appVer.name}" v${appVer.version}, but Bitcoin is required. ` +
            `Open the Bitcoin app on your device and retry.`,
        );
      }
      const entries: DerivedAddress[] = [];
      for (const addressType of BTC_ADDRESS_TYPES) {
        const path = btcPathForAccountIndex(accountIndex, addressType);
        const { format } = TYPE_META[addressType];
        const out = await app.getWalletPublicKey(path, { format });
        entries.push({
          address: out.bitcoinAddress,
          publicKey: out.publicKey,
          path,
          appVersion: appVer.version,
          addressType,
          accountIndex,
        });
      }
      return { appVersion: appVer.version, entries };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

// --- Pairing cache --------------------------------------------------------

const pairedBtcByPath = new Map<string, PairedBitcoinEntry>();
let pairedBtcHydrated = false;

function ensurePairedBtcHydrated(): void {
  if (pairedBtcHydrated) return;
  pairedBtcHydrated = true;
  const persisted = readUserConfig()?.pairings?.bitcoin ?? [];
  for (const entry of persisted) {
    pairedBtcByPath.set(entry.path, entry);
  }
}

function persistPairedBtc(): void {
  patchUserConfig({
    pairings: { bitcoin: Array.from(pairedBtcByPath.values()) },
  });
}

export function getPairedBtcAddresses(): PairedBitcoinEntry[] {
  ensurePairedBtcHydrated();
  return Array.from(pairedBtcByPath.values()).sort((a, b) => {
    // Sort by accountIndex first, then by purpose so each account's four
    // address types appear together (legacy → p2sh-segwit → segwit →
    // taproot, the BIP-44 purpose order).
    if (a.accountIndex !== b.accountIndex) {
      if (a.accountIndex === null) return 1;
      if (b.accountIndex === null) return -1;
      return a.accountIndex - b.accountIndex;
    }
    return BTC_ADDRESS_TYPES.indexOf(a.addressType) - BTC_ADDRESS_TYPES.indexOf(b.addressType);
  });
}

export function getPairedBtcByAddress(address: string): PairedBitcoinEntry | null {
  ensurePairedBtcHydrated();
  for (const entry of pairedBtcByPath.values()) {
    if (entry.address === address) return entry;
  }
  return null;
}

export function setPairedBtcAddress(
  entry: Omit<PairedBitcoinEntry, "accountIndex"> & { accountIndex: number | null },
): PairedBitcoinEntry {
  ensurePairedBtcHydrated();
  const full: PairedBitcoinEntry = {
    address: entry.address,
    publicKey: entry.publicKey,
    path: entry.path,
    appVersion: entry.appVersion,
    addressType: entry.addressType,
    accountIndex: entry.accountIndex,
  };
  pairedBtcByPath.set(entry.path, full);
  persistPairedBtc();
  return full;
}

export function clearPairedBtcAddresses(): void {
  pairedBtcByPath.clear();
  pairedBtcHydrated = false;
  if (existsSync(getConfigPath())) {
    patchUserConfig({ pairings: { bitcoin: [] } });
  }
}
