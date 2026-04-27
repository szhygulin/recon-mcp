import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { setConfigDirForTesting, getConfigPath } from "../src/config/user-config.js";

/**
 * Tests for issues #228 (LTC pairing cache hydrating from `pairings.bitcoin`)
 * and #229 (rescan_ltc_account — read-only Litecoin pairing-cache refresh).
 */

const LTC_SEGWIT = "ltc1qg9stkxrszkdqsuj92lm4c7akvk36zvhqw7p6ck";
const LTC_SEGWIT_TAIL = "ltc1qttxxttxttxttxttxttxttxttxttxttxttxxqxx55h";
const FAKE_PUBKEY = "00".repeat(33);

const indexerGetBalanceMock = vi.fn();
vi.mock("../src/modules/litecoin/indexer.ts", () => ({
  getLitecoinIndexer: () => ({ getBalance: indexerGetBalanceMock }),
  resetLitecoinIndexer: () => {},
}));

vi.mock("../src/signing/ltc-usb-loader.js", () => ({
  openLedger: async () => {
    throw new Error("test: openLedger should not be called from rescan");
  },
  getAppAndVersion: async () => {
    throw new Error("test: getAppAndVersion should not be called");
  },
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-ltc-rescan-"));
  setConfigDirForTesting(pjoin(tmpHome, ".vaultpilot-mcp"));
  indexerGetBalanceMock.mockReset();
  const { clearPairedLtcAddresses } = await import(
    "../src/signing/ltc-usb-signer.js"
  );
  clearPairedLtcAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.LITECOIN_INDEXER_PARALLELISM;
  vi.resetModules();
});

// ---- Issue #228: hydration source + pollution recovery -------------------

describe("LTC pairing cache hydration (issue #228)", () => {
  it("reads from pairings.litecoin (NOT pairings.bitcoin)", async () => {
    // Seed the on-disk config with both lists. If the hydrator reads
    // from `bitcoin`, the LTC cache would surface a `bc1q...` entry —
    // exactly the bug from #228. Correct behavior: only the LTC entry
    // appears.
    const cfgPath = getConfigPath();
    mkdirSync(pjoin(cfgPath, ".."), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        pairings: {
          bitcoin: [
            {
              address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
              publicKey: FAKE_PUBKEY,
              path: "84'/0'/0'/0/0",
              appVersion: "2.4.6",
              addressType: "segwit",
              accountIndex: 0,
              chain: 0,
              addressIndex: 0,
              txCount: 0,
            },
          ],
          litecoin: [
            {
              address: LTC_SEGWIT,
              publicKey: FAKE_PUBKEY,
              path: "84'/2'/0'/0/0",
              appVersion: "2.4.6",
              addressType: "segwit",
              accountIndex: 0,
              chain: 0,
              addressIndex: 0,
              txCount: 0,
            },
          ],
        },
      }) + "\n",
    );

    // Reset the in-memory hydration latch so the read above takes effect.
    vi.resetModules();
    const { getPairedLtcAddresses } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const entries = getPairedLtcAddresses();
    expect(entries.length).toBe(1);
    expect(entries[0].address).toBe(LTC_SEGWIT);
    expect(entries[0].path).toBe("84'/2'/0'/0/0");
  });

  it("filters out bitcoin-shaped entries that earlier polluted pairings.litecoin", async () => {
    // Affected installs from #228 ended up with bitcoin entries inside
    // `pairings.litecoin` on disk. The hydrate-time filter drops them
    // and re-persists the cleaned list so users don't have to hand-edit
    // user-config.json.
    const cfgPath = getConfigPath();
    mkdirSync(pjoin(cfgPath, ".."), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        pairings: {
          litecoin: [
            // Polluted: BTC mainnet bech32 on coin_type=0 path.
            {
              address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
              publicKey: FAKE_PUBKEY,
              path: "84'/0'/0'/0/0",
              appVersion: "2.4.6",
              addressType: "segwit",
              accountIndex: 0,
              chain: 0,
              addressIndex: 0,
              txCount: 0,
            },
            // Polluted: BTC legacy `1...` on coin_type=0 path.
            {
              address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
              publicKey: FAKE_PUBKEY,
              path: "44'/0'/0'/0/0",
              appVersion: "2.4.6",
              addressType: "legacy",
              accountIndex: 0,
              chain: 0,
              addressIndex: 0,
              txCount: 0,
            },
            // Genuine LTC entry — the only one that should survive.
            {
              address: LTC_SEGWIT,
              publicKey: FAKE_PUBKEY,
              path: "84'/2'/0'/0/0",
              appVersion: "2.4.6",
              addressType: "segwit",
              accountIndex: 0,
              chain: 0,
              addressIndex: 0,
              txCount: 0,
            },
          ],
        },
      }) + "\n",
    );

    vi.resetModules();
    const { getPairedLtcAddresses } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const entries = getPairedLtcAddresses();
    expect(entries.length).toBe(1);
    expect(entries[0].address).toBe(LTC_SEGWIT);

    // The cleaned list is persisted back to disk so subsequent loads
    // also see only the genuine entry (and to recover the user's
    // config without manual editing).
    const { readFileSync } = await import("node:fs");
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      pairings: { litecoin: Array<{ address: string }> };
    };
    expect(onDisk.pairings.litecoin.length).toBe(1);
    expect(onDisk.pairings.litecoin[0].address).toBe(LTC_SEGWIT);
  });
});

