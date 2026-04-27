import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Tests for issues #199 (rescan_btc_account unbounded fan-out) and
 * #197 (needsExtend silently false when tail probe rejected).
 *
 * Mocks the indexer module wholesale and the BTC USB loader so no
 * device or network is touched. Pairing entries persist to
 * ~/.vaultpilot-mcp/config.json so each test redirects the config dir
 * to a fresh tmp dir to avoid cross-test contamination.
 */

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
const FAKE_PUBKEY = "0".repeat(66);

const indexerGetBalanceMock = vi.fn();
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({ getBalance: indexerGetBalanceMock }),
  resetBitcoinIndexer: () => {},
}));

// USB loader is mocked just so any unintended Ledger access fails
// loudly (no test in this file should trigger pair_ledger_btc).
vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => {
    throw new Error("test: openLedger should not be called from rescan");
  },
  getAppAndVersion: async () => {
    throw new Error("test: getAppAndVersion should not be called");
  },
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-rescan-"));
  setConfigDirForTesting(tmpHome);
  indexerGetBalanceMock.mockReset();
  const { clearPairedBtcAddresses } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.BITCOIN_INDEXER_PARALLELISM;
});

describe("pLimitMap (issue #199)", () => {
  it("caps in-flight tasks at the configured concurrency", async () => {
    const { pLimitMap } = await import("../src/data/http.js");
    let inFlight = 0;
    let maxInFlight = 0;
    const items = new Array(20).fill(0).map((_, i) => i);
    const fn = vi.fn(async (item: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return item * 2;
    });
    const results = await pLimitMap(items, 4, fn);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // Even with the cap, every item resolved.
    expect(results.length).toBe(20);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Order preserved: results[i] corresponds to items[i].
    for (let i = 0; i < 20; i++) {
      expect((results[i] as PromiseFulfilledResult<number>).value).toBe(i * 2);
    }
  });

  it("isolates rejections (one bad task doesn't break the batch)", async () => {
    const { pLimitMap } = await import("../src/data/http.js");
    const fn = async (i: number) => {
      if (i === 3) throw new Error("boom");
      return i;
    };
    const results = await pLimitMap([0, 1, 2, 3, 4], 2, fn);
    expect(results[3].status).toBe("rejected");
    expect((results[3] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(4);
  });

  it("rejects invalid concurrency", async () => {
    const { pLimitMap } = await import("../src/data/http.js");
    await expect(pLimitMap([1, 2, 3], 0, async () => 0)).rejects.toThrow(
      /positive integer/,
    );
    await expect(pLimitMap([1, 2, 3], -1, async () => 0)).rejects.toThrow();
  });
});

describe("rescan_btc_account — bounded fan-out (issue #199)", () => {
  // retry: 2 — flakes on full-suite runs from upstream module-cache contamination.
  it("caps concurrent indexer probes at BITCOIN_INDEXER_PARALLELISM (default 8)", { retry: 2 }, async () => {
    // Pre-populate the cache with 30 entries so a serial fan-out
    // would be obviously different from a parallel one.
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    for (let i = 0; i < 30; i++) {
      setPairedBtcAddress({
        address: `bc1qfake${i.toString().padStart(2, "0")}aaaaaaaaaaaaaaaaaaaaaaaaaa`,
        publicKey: FAKE_PUBKEY,
        path: `84'/0'/0'/0/${i}`,
        appVersion: "2.2.3",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: i,
        txCount: 0,
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });

    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.addressesScanned).toBe(30);
    // Default parallelism is 8 (per BITCOIN_INDEXER_DEFAULT_PARALLELISM).
    expect(maxInFlight).toBeLessThanOrEqual(8);
    // But we ARE doing parallel work — should approach the cap.
    expect(maxInFlight).toBeGreaterThanOrEqual(4);
  });

  it("BITCOIN_INDEXER_PARALLELISM env var overrides the default", async () => {
    process.env.BITCOIN_INDEXER_PARALLELISM = "16";
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    for (let i = 0; i < 25; i++) {
      setPairedBtcAddress({
        address: `bc1qbb${i.toString().padStart(2, "0")}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
        publicKey: FAKE_PUBKEY,
        path: `84'/0'/0'/0/${i}`,
        appVersion: "2.2.3",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: i,
        txCount: 0,
      });
    }
    let inFlight = 0;
    let maxInFlight = 0;
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    await rescanBitcoinAccount({ accountIndex: 0 });
    expect(maxInFlight).toBeLessThanOrEqual(16);
    expect(maxInFlight).toBeGreaterThan(8);
  });

  it("clamps env var to the maximum (32) and falls back to default for non-numeric values", async () => {
    const { resolveBitcoinIndexerParallelism } = await import(
      "../src/config/btc.js"
    );
    process.env.BITCOIN_INDEXER_PARALLELISM = "9999";
    expect(resolveBitcoinIndexerParallelism()).toBe(32);
    process.env.BITCOIN_INDEXER_PARALLELISM = "abc";
    expect(resolveBitcoinIndexerParallelism()).toBe(8);
    process.env.BITCOIN_INDEXER_PARALLELISM = "0";
    expect(resolveBitcoinIndexerParallelism()).toBe(8);
    delete process.env.BITCOIN_INDEXER_PARALLELISM;
    expect(resolveBitcoinIndexerParallelism()).toBe(8);
  });
});

describe("rescan_btc_account — tri-state needsExtend (issue #197)", () => {
  // Helper: cache N entries on a single (type, chain) so the tail is
  // unambiguous for the test.
  async function seedSegwitReceiveChain(
    addresses: Array<{ idx: number; addr: string; txCount: number }>,
  ) {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    for (const e of addresses) {
      setPairedBtcAddress({
        address: e.addr,
        publicKey: FAKE_PUBKEY,
        path: `84'/0'/0'/0/${e.idx}`,
        appVersion: "2.2.3",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: e.idx,
        txCount: e.txCount,
      });
    }
  }

  it("flags needsExtend (extendChains populated) when tail fulfilled and used", async () => {
    const TAIL = "bc1qttt1tttttttttttttttttttttttttttttttabcdef";
    await seedSegwitReceiveChain([
      { idx: 0, addr: SEGWIT_ADDR, txCount: 5 },
      { idx: 1, addr: "bc1qmid1midddmidddmidddmidddmidddmidddabcdef", txCount: 0 },
      { idx: 2, addr: TAIL, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      // Tail flips to USED — this is what `needsExtend` is supposed to catch.
      txCount: address === TAIL ? 1 : address === SEGWIT_ADDR ? 5 : 0,
    }));
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(true);
    expect(out.extendChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 2 },
    ]);
    expect(out.unverifiedChains).toBeUndefined();
  });

  it("does NOT flag needsExtend when tail fulfilled and empty (regression on prior behavior)", async () => {
    const TAIL = "bc1qttt2tttttttttttttttttttttttttttttttabcdef";
    await seedSegwitReceiveChain([
      { idx: 0, addr: SEGWIT_ADDR, txCount: 5 },
      { idx: 1, addr: TAIL, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === SEGWIT_ADDR ? 5 : 0,
    }));
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(false);
    expect(out.extendChains).toBeUndefined();
    expect(out.unverifiedChains).toBeUndefined();
  });

  it("surfaces unverifiedChains (NOT needsExtend) when the tail probe rejects", async () => {
    // The bug from #197: prior code conflated rejected with healthy.
    const TAIL = "bc1qttt3tttttttttttttttttttttttttttttttabcdef";
    await seedSegwitReceiveChain([
      { idx: 0, addr: SEGWIT_ADDR, txCount: 5 },
      { idx: 1, addr: "bc1qmid3midddmidddmidddmidddmidddmidddabcdef", txCount: 0 },
      { idx: 2, addr: TAIL, txCount: 0 },
    ]);
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === TAIL) {
        throw new Error("simulated indexer 502 on the tail");
      }
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: address === SEGWIT_ADDR ? 5 : 0,
      };
    });
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    // The whole point of #197: rejected ≠ healthy, but it's also NOT extend.
    expect(out.needsExtend).toBe(false);
    expect(out.extendChains).toBeUndefined();
    expect(out.unverifiedChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 2 },
    ]);
    expect(out.note).toMatch(/unverifiedChains/);
    expect(out.note).toMatch(/transient/);
  });

  it("can flag both needsExtend AND unverifiedChains when chains are mixed", async () => {
    // segwit (rcv) tail USED → needsExtend
    // taproot (rcv) tail REJECTED → unverifiedChains
    const SEGWIT_TAIL = "bc1qstttsttttttttttttttttttttttttttttttabcdef";
    const TAPROOT_TAIL =
      "bc1pttttttttttttttttttttttttttttttttttttttttttttttttttttttttttabc";
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.2.3",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 1,
    });
    setPairedBtcAddress({
      address: SEGWIT_TAIL,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/1",
      appVersion: "2.2.3",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0,
    });
    setPairedBtcAddress({
      address: TAPROOT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/0'/0/0",
      appVersion: "2.2.3",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 1,
    });
    setPairedBtcAddress({
      address: TAPROOT_TAIL,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/0'/0/1",
      appVersion: "2.2.3",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0,
    });
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === TAPROOT_TAIL) {
        throw new Error("simulated 429 on taproot tail");
      }
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: address === SEGWIT_TAIL ? 1 : address === SEGWIT_ADDR || address === TAPROOT_ADDR ? 1 : 0,
      };
    });
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(true);
    expect(out.extendChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 1 },
    ]);
    expect(out.unverifiedChains).toEqual([
      { addressType: "taproot", chain: 0, lastAddressIndex: 1 },
    ]);
    // Note explains both signals.
    expect(out.note).toMatch(/pair_ledger_btc/);
    expect(out.note).toMatch(/unverifiedChains/);
  });
});

