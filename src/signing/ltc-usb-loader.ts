import { createRequire } from "node:module";

/**
 * Thin loader that brings the Ledger Litecoin packages in via CommonJS.
 * Mirror of `btc-usb-loader.ts` — `@ledgerhq/hw-app-btc` is the same
 * SDK for both BTC and LTC, parametrized by the `currency` argument
 * to its constructor. The Ledger device runs a separate "Litecoin"
 * app from the "Bitcoin" app; switching app on the device is what
 * picks the network-specific address-encoding behavior, but the
 * host-side API is shared.
 *
 * Isolating the `require()` here lets tests
 * `vi.mock("../signing/ltc-usb-loader.js")` with a fake `openLedger()`
 * and avoid touching the Ledger SDK entirely.
 */

export type LtcAddressFormat = "legacy" | "p2sh" | "bech32" | "bech32m";

export interface LtcLedgerTransport {
  close(): Promise<void>;
}

export interface LtcLedgerApp {
  /**
   * Returns the public key + address at the BIP-32 path for the given
   * address format. Pass `verify: true` to have the Ledger show the
   * address on-screen for user confirmation (used during pairing).
   *
   * `bitcoinAddress` is encoded for the requested format using the
   * Litecoin network's version bytes / HRP (the Litecoin app handles
   * encoding):
   *   - `legacy`   → P2PKH (`L...`)
   *   - `p2sh`     → P2SH-wrapped segwit (`M...`)
   *   - `bech32`   → native segwit P2WPKH (`ltc1q...`)
   *   - `bech32m`  → taproot P2TR (`ltc1p...`)
   */
  getWalletPublicKey(
    path: string,
    opts?: { verify?: boolean; format?: LtcAddressFormat },
  ): Promise<{
    publicKey: string;
    bitcoinAddress: string;
    chainCode: string;
  }>;
  /**
   * Sign a message (BIP-137 with Litecoin's "Litecoin Signed Message"
   * prefix). Used by `sign_litecoin_message`.
   */
  signMessage(
    path: string,
    messageHex: string,
  ): Promise<{ v: number; r: string; s: string }>;
  /**
   * Sign a v0 PSBT on the Ledger Litecoin app. Same options shape as
   * the BTC app — the SDK handles network-specific encoding internally.
   */
  signPsbtBuffer(
    psbtBuffer: Buffer,
    options: {
      finalizePsbt: boolean;
      accountPath: string;
      addressFormat: LtcAddressFormat;
      knownAddressDerivations: Map<string, { pubkey: Buffer; path: number[] }>;
    },
  ): Promise<{ psbt: Buffer; tx?: string }>;
}

export interface LtcAppAndVersion {
  name: string;
  version: string;
}

const requireCjs = createRequire(import.meta.url);

export async function openLedger(): Promise<{
  app: LtcLedgerApp;
  transport: LtcLedgerTransport;
  rawTransport: unknown;
}> {
  const TransportNodeHid = requireCjs("@ledgerhq/hw-transport-node-hid").default;
  const Btc = requireCjs("@ledgerhq/hw-app-btc").default;
  const transport = (await TransportNodeHid.open("")) as LtcLedgerTransport & {
    close(): Promise<void>;
  };
  // `currency: "litecoin"` flips the SDK's internal serialization to
  // emit Litecoin-encoded addresses and accept Litecoin BIP-44 paths
  // (coin type 2). The dashboard-side `getAppAndVersion()` call still
  // returns whichever app is currently open on the device — the
  // pairing flow checks for `name === "Litecoin"`.
  const app = new Btc({ transport, currency: "litecoin" }) as LtcLedgerApp;
  return { app, transport, rawTransport: transport };
}

/**
 * Surface the open app's name + version.
 */
export async function getAppAndVersion(
  rawTransport: unknown,
): Promise<LtcAppAndVersion> {
  const mod = requireCjs("@ledgerhq/hw-app-btc/lib/getAppAndVersion");
  const fn = mod.getAppAndVersion;
  const out = await fn(rawTransport as never);
  return { name: out.name, version: out.version };
}
