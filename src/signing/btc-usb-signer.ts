import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  openLedger,
  getAppAndVersion,
  type BtcAddressFormat,
  type BtcLedgerApp,
  type BtcLedgerTransport,
} from "./btc-usb-loader.js";
import {
  accountNodeFromLedgerResponse,
  deriveAccountChildAddress,
  type AccountNode,
} from "./btc-bip32-derive.js";
import { getConfigPath, patchUserConfig, readUserConfig } from "../config/user-config.js";
import type { PairedBitcoinEntry } from "../types/index.js";

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  address: { toOutputScript(addr: string, network?: unknown): Buffer };
  networks: { bitcoin: unknown };
};

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
  return btcLeafPath(accountIndex, addressType, 0, 0);
}

/**
 * Build a full BIP-32 leaf path for a specific (account, type, chain,
 * index) tuple. Used by gap-limit scanning to walk both the receive
 * chain (chain=0) and change chain (chain=1) at non-zero indices.
 */
/**
 * Build the BIP-44 account-level path (3 hardened segments — purpose,
 * coin_type, account). This is the deepest path the Ledger BTC app
 * needs to derive on-device per address type; everything below it
 * (`/0/i`, `/1/i`) is non-hardened and computable host-side from the
 * returned (publicKey, chainCode) pair. Issue #192.
 */
export function btcAccountLevelPath(
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
  return `${purpose}'/0'/${accountIndex}'`;
}

export function btcLeafPath(
  accountIndex: number,
  addressType: BtcAddressType,
  chain: 0 | 1,
  addressIndex: number,
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
  if (chain !== 0 && chain !== 1) {
    throw new Error(`Invalid BIP-32 chain ${chain} — must be 0 (receive) or 1 (change).`);
  }
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error(
      `Invalid BIP-32 addressIndex ${addressIndex} — must be a non-negative integer.`,
    );
  }
  const { purpose } = TYPE_META[addressType];
  return `${purpose}'/0'/${accountIndex}'/${chain}/${addressIndex}`;
}

const BTC_PATH_RE = /^(44|49|84|86)'\/0'\/(\d+)'\/(0|1)\/(\d+)$/;

/**
 * Parse the address type, account index, BIP-32 chain (0 = receive,
 * 1 = change), and address index out of a BTC BIP-44 path. Returns
 * null when the path doesn't match the standard 5-segment shape —
 * custom paths get cached but can't be indexed.
 */
