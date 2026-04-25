import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Bitcoin USB-HID pairing tests (Phase 1 PR2). Mocks the Ledger BTC SDK
 * via `vi.mock("../src/signing/btc-usb-loader.js")` so the test never
 * touches real USB. Pairing entries persist to ~/.vaultpilot-mcp/config.json,
 * so each test redirects the config dir to a fresh tmp dir.
 */

const LEGACY_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const P2SH_ADDR = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
const FAKE_PUBKEY = "0".repeat(66);
const FAKE_CHAIN_CODE = "0".repeat(64);

const getWalletPublicKeyMock = vi.fn();
const signMessageMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signMessage: signMessageMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
}));

// pair_ledger_btc's gap-limit scan piggybacks on the indexer's
// getBalance() to fetch txCount per derived address. Mock the entire
// indexer module so a fresh wallet (txCount=0 for everything) walks
// the gap window without any HTTP IO.
const indexerGetBalanceMock = vi.fn(async (address: string) => ({
  address,
  confirmedSats: 0n,
  mempoolSats: 0n,
  totalSats: 0n,
  txCount: 0,
}));
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: indexerGetBalanceMock,
  }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-pair-"));
  setConfigDirForTesting(tmpHome);
  getWalletPublicKeyMock.mockReset();
  signMessageMock.mockReset();
  transportCloseMock.mockClear();
  getAppAndVersionMock.mockReset();
  const { clearPairedBtcAddresses } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("btcPathForAccountIndex", () => {
  it("produces the standard 5-segment BIP-44/49/84/86 paths", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(btcPathForAccountIndex(0, "legacy")).toBe("44'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "p2sh-segwit")).toBe("49'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "segwit")).toBe("84'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "taproot")).toBe("86'/0'/0'/0/0");
    expect(btcPathForAccountIndex(7, "taproot")).toBe("86'/0'/7'/0/0");
  });

  it("rejects invalid account indices", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(() => btcPathForAccountIndex(-1, "taproot")).toThrow(/Invalid Bitcoin accountIndex/);
    expect(() => btcPathForAccountIndex(101, "taproot")).toThrow();
    expect(() => btcPathForAccountIndex(1.5, "taproot")).toThrow();
  });
});

describe("parseBtcPath", () => {
  it("decodes standard paths back into addressType + accountIndex + chain + addressIndex", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(parseBtcPath("44'/0'/0'/0/0")).toEqual({
      addressType: "legacy",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    expect(parseBtcPath("49'/0'/3'/1/5")).toEqual({
      addressType: "p2sh-segwit",
      accountIndex: 3,
      chain: 1,
      addressIndex: 5,
    });
    expect(parseBtcPath("84'/0'/7'/0/12")).toEqual({
      addressType: "segwit",
      accountIndex: 7,
      chain: 0,
      addressIndex: 12,
    });
    expect(parseBtcPath("86'/0'/12'/1/99")).toEqual({
      addressType: "taproot",
      accountIndex: 12,
      chain: 1,
      addressIndex: 99,
    });
  });

  it("returns null on non-standard paths", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Wrong purpose (mainnet only — no testnet purpose=1).
    expect(parseBtcPath("44'/1'/0'/0/0")).toBeNull();
    // Wrong segment count (account-level xpub path, not leaf).
    expect(parseBtcPath("84'/0'/0'")).toBeNull();
    // Invalid chain segment (only 0/1 allowed by BIP-44).
    expect(parseBtcPath("84'/0'/0'/2/0")).toBeNull();
    // Garbage.
    expect(parseBtcPath("not-a-path")).toBeNull();
  });
});

describe("btcLeafPath", () => {
  it("composes arbitrary BIP-32 leaf paths for receive + change chains", async () => {
    const { btcLeafPath } = await import("../src/signing/btc-usb-signer.js");
    expect(btcLeafPath(0, "segwit", 0, 0)).toBe("84'/0'/0'/0/0");
    expect(btcLeafPath(0, "segwit", 1, 5)).toBe("84'/0'/0'/1/5");
    expect(btcLeafPath(2, "taproot", 0, 12)).toBe("86'/0'/2'/0/12");
  });

  it("rejects out-of-range arguments", async () => {
    const { btcLeafPath } = await import("../src/signing/btc-usb-signer.js");
    expect(() => btcLeafPath(-1, "segwit", 0, 0)).toThrow();
    expect(() => btcLeafPath(0, "segwit", 2 as 0 | 1, 0)).toThrow(/chain/);
    expect(() => btcLeafPath(0, "segwit", 0, -1)).toThrow();
  });
});

