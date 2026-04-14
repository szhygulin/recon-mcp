import { createRequire } from "node:module";

/**
 * Thin loader that brings the two Ledger packages in via CommonJS.
 *
 * Why this indirection: `@ledgerhq/hw-transport-node-hid` ships an `exports`
 * map whose ESM build (`lib-es/`) is compiled with `--moduleResolution bundler`
 * and omits `.js` extensions on relative imports. Node's ESM loader rejects
 * those imports (it requires explicit extensions), so a plain
 * `import TransportNodeHid from "@ledgerhq/hw-transport-node-hid"` crashes at
 * runtime with `ERR_MODULE_NOT_FOUND`. The package's CJS build (`lib/`)
 * resolves cleanly, so we load it via `createRequire`.
 *
 * Isolating the require() in this module makes it easy to vi.mock the loader
 * in tests without touching the ESM module registry. The signer talks to
 * `openLedger()`, not to the Ledger SDK directly.
 */
export interface TronLedgerTransport {
  close(): Promise<void>;
}

export interface TronLedgerApp {
  getAddress(
    path: string,
    display?: boolean
  ): Promise<{ publicKey: string; address: string }>;
  signTransaction(
    path: string,
    rawTxHex: string,
    tokenSignatures: string[]
  ): Promise<string>;
  getAppConfiguration(): Promise<{ version: string }>;
}

const requireCjs = createRequire(import.meta.url);

export async function openLedger(): Promise<{
  app: TronLedgerApp;
  transport: TronLedgerTransport;
}> {
  const TransportNodeHid = requireCjs("@ledgerhq/hw-transport-node-hid").default;
  const Trx = requireCjs("@ledgerhq/hw-app-trx").default;
  const transport: TronLedgerTransport = await TransportNodeHid.open("");
  const app: TronLedgerApp = new Trx(transport);
  return { app, transport };
}