export function parseBtcPath(
  path: string,
): {
  addressType: BtcAddressType;
  accountIndex: number;
  chain: 0 | 1;
  addressIndex: number;
} | null {
  const m = BTC_PATH_RE.exec(path);
  if (!m) return null;
  const purpose = Number(m[1]);
  const accountIndex = Number(m[2]);
  const chain = Number(m[3]) as 0 | 1;
  const addressIndex = Number(m[4]);
  if (!Number.isInteger(accountIndex)) return null;
  if (!Number.isInteger(addressIndex)) return null;
  for (const t of BTC_ADDRESS_TYPES) {
    if (TYPE_META[t].purpose === purpose) {
      return { addressType: t, accountIndex, chain, addressIndex };
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
  chain: 0 | 1;
  addressIndex: number;
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
      return {
        address: out.bitcoinAddress,
        publicKey: out.publicKey,
        path,
        appVersion: appVer.version,
        addressType,
        accountIndex: parsed?.accountIndex ?? 0,
        chain: parsed?.chain ?? 0,
        addressIndex: parsed?.addressIndex ?? 0,
      };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

/**
 * BIP44 gap-limit default. Standard across Electrum / Sparrow / Trezor
 * Suite / Ledger Live: stop walking a chain after 20 consecutive
 * addresses with zero on-chain history. Issue #189.
 */
export const DEFAULT_BTC_GAP_LIMIT = 20;
/** Hard cap on `gapLimit` to bound USB roundtrips. */
export const MAX_BTC_GAP_LIMIT = 100;

/**
 * Caller-supplied callback that fetches the current on-chain tx count
 * for an address. Injected (rather than hard-wired to the indexer) so
 * `scanBtcAccount` stays usable from tests with mocked tx-count
 * responses, and so the hot-path indexer module isn't a runtime
 * dependency of this file's import graph (keeps the USB signer
 * independent of the HTTP indexer abstraction).
 */
export type BtcAddressTxCountFetcher = (
  address: string,
) => Promise<number>;

/**
 * Result of a single (type, chain) walk: the addresses we derived,
 * and how many of them ended the run with txCount === 0 (the gap
 * window that ultimately tripped the stop condition).
 */
export interface ScanChainResult {
  /**
   * Every derived address along this chain, in walk order. Includes
   * the trailing gap of empties that triggered the stop — the LAST
   * empty is the wallet's "next fresh receive address" for receive
   * chains, useful for UX. All except the trailing gap have
   * `txCount > 0`.
   */
  addresses: DerivedAddress[];
  /** Tx counts aligned 1:1 with `addresses`. */
  txCounts: number[];
  /** True when the chain returned all-zeros immediately (no usage). */
  empty: boolean;
}

/**
 * BIP44 gap-limit scan for one account index. Walks each address-type
 * (44'/49'/84'/86') across both BIP-32 chains (receive=0, change=1),
 * stopping each chain after `gapLimit` consecutive empty addresses.
 *
 * Performance posture (issue #192):
 *
 *   - Per address type, exactly ONE device call: `getWalletPublicKey`
 *     at the account-level path (`<purpose>'/0'/<account>'`), returning
 *     the (publicKey, chainCode) pair for that account-level node.
 *   - All `0/i` and `1/i` leaves below that node are derived host-side
 *     via @scure/bip32 — no further device interaction. BIP-32 is
 *     deterministic for non-hardened descendants of a known parent
 *     pubkey + chainCode, so the math is identical to what the device
 *     would have produced.
 *   - Per (type, chain) the gap-limit window is probed in PARALLEL
 *     against the indexer (`Promise.all` over a chunk equal to the
 *     remaining `gapLimit` budget). The serial `getWalletPublicKey →
 *     fetchTxCount` round-trip from before is gone.
 *
 * Combined floor: 4 device calls per accountIndex (one per BIP-44
 * purpose) plus ~`O(gapLimit)` parallel HTTP calls per (type, chain).
 * Down from the prior `4 × 2 × gapLimit ≈ 160` device round-trips.
 *
 * Optimization: when the receive chain (chain=0) returns all-empty for
 * a given type, the change chain is skipped entirely — change
 * addresses can only have history if at least one corresponding
 * receive saw a spend, and "no receives" → "no spends" → "no change".
 * Saves the change-chain HTTP round on fresh wallets.
 */
export async function scanBtcAccount(args: {
  accountIndex: number;
  gapLimit?: number;
  fetchTxCount: BtcAddressTxCountFetcher;
}): Promise<{
  appVersion: string;
  entries: Array<DerivedAddress & { txCount: number }>;
}> {
  const accountIndex = args.accountIndex;
  const gapLimit = args.gapLimit ?? DEFAULT_BTC_GAP_LIMIT;
  if (
    !Number.isInteger(gapLimit) ||
    gapLimit < 1 ||
    gapLimit > MAX_BTC_GAP_LIMIT
  ) {
    throw new Error(
      `Invalid gapLimit ${gapLimit} — must be an integer in [1, ${MAX_BTC_GAP_LIMIT}].`,
    );
  }
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

      const all: Array<DerivedAddress & { txCount: number }> = [];
      for (const addressType of BTC_ADDRESS_TYPES) {
        // ONE device call per type — pull the account-level (publicKey,
        // chainCode). Everything below this in the BIP-44 tree is
        // non-hardened and host-derivable.
        const accountPath = btcAccountLevelPath(accountIndex, addressType);
        const { format } = TYPE_META[addressType];
        const accountResp = await app.getWalletPublicKey(accountPath, {
          format,
        });
        const node: AccountNode = accountNodeFromLedgerResponse({
          publicKeyHex: accountResp.publicKey,
          chainCodeHex: accountResp.chainCode,
          addressFormat: format,
        });

        const receive = await scanChainHostSide({
          node,
          accountIndex,
          addressType,
          chain: 0,
          gapLimit,
          appVersion: appVer.version,
          fetchTxCount: args.fetchTxCount,
        });
        for (let i = 0; i < receive.addresses.length; i++) {
          all.push({ ...receive.addresses[i], txCount: receive.txCounts[i] });
        }
        // No receives ever → no change can exist. Skip the change-chain
        // walk entirely (saves the entire change-chain HTTP round).
        if (receive.empty) continue;
        const change = await scanChainHostSide({
          node,
          accountIndex,
          addressType,
          chain: 1,
          gapLimit,
          appVersion: appVer.version,
          fetchTxCount: args.fetchTxCount,
        });
        for (let i = 0; i < change.addresses.length; i++) {
          all.push({ ...change.addresses[i], txCount: change.txCounts[i] });
        }
      }
      return { appVersion: appVer.version, entries: all };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

/**
 * Walk a single (type, chain) host-side until `gapLimit` consecutive
 * empty addresses are observed. Each iteration derives a window of
 * children purely via BIP-32 math, then probes the indexer for all
 * window entries in parallel. The window is sized dynamically to
 * `gapLimit - consecutiveEmpty` — we only ever probe the addresses we
 * still NEED to satisfy the stop condition, so there's no over-fetch
 * if a chunk has activity that resets the counter.
 *
 * Returns every address we derived in walk order, including the
 * trailing empty window — the FIRST trailing empty is the wallet's
 * next fresh address for that chain, useful for receive UX.
 */
async function scanChainHostSide(args: {
  node: AccountNode;
  accountIndex: number;
  addressType: BtcAddressType;
  chain: 0 | 1;
  gapLimit: number;
  appVersion: string;
  fetchTxCount: BtcAddressTxCountFetcher;
}): Promise<ScanChainResult> {
  const addresses: DerivedAddress[] = [];
  const txCounts: number[] = [];
  let consecutiveEmpty = 0;
  let addressIndex = 0;
  while (consecutiveEmpty < args.gapLimit) {
    // Window size = remaining-empties-needed. If we already have N
    // trailing empties, we only need (gapLimit - N) more to terminate;
    // probing more would be wasted HTTP. The window shrinks
    // monotonically toward the stop unless an interior result in the
    // chunk turns out to be USED (which resets consecutiveEmpty back
    // to 0 and re-grows the next window to gapLimit).
    const windowSize = args.gapLimit - consecutiveEmpty;
    const windowStart = addressIndex;

    // Host-side BIP-32 child derivations — no I/O, near-instant.
    const window: Array<{
      addressIndex: number;
      address: string;
      publicKey: Uint8Array;
    }> = [];
    for (let i = 0; i < windowSize; i++) {
      const idx = windowStart + i;
      const child = deriveAccountChildAddress(args.node, args.chain, idx);
      window.push({
        addressIndex: idx,
        address: child.address,
        publicKey: child.publicKey,
      });
    }

    // Parallel indexer fan-out for the whole window. Per-call failures
    // degrade to txCount=0 so a flaky HTTP doesn't abort the scan.
    const counts = await Promise.all(
      window.map((w) =>
        args.fetchTxCount(w.address).catch(() => 0),
      ),
    );

    // Process results in order. Update consecutiveEmpty inside the
    // loop so a USED address mid-window resets the counter and any
    // empties AFTER it in the same window contribute fresh to the
    // next stop budget.
    for (let i = 0; i < window.length; i++) {
      const w = window[i];
      addresses.push({
        address: w.address,
        publicKey: Buffer.from(w.publicKey).toString("hex"),
        path: btcLeafPath(
          args.accountIndex,
          args.addressType,
          args.chain,
          w.addressIndex,
        ),
        appVersion: args.appVersion,
        addressType: args.addressType,
        accountIndex: args.accountIndex,
        chain: args.chain,
        addressIndex: w.addressIndex,
      });
      txCounts.push(counts[i]);
      if (counts[i] === 0) consecutiveEmpty++;
      else consecutiveEmpty = 0;
    }
    addressIndex += window.length;
  }
  // `empty` = chain returned ZERO used addresses; equivalent to "the
  // first `gapLimit` entries are all zero-tx" and `addresses.length === gapLimit`.
  const empty = txCounts.every((c) => c === 0);
  return { addresses, txCounts, empty };
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
          chain: 0,
          addressIndex: 0,
        });
      }
      return { appVersion: appVer.version, entries };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

/**
 * Build a Ledger derivation-path number array from a string path like
 * `84'/0'/0'/0/0`. Hardened segments (trailing `'`) get the
 * 0x80000000 high bit; non-hardened segments are passed through. Used
 * to populate `signPsbtBuffer.knownAddressDerivations`, which the
 * device's owner-input + change-output detection relies on.
 */
function pathStringToNumbers(path: string): number[] {
  return path.split("/").map((seg) => {
    const hardened = seg.endsWith("'");
    const n = Number(hardened ? seg.slice(0, -1) : seg);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid Bitcoin path segment "${seg}" in "${path}".`);
    }
    return hardened ? (n | 0x80000000) >>> 0 : n;
  });
}

/**
 * Extract the witness-program payload from a P2WPKH or P2TR scriptPubKey
 * as the lookup key for `signPsbtBuffer.knownAddressDerivations`. The
 * Ledger SDK's `populateMissingBip32Derivations` keys its lookup map by
 * this same payload (bytes 2..22 — hash160(pubkey) — for P2WPKH; bytes
 * 2..34 — tweaked x-only key — for P2TR), not by sha256(scriptPubKey).
 * Mirrors `@ledgerhq/psbtv2::extractHashFromScriptPubKey` for just the
 * two script types Phase 1 sends support; legacy / P2SH-wrapped sends
 * are out of scope (`buildBitcoinNativeSend` rejects them upfront).
 */
function extractWitnessProgramHex(scriptPubKey: Buffer): string {
  if (
    scriptPubKey.length === 22 &&
    scriptPubKey[0] === 0x00 &&
    scriptPubKey[1] === 0x14
  ) {
    return scriptPubKey.subarray(2, 22).toString("hex");
  }
  if (
    scriptPubKey.length === 34 &&
    scriptPubKey[0] === 0x51 &&
    scriptPubKey[1] === 0x20
  ) {
    return scriptPubKey.subarray(2, 34).toString("hex");
  }
  throw new Error(
    `Unexpected scriptPubKey shape (length=${scriptPubKey.length}, ` +
      `bytes=0x${scriptPubKey.subarray(0, Math.min(4, scriptPubKey.length)).toString("hex")}). ` +
      `Phase 1 BTC sends only support P2WPKH (segwit, bc1q...) and P2TR (taproot, bc1p...).`,
  );
}

/**
 * Compress a SEC1 public key to its 33-byte form. Ledger's
 * `getWalletPublicKey` returns the uncompressed encoding (`0x04 || X
 * || Y`, 65 bytes), but PSBT consumers downstream of
 * `signPsbtBuffer.knownAddressDerivations` expect the compressed
 * encoding (`0x02 || X` if Y is even, `0x03 || X` if odd, 33 bytes) —
 * the SDK then strips the prefix byte for taproot's x-only key. Issue
 * #211: a 65-byte buffer threaded straight through threw "Invalid
 * pubkey length: 65" before any device prompt. Idempotent on inputs
 * already in compressed form.
 */
export function compressPubkey(pubkey: Buffer): Buffer {
  if (
    pubkey.length === 33 &&
    (pubkey[0] === 0x02 || pubkey[0] === 0x03)
  ) {
    return pubkey;
  }
  if (pubkey.length !== 65 || pubkey[0] !== 0x04) {
    throw new Error(
      `Unexpected SEC1 pubkey shape (length=${pubkey.length}, ` +
        `prefix=0x${pubkey[0]?.toString(16) ?? "??"}). Expected 65-byte ` +
        `uncompressed (0x04 || X || Y) or 33-byte compressed (0x02/0x03 || X).`,
    );
  }
  const x = pubkey.subarray(1, 33);
  const yLast = pubkey[64];
  const prefix = (yLast & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

/**
 * Sign a base64-encoded PSBT v0 on the Ledger BTC app. The device walks
 * every output (address + amount + the "change" label for known
 * internal-chain outputs), shows the total fee, and asks the user to
 * confirm. Returns the network-broadcastable raw tx hex.
 *
 * `expectedFrom` is the source address the prepare-time receipt
 * advertised. We re-derive the address from `path` against the live
 * device and refuse to sign if it doesn't match — same proof-of-identity
 * pattern as `signSolanaTxOnLedger` / `signTronTxOnLedger`. Catches a
 * stale or planted pairing entry that points at an address the device
 * no longer derives the same way.
 */
export async function signBtcPsbtOnLedger(args: {
  psbtBase64: string;
  expectedFrom: string;
  path: string;
  accountPath: string;
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
}): Promise<{ rawTxHex: string }> {
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
      // Re-derive + validate the source address. If the device produces
      // a different address for the same path the pairing cache
      // registered, refuse to sign — something is wrong (different seed,
      // different app, planted pairing). Don't blind-sign through it.
      const derived = await app.getWalletPublicKey(args.path, {
        format: args.addressFormat,
      });
      if (derived.bitcoinAddress !== args.expectedFrom) {
        throw new Error(
          `Ledger derived ${derived.bitcoinAddress} at ${args.path}, but the prepared tx ` +
            `lists ${args.expectedFrom} as the source. The device may have a different seed ` +
            `loaded, the Bitcoin app version may have changed the derivation, or the cached ` +
            `pairing is stale. Re-pair via \`pair_ledger_btc\` and retry.`,
        );
      }

      // Build the knownAddressDerivations map. Phase 1 sends keep change
      // on the source address, so a single entry covers both inputs and
      // any same-address output. The SDK keys the map by the witness-
      // program payload extracted from each scriptPubKey — bytes 2..22
      // (hash160 of pubkey) for P2WPKH, bytes 2..34 (tweaked x-only key)
      // for P2TR. Mirrors @ledgerhq/psbtv2 `extractHashFromScriptPubKey`,
      // which is what `populateMissingBip32Derivations` looks up against.
      // Issue #206: an earlier sha256(scriptPubKey) key never matched, so
      // the library left the PSBT without bip32Derivation and the Ledger
      // BTC app v2.x rejected with 0x6a80 before any UI.
      const scriptPubKey = bitcoinjs.address.toOutputScript(
        args.expectedFrom,
        bitcoinjs.networks.bitcoin,
      );
      const lookupKey = extractWitnessProgramHex(scriptPubKey);
      const known = new Map<string, { pubkey: Buffer; path: number[] }>();
      known.set(lookupKey, {
        pubkey: compressPubkey(Buffer.from(derived.publicKey, "hex")),
        path: pathStringToNumbers(args.path),
      });

      const psbtBuffer = Buffer.from(args.psbtBase64, "base64");
      const result = await app.signPsbtBuffer(psbtBuffer, {
        finalizePsbt: true,
        accountPath: args.accountPath,
        addressFormat: args.addressFormat,
        knownAddressDerivations: known,
      });
      if (!result.tx) {
        throw new Error(
          `Ledger BTC app returned no finalized tx hex from signPsbtBuffer. ` +
            `The PSBT may have been signed but not finalized — check the device for an ` +
            `unexpected approval state and retry.`,
        );
      }
      return { rawTxHex: result.tx };
    } finally {
      await (transport as BtcLedgerTransport).close().catch(() => {});
    }
  });
}

