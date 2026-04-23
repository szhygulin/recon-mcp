import { createRequire } from "node:module";

/**
 * Thin loader that brings the Ledger Solana packages in via CommonJS. Same
 * ESM/CJS-interop reason as `tron-usb-loader.ts`: `@ledgerhq/hw-transport-node-hid`
 * ships an ESM build compiled with `--moduleResolution bundler` that omits
 * `.js` extensions, which Node's ESM loader rejects. The CJS build resolves
 * cleanly, so we load it via `createRequire`.
 *
 * Isolating the `require()` here lets tests `vi.mock("../signing/solana-usb-loader.js")`
 * with a fake `openLedger()` and avoid touching the Ledger SDK entirely.
 */
export interface SolanaLedgerTransport {
  close(): Promise<void>;
}

export interface SolanaLedgerApp {
  /**
   * Returns the Solana pubkey at the BIP-44 path as a 32-byte buffer.
   * Pass `display: true` to have the Ledger show the address on-screen
   * for user verification (used during pairing).
   */
  getAddress(
    path: string,
    display?: boolean,
  ): Promise<{ address: Buffer }>;
  /**
   * Signs a Solana transaction message with the key at `path`. The input
   * is the serialized message bytes (what Solana calls the "compiled
   * message") — NOT the full tx (which would include the signature
   * section). Returns the 64-byte Ed25519 signature.
   */
  signTransaction(
    path: string,
    messageBytes: Buffer,
  ): Promise<{ signature: Buffer }>;
  getAppConfiguration(): Promise<{ version: string; blindSigningEnabled?: boolean }>;
}

const requireCjs = createRequire(import.meta.url);

export async function openLedger(): Promise<{
  app: SolanaLedgerApp;
  transport: SolanaLedgerTransport;
}> {
  const TransportNodeHid = requireCjs("@ledgerhq/hw-transport-node-hid").default;
  const Solana = requireCjs("@ledgerhq/hw-app-solana").default;
  const transport: SolanaLedgerTransport = await TransportNodeHid.open("");
  const app: SolanaLedgerApp = new Solana(transport);
  return { app, transport };
}