// ---- Issue #229: rescan_ltc_account ---------------------------------------

describe("rescan_ltc_account (issue #229)", () => {
  async function seedSegwitReceiveChain(
    addresses: Array<{ idx: number; addr: string; txCount: number }>,
  ) {
    const { setPairedLtcAddress } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    for (const e of addresses) {
      setPairedLtcAddress({
        address: e.addr,
        publicKey: FAKE_PUBKEY,
        path: `84'/2'/0'/0/${e.idx}`,
        appVersion: "2.4.6",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: e.idx,
        txCount: e.txCount,
      });
    }
  }

  // retry: 2 — flakes on full-suite runs from upstream module-cache contamination.
  it("throws when no entries are paired for the requested account", { retry: 2 }, async () => {
    const { rescanLitecoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(rescanLitecoinAccount({ accountIndex: 0 })).rejects.toThrow(
      /No paired Litecoin entries cached/,
    );
  });

  it("flags needsExtend when the trailing empty cached address now has history", async () => {
    await seedSegwitReceiveChain([
      { idx: 0, addr: LTC_SEGWIT, txCount: 5 },
      { idx: 1, addr: LTC_SEGWIT_TAIL, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === LTC_SEGWIT_TAIL ? 1 : 5,
    }));
    const { rescanLitecoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanLitecoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(true);
    expect(out.extendChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 1 },
    ]);
    expect(out.unverifiedChains).toBeUndefined();
    expect(out.note).toMatch(/pair_ledger_ltc/);
  });

  it("surfaces unverifiedChains (NOT needsExtend) when the tail probe rejects", async () => {
    await seedSegwitReceiveChain([
      { idx: 0, addr: LTC_SEGWIT, txCount: 5 },
      { idx: 1, addr: LTC_SEGWIT_TAIL, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === LTC_SEGWIT_TAIL) {
        throw new Error("simulated 502 on the tail");
      }
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 5,
      };
    });
    const { rescanLitecoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanLitecoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(false);
    expect(out.extendChains).toBeUndefined();
    expect(out.unverifiedChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 1 },
    ]);
    expect(out.note).toMatch(/unverifiedChains/);
    expect(out.note).toMatch(/transient/);
  });

  it("persists txCount changes back to the pairing cache", async () => {
    await seedSegwitReceiveChain([
      { idx: 0, addr: LTC_SEGWIT, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockResolvedValue({
      address: LTC_SEGWIT,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 7,
    });
    const { rescanLitecoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanLitecoinAccount({ accountIndex: 0 });
    expect(out.txCountChanges).toBe(1);
    expect(out.refreshed[0].previousTxCount).toBe(0);
    expect(out.refreshed[0].txCount).toBe(7);
    expect(out.refreshed[0].delta).toBe(7);

    const { getPairedLtcByAddress } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    expect(getPairedLtcByAddress(LTC_SEGWIT)?.txCount).toBe(7);
  });
});
