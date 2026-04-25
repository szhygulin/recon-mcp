import { createRequire } from "node:module";

/**
 * Thin loader that brings the Ledger Bitcoin packages in via CommonJS.
 * Same ESM/CJS-interop reason as `solana-usb-loader.ts` /
 * `tron-usb-loader.ts`: `@ledgerhq/hw-transport-node-hid` ships an ESM
 * build whose imports omit `.js` extensions, which Node's ESM loader
 * rejects. The CJS build resolves cleanly.
 *
 * Isolating the `require()` here lets tests
 * `vi.mock("../signing/btc-usb-loader.js")` with a fake `openLedger()` and
 * avoid touching the Ledger SDK entirely.
 */

export type BtcAddressFormat = "legacy" | "p2sh" | "bech32" | "bech32m";

export interface BtcLedgerTransport {
  close(): Promise<void>;
}

export interface BtcLedgerApp {
  /**
   * Returns the public key + address at the BIP-32 path for the given
   * address format. Pass `verify: true` to have the Ledger show the
   * address on-screen for user confirmation (used during pairing).
   *
   * `bitcoinAddress` is encoded for the requested format:
   *   - `legacy`   → P2PKH (`1...`)
   *   - `p2sh`     → P2SH-wrapped segwit (`3...`)
   *   - `bech32`   → native segwit P2WPKH (`bc1q...`)
   *   - `bech32m`  → taproot P2TR (`bc1p...`)
   */
  getWalletPublicKey(
    path: string,
    opts?: { verify?: boolean; format?: BtcAddressFormat },
  ): Promise<{
    publicKey: string;
    bitcoinAddress: string;
    chainCode: string;
  }>;
  /**
   * Sign a Bitcoin Signed Message (BIP-137 for legacy, BIP-322 for
   * segwit/taproot — the Ledger BTC app picks the right shape based on
   * the path's purpose). Used by `sign_message_btc` (PR4).
   */
  signMessage(
    path: string,
    messageHex: string,
  ): Promise<{ v: number; r: string; s: string }>;
  /**
   * Sign a v0 PSBT on the Ledger BTC app. The device walks every output
   * (address + amount) on-screen, displays change with a "change" label
   * when the derivation matches a known internal-chain entry, shows the
   * fee, and asks the user to confirm. Returns the signed (and finalized
   * when `finalizePsbt: true`) PSBT bytes plus the network-broadcastable
   * tx hex.
   *
   * `knownAddressDerivations` maps scriptPubKey-hash hex → { pubkey, path }
   * for every address the wallet owns that appears in the PSBT (inputs +
   * change outputs). `accountPath` is the BIP-32 account-level path
   * (e.g. `84'/0'/0'`) and `addressFormat` is the Ledger format string
   * for that account type.
   */
  signPsbtBuffer(
    psbtBuffer: Buffer,
    options: {
      finalizePsbt: boolean;
      accountPath: string;
      addressFormat: BtcAddressFormat;
      knownAddressDerivations: Map<string, { pubkey: Buffer; path: number[] }>;
    },
  ): Promise<{ psbt: Buffer; tx?: string }>;
}

export interface BtcAppAndVersion {
  name: string;
  version: string;
}

const requireCjs = createRequire(import.meta.url);

export async function openLedger(): Promise<{
  app: BtcLedgerApp;
  transport: BtcLedgerTransport;
  // The bare transport is needed for `getAppAndVersion` (a standalone
  // function in the SDK that talks the dashboard CLA, not a Btc-class method).
  rawTransport: unknown;
}> {
  const TransportNodeHid = requireCjs("@ledgerhq/hw-transport-node-hid").default;
  const Btc = requireCjs("@ledgerhq/hw-app-btc").default;
  const transport = (await TransportNodeHid.open("")) as BtcLedgerTransport & {
    close(): Promise<void>;
  };
  // Newer hw-app-btc constructor takes `{ transport, currency }`. The
  // legacy single-arg form (just `transport`) still works in v10 but is
  // deprecated; use the object form.
  const app = new Btc({ transport, currency: "bitcoin" }) as BtcLedgerApp;
  return { app, transport, rawTransport: transport };
}

/**
 * Surface the open app's name + version. Standalone function in the SDK
 * (talks the dashboard CLA APDU); reused so the pairing flow can stamp
 * `appVersion` on the cached entry.
 */
export async function getAppAndVersion(
  rawTransport: unknown,
): Promise<BtcAppAndVersion> {
  const mod = requireCjs("@ledgerhq/hw-app-btc/lib/getAppAndVersion");
  const fn = mod.getAppAndVersion;
  const out = await fn(rawTransport as never);
  return { name: out.name, version: out.version };
}
