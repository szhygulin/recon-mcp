import { createRequire } from "node:module";

/**
 * Minimal raw USB-HID transport loader for device-info-level APDUs that
 * don't need an app-specific wrapper. Mirrors the ESM/CJS-interop pattern
 * in `solana-usb-loader.ts` / `tron-usb-loader.ts` — `@ledgerhq/hw-transport-
 * node-hid` ships an ESM build compiled with `--moduleResolution bundler`
 * that omits `.js` extensions, which Node's ESM loader rejects. Loading
 * via `createRequire` works around it and lets tests
 * `vi.mock("../signing/ledger-device-info-loader.js")` with a fake.
 *
 * Used by `get_ledger_device_info` (dashboard-level GET_APP_AND_VERSION
 * APDU). App-specific flows (Solana / TRON signing) use their own
 * loaders with the corresponding `hw-app-*` wrapper.
 */
export interface RawLedgerTransport {
  send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Buffer,
  ): Promise<Buffer>;
  close(): Promise<void>;
}

const requireCjs = createRequire(import.meta.url);

export async function openRawLedgerTransport(): Promise<RawLedgerTransport> {
  const TransportNodeHid = requireCjs(
    "@ledgerhq/hw-transport-node-hid",
  ).default;
  return (await TransportNodeHid.open("")) as RawLedgerTransport;
}