describe("pairLedgerBitcoin (BIP44 gap-limit scan, issue #189)", () => {
  // Helper: synthesize a unique fake address for each derived path so
  // the in-memory cache (keyed by path) doesn't deduplicate. Real
  // checksum validation happens at signing time, not here.
  function fakeAddressForPath(path: string): string {
    // Deterministic per-path slug — use the SHA-1 of the whole path
    // (truncated to 12 hex chars) so each unique BIP-32 leaf gets a
    // distinct fake address. Earlier attempt sliced the raw path bytes
    // which collapsed to the same slug because the differing trailing
    // segments (chain/index) all share the leading 6 bytes.
    const hash = createHash("sha1").update(path).digest("hex").slice(0, 12);
    if (path.startsWith("44'")) return `1Fake${hash}H1nADuVeoUaqcJBZ`;
    if (path.startsWith("49'")) return `3Fake${hash}H1nADuVeoUaqcJBZ`;
    if (path.startsWith("84'"))
      return `bc1qfake${hash}h1naduveoaqcjbz1ypqsxz3y`;
    return `bc1pfake${hash}h1naduveoaqcjbz1ypqsxz3y`;
  }

  beforeEach(() => {
    indexerGetBalanceMock.mockReset();
    // Default: every address is empty (fresh wallet).
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 0,
    }));
  });

  it("walks gap-limit empty receive chains and skips change for a fresh wallet", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    getWalletPublicKeyMock.mockImplementation(async (path: string) => ({
      publicKey: FAKE_PUBKEY,
      bitcoinAddress: fakeAddressForPath(path),
      chainCode: FAKE_CHAIN_CODE,
    }));

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    // Use a smaller gapLimit to keep the test fast.
    const out = await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 });

    expect(out.accountIndex).toBe(0);
    expect(out.gapLimit).toBe(5);
    expect(out.appVersion).toBe("2.2.3");
    // 4 types × 1 chain (change skipped) × 5 gap-window = 20 addresses.
    expect(out.addresses).toHaveLength(20);
    // All on receive chain.
    expect(out.addresses.every((a) => a.chain === 0)).toBe(true);
    // Indices 0..4 per type.
    const segwitWalk = out.addresses
      .filter((a) => a.addressType === "segwit")
      .map((a) => a.addressIndex);
    expect(segwitWalk).toEqual([0, 1, 2, 3, 4]);
    expect(out.summary).toEqual({ totalDerived: 20, used: 0, unused: 20 });

    // 4 types × 5 derivations = 20 USB calls; one transport open.
    expect(getWalletPublicKeyMock).toHaveBeenCalledTimes(20);
    expect(indexerGetBalanceMock).toHaveBeenCalledTimes(20);
    expect(transportCloseMock).toHaveBeenCalledTimes(1);
  });

  it("walks both receive and change chains when receive has activity", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    getWalletPublicKeyMock.mockImplementation(async (path: string) => ({
      publicKey: FAKE_PUBKEY,
      bitcoinAddress: fakeAddressForPath(path),
      chainCode: FAKE_CHAIN_CODE,
    }));
    // Mark the segwit /0/0 (receive index 0) as USED. Every other
    // address stays at txCount=0. Receive chain stops after the gap
    // window FOLLOWING that single used entry; change chain runs too
    // because receive isn't fully empty.
    const segwitReceive0 = fakeAddressForPath("84'/0'/0'/0/0");
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === segwitReceive0 ? 1 : 0,
    }));

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 3 });

    // legacy/p2sh/taproot receives all empty → 3 chains × 3 = 9 entries.
    // segwit receive: index 0 used + 3 trailing empties = 4 entries.
    // segwit change: 3 empties (because receive wasn't fully empty).
    // Total: 9 + 4 + 3 = 16.
    expect(out.addresses).toHaveLength(16);
    expect(out.summary.used).toBe(1);
    // Verify the segwit change-chain was walked (chain=1 entries exist).
    const segwitChange = out.addresses.filter(
      (a) => a.addressType === "segwit" && a.chain === 1,
    );
    expect(segwitChange.length).toBe(3);
  });

  it("rejects gapLimit out of [1, 100]", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      pairLedgerBitcoin({ accountIndex: 0, gapLimit: 0 }),
    ).rejects.toThrow(/Invalid gapLimit/);
    await expect(
      pairLedgerBitcoin({ accountIndex: 0, gapLimit: 101 }),
    ).rejects.toThrow(/Invalid gapLimit/);
  });

  it("refuses when the wrong app is open on-device", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Ethereum", version: "1.10.4" });
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 })).rejects.toThrow(
      /open app as "Ethereum".*Bitcoin is required/,
    );
  });

  it("clears stale entries for an accountIndex before re-pairing", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    getWalletPublicKeyMock.mockImplementation(async (path: string) => ({
      publicKey: FAKE_PUBKEY,
      bitcoinAddress: fakeAddressForPath(path),
      chainCode: FAKE_CHAIN_CODE,
    }));
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    // First pair with gap=10 → 4 types × 10 entries = 40 cached.
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 10 });
    const { getPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(getPairedBtcAddresses()).toHaveLength(40);

    // Re-pair same account with smaller gap → must DROP the 40 stale
    // entries and end up with only the new 4 × 5 = 20.
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 });
    expect(getPairedBtcAddresses()).toHaveLength(20);
  });
});