/**
 * Sign an arbitrary message with the Bitcoin Signed Message format
 * (BIP-137, ECDSA). Returns a base64-encoded compact signature in the
 * shape `<headerByte><r><s>`, where the header byte encodes recovery id
 * + address type:
 *
 *   - legacy (P2PKH, compressed key):           31..34 (= 27 + 4 + recid)
 *   - P2SH-wrapped segwit (BIP-137 extension):  35..38 (= 35 + recid)
 *   - native segwit P2WPKH (BIP-137 extension): 39..42 (= 39 + recid)
 *   - taproot P2TR:                              NOT SUPPORTED (BIP-322
 *     is the canonical scheme for taproot, and the Ledger BTC app does
 *     not expose a BIP-322 path; refusing is more honest than emitting
 *     a non-verifying ECDSA blob).
 *
 * The `expectedFrom` re-derivation guard mirrors `signBtcPsbtOnLedger`:
 * if the device produces a different address for `path`, refuse to sign
 * — same proof-of-identity invariant we apply to tx signing.
 */
export async function signBtcMessageOnLedger(args: {
  expectedFrom: string;
  path: string;
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
  /** UTF-8 message bytes — the SDK takes the hex of the raw bytes. */
  messageHex: string;
  addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
}): Promise<{
  signature: string;
  format: "BIP-137";
}> {
  if (args.addressType === "taproot") {
    throw new Error(
      "Taproot (P2TR) message signing requires BIP-322, which the Ledger BTC app " +
        "does not yet expose. Sign with a paired segwit (`bc1q…`), P2SH-wrapped " +
        "(`3…`), or legacy (`1…`) address instead. The 4 address types share a " +
        "Ledger account — `pair_ledger_btc` derives all four — so picking a " +
        "non-taproot address from the same Ledger wallet is one tool call away.",
    );
  }
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
      const derived = await app.getWalletPublicKey(args.path, {
        format: args.addressFormat,
      });
      if (derived.bitcoinAddress !== args.expectedFrom) {
        throw new Error(
          `Ledger derived ${derived.bitcoinAddress} at ${args.path}, but the request asks ` +
            `to sign with ${args.expectedFrom}. The device may have a different seed loaded, ` +
            `the Bitcoin app version may have changed the derivation, or the cached pairing ` +
            `is stale. Re-pair via \`pair_ledger_btc\` and retry.`,
        );
      }
      const sig = await app.signMessage(args.path, args.messageHex);
      // Address-type → BIP-137 header offset (compressed-key + segwit
      // extensions). The Ledger SDK returns `v` as the recovery id (0 or
      // 1); we add the address-type-specific base.
      let base: number;
      switch (args.addressType) {
        case "legacy":
          base = 31; // 27 + 4 (compressed)
          break;
        case "p2sh-segwit":
          base = 35;
          break;
        case "segwit":
          base = 39;
          break;
        default:
          // Unreachable — taproot is rejected up-top.
          throw new Error(`Unsupported addressType ${String(args.addressType)}`);
      }
      const recid = sig.v & 1;
      const headerByte = base + recid;
      const sigBuf = Buffer.concat([
        Buffer.from([headerByte]),
        Buffer.from(sig.r, "hex"),
        Buffer.from(sig.s, "hex"),
      ]);
      return { signature: sigBuf.toString("base64"), format: "BIP-137" as const };
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
    // Backfill chain/addressIndex from the path for pre-#189 entries
    // (which only ever had chain=0, addressIndex=0). Keeps callers
    // from having to handle the absence at every read site.
    if (entry.chain === undefined || entry.addressIndex === undefined) {
      const parsed = parseBtcPath(entry.path);
      if (parsed) {
        entry.chain = parsed.chain;
        entry.addressIndex = parsed.addressIndex;
      } else {
        entry.chain = null;
        entry.addressIndex = null;
      }
    }
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
    // Sort by accountIndex → addressType (BIP-44 purpose order:
    // legacy 44 → p2sh 49 → segwit 84 → taproot 86) → chain (receive
    // before change) → addressIndex. Keeps each account's full
    // footprint contiguous and ordered the way most wallets display it.
    if (a.accountIndex !== b.accountIndex) {
      if (a.accountIndex === null) return 1;
      if (b.accountIndex === null) return -1;
      return a.accountIndex - b.accountIndex;
    }
    const typeOrder =
      BTC_ADDRESS_TYPES.indexOf(a.addressType) -
      BTC_ADDRESS_TYPES.indexOf(b.addressType);
    if (typeOrder !== 0) return typeOrder;
    const aChain = a.chain ?? -1;
    const bChain = b.chain ?? -1;
    if (aChain !== bChain) return aChain - bChain;
    const aIdx = a.addressIndex ?? -1;
    const bIdx = b.addressIndex ?? -1;
    return aIdx - bIdx;
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
    ...(entry.chain !== undefined ? { chain: entry.chain } : {}),
    ...(entry.addressIndex !== undefined ? { addressIndex: entry.addressIndex } : {}),
    ...(entry.txCount !== undefined ? { txCount: entry.txCount } : {}),
  };
  pairedBtcByPath.set(entry.path, full);
  persistPairedBtc();
  return full;
}

/**
 * Drop every cached entry whose `accountIndex` matches. Used by
 * `pair_ledger_btc` before re-scanning so an account that previously
 * extended further than the current gap-limit window doesn't leave
 * stale (and now-incorrect) entries in the cache.
 */
export function clearPairedBtcAccount(accountIndex: number): void {
  ensurePairedBtcHydrated();
  let changed = false;
  for (const [path, entry] of pairedBtcByPath) {
    if (entry.accountIndex === accountIndex) {
      pairedBtcByPath.delete(path);
      changed = true;
    }
  }
  if (changed) persistPairedBtc();
}

export function clearPairedBtcAddresses(): void {
  pairedBtcByPath.clear();
  pairedBtcHydrated = false;
  if (existsSync(getConfigPath())) {
    patchUserConfig({ pairings: { bitcoin: [] } });
  }
}