describe("get_btc_account_balance (issue #189)", () => {
  it("aggregates confirmed sats across cached used-addresses for one account", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Two USED addresses (txCount > 0) on account 0; one UNUSED address
    // that should be skipped from the indexer fan-out.
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.2.3",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 5,
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
      txCount: 3,
    });
    const FRESH_RECEIVE = "bc1qfreshfreshfreshfreshfreshfreshfreshfre";
    setPairedBtcAddress({
      address: FRESH_RECEIVE,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/1",
      appVersion: "2.2.3",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0, // unused — should be skipped from the live fan-out
    });

    indexerGetBalanceMock.mockReset();
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === SEGWIT_ADDR) {
        return {
          address,
          confirmedSats: 100_000n,
          mempoolSats: 0n,
          totalSats: 100_000n,
          txCount: 5,
        };
      }
      if (address === TAPROOT_ADDR) {
        return {
          address,
          confirmedSats: 250_000n,
          mempoolSats: 50_000n,
          totalSats: 300_000n,
          txCount: 3,
        };
      }
      throw new Error(`unexpected address fan-out: ${address}`);
    });

    const { getBitcoinAccountBalance } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await getBitcoinAccountBalance({ accountIndex: 0 });
    expect(out.accountIndex).toBe(0);
    expect(out.addressesQueried).toBe(2); // skip the unused fresh-receive
    expect(out.addressesCached).toBe(3);
    expect(out.totalConfirmedSats).toBe("350000");
    expect(out.totalConfirmedBtc).toBe("0.0035");
    expect(out.totalMempoolSats).toBe("50000");
    expect(out.breakdown).toHaveLength(2);
    expect(indexerGetBalanceMock).toHaveBeenCalledTimes(2);
  });

  it("throws when no entries are cached for the requested accountIndex", async () => {
    const { getBitcoinAccountBalance } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      getBitcoinAccountBalance({ accountIndex: 99 }),
    ).rejects.toThrow(/No paired Bitcoin entries cached/);
  });
});

describe("clearPairedBtcAccount", () => {
  it("drops only entries matching the given accountIndex", async () => {
    const { setPairedBtcAddress, clearPairedBtcAccount, getPairedBtcAddresses } =
      await import("../src/signing/btc-usb-signer.js");
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.2.3",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    setPairedBtcAddress({
      address: TAPROOT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/1'/0/0",
      appVersion: "2.2.3",
      addressType: "taproot",
      accountIndex: 1,
      chain: 0,
      addressIndex: 0,
    });
    expect(getPairedBtcAddresses()).toHaveLength(2);
    clearPairedBtcAccount(0);
    const remaining = getPairedBtcAddresses();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].accountIndex).toBe(1);
  });
});

describe("get_ledger_status — btc section", () => {
  it("surfaces paired BTC entries with chain/addressIndex/txCount", async () => {
    // Reset the module cache + stub walletconnect so getSessionStatus's
    // getSignClient() call doesn't try to resolve a WC project ID under
    // CI (where WALLETCONNECT_PROJECT_ID is unset). Mirrors the TRON
    // get-ledger-status test's pattern. Also re-stub the indexer + USB
    // mocks since vi.resetModules() drops the file-scope mocks.
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
    }));
    vi.doMock("../src/signing/btc-usb-loader.js", () => ({
      openLedger: async () => ({
        app: {
          getWalletPublicKey: getWalletPublicKeyMock,
          signMessage: signMessageMock,
        },
        transport: { close: transportCloseMock },
        rawTransport: {},
      }),
      getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
    }));
    vi.doMock("../src/modules/btc/indexer.ts", () => ({
      getBitcoinIndexer: () => ({
        getBalance: async (address: string) => ({
          address,
          confirmedSats: 0n,
          mempoolSats: 0n,
          totalSats: 0n,
          txCount: 0,
        }),
      }),
      resetBitcoinIndexer: () => {},
    }));

    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.2.3" });
    let counter = 0;
    getWalletPublicKeyMock.mockImplementation(
      async (path: string, opts: { format: string }) => {
        counter++;
        // Synthesize a unique fake per call with type-correct prefixes.
        const slug = counter.toString().padStart(3, "0");
        const addr =
          opts.format === "legacy"
            ? `1Fake${slug}H1nADuVeoUaqcJBZ1Yp`
            : opts.format === "p2sh"
              ? `3Fake${slug}H1nADuVeoUaqcJBZ1Yp`
              : opts.format === "bech32"
                ? `bc1qfake${slug}h1naduveoaqcjbz1ypqsxz3yr`
                : `bc1pfake${slug}h1naduveoaqcjbz1ypqsxz3yr`;
        return {
          publicKey: FAKE_PUBKEY,
          bitcoinAddress: addr,
          chainCode: FAKE_CHAIN_CODE,
        };
      },
    );

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 3 });

    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeDefined();
    // 4 types × gap=3 (no change-chain walk for fresh wallet) = 12 entries.
    expect(status.bitcoin?.length).toBe(12);
    // Every entry carries the new fields.
    expect(
      status.bitcoin?.every(
        (e) => e.chain === 0 && typeof e.addressIndex === "number" && e.txCount === 0,
      ),
    ).toBe(true);
  });

  it("omits the btc section when no Bitcoin pairings are cached", async () => {
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
    }));
    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeUndefined();
  });
});
