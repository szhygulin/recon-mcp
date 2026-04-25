import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertBitcoinAddress,
  detectBitcoinAddressType,
  isBitcoinAddress,
} from "../src/modules/btc/address.js";
import { resetBitcoinIndexer } from "../src/modules/btc/indexer.js";

/**
 * Bitcoin PR1 — address validation, indexer abstraction, balances + fee
 * estimates + tx history. All HTTP IO mocked via vi.stubGlobal("fetch")
 * so tests don't touch mempool.space.
 *
 * Address fixtures are real mainnet addresses (Satoshi's first P2PKH,
 * SatoshiNakamoto.com's well-known taproot, etc.) — using real
 * addresses catches typos in the regex bounds without needing a
 * checksum verifier.
 */

// Real mainnet addresses, one per type (lengths must hit the regex bounds).
const P2PKH_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // Satoshi block 0 coinbase
const P2SH_ADDR = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"; // BIP-13 example
const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; // BIP-173 P2WPKH example
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg"; // Variable-length taproot from BIP-350
const TESTNET_ADDR = "tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwfllgu";

describe("address validation", () => {
  it("detects P2PKH legacy addresses", () => {
    expect(detectBitcoinAddressType(P2PKH_ADDR)).toBe("p2pkh");
    expect(isBitcoinAddress(P2PKH_ADDR)).toBe(true);
    expect(assertBitcoinAddress(P2PKH_ADDR)).toBe("p2pkh");
  });

  it("detects P2SH addresses", () => {
    expect(detectBitcoinAddressType(P2SH_ADDR)).toBe("p2sh");
  });

  it("detects native segwit (P2WPKH)", () => {
    expect(detectBitcoinAddressType(SEGWIT_ADDR)).toBe("p2wpkh");
  });

  it("detects taproot (P2TR)", () => {
    expect(detectBitcoinAddressType(TAPROOT_ADDR)).toBe("p2tr");
  });

  it("rejects testnet bech32 (tb1...) — Phase 1 is mainnet-only", () => {
    expect(detectBitcoinAddressType(TESTNET_ADDR)).toBeNull();
    expect(() => assertBitcoinAddress(TESTNET_ADDR)).toThrow(/Testnet\/signet/);
  });

  it("rejects garbage strings", () => {
    expect(detectBitcoinAddressType("0xnotvalidbtc")).toBeNull();
    expect(detectBitcoinAddressType("not-a-btc-address")).toBeNull();
    expect(detectBitcoinAddressType("")).toBeNull();
    expect(() => assertBitcoinAddress("0xnotvalidbtc")).toThrow(
      /not a valid Bitcoin mainnet address/,
    );
  });

  it("rejects bech32 with banned base32 chars (1, b, i, o)", () => {
    // Inject `o` (banned) into the data part — should be rejected.
    const bad = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5moq";
    expect(detectBitcoinAddressType(bad)).toBeNull();
  });
});

describe("indexer — getBalance", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
  });

  it("returns confirmed + mempool + total sats from Esplora address-stats", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`https://mempool.space/api/address/${TAPROOT_ADDR}`);
      return new Response(
        JSON.stringify({
          address: TAPROOT_ADDR,
          chain_stats: {
            funded_txo_count: 5,
            funded_txo_sum: 250_000_000, // 2.5 BTC funded
            spent_txo_count: 2,
            spent_txo_sum: 100_000_000, // 1.0 BTC spent
            tx_count: 7,
          },
          mempool_stats: {
            funded_txo_count: 1,
            funded_txo_sum: 5_000_000, // 0.05 BTC inbound, mempool
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 1,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const indexer = getBitcoinIndexer();
    const bal = await indexer.getBalance(TAPROOT_ADDR);
    expect(bal.address).toBe(TAPROOT_ADDR);
    expect(bal.confirmedSats).toBe(150_000_000n); // 2.5 - 1.0 = 1.5 BTC
    expect(bal.mempoolSats).toBe(5_000_000n);
    expect(bal.totalSats).toBe(155_000_000n);
    expect(bal.txCount).toBe(8);
  });

  it("throws on indexer HTTP failure", async () => {
    const fetchMock = vi.fn(async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    await expect(getBitcoinIndexer().getBalance(TAPROOT_ADDR)).rejects.toThrow(
      /returned 502/,
    );
  });
});

describe("indexer — getFeeEstimates", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
  });

  it("returns the five fee labels from mempool.space's recommended-fees endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://mempool.space/api/v1/fees/recommended");
      return new Response(
        JSON.stringify({
          fastestFee: 25,
          halfHourFee: 18,
          hourFee: 12,
          economyFee: 5,
          minimumFee: 1,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const fees = await getBitcoinIndexer().getFeeEstimates();
    expect(fees).toEqual({
      fastestFee: 25,
      halfHourFee: 18,
      hourFee: 12,
      economyFee: 5,
      minimumFee: 1,
    });
  });

  it("falls back to /fee-estimates when /v1/fees/recommended is unavailable", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      call++;
      if (call === 1) {
        expect(url).toBe("https://mempool.space/api/v1/fees/recommended");
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }
      // Second call: /fee-estimates
      expect(url).toBe("https://mempool.space/api/fee-estimates");
      return new Response(
        JSON.stringify({
          "1": 25,
          "3": 18,
          "6": 12,
          "144": 5,
          "1008": 1,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const fees = await getBitcoinIndexer().getFeeEstimates();
    expect(fees.fastestFee).toBe(25);
    expect(fees.halfHourFee).toBe(18);
    expect(fees.hourFee).toBe(12);
    expect(fees.economyFee).toBe(5);
    expect(fees.minimumFee).toBe(1);
  });
});

describe("indexer — getAddressTxs", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
  });

  it("summarizes received / sent / fee + RBF flag from Esplora payload", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            txid: "aa".repeat(32),
            vin: [
              {
                txid: "bb".repeat(32),
                vout: 0,
                prevout: { scriptpubkey_address: TAPROOT_ADDR, value: 200_000 },
                sequence: 0xfffffffd, // RBF-eligible
              },
            ],
            vout: [
              { scriptpubkey_address: "1Recipient...", value: 150_000 },
              { scriptpubkey_address: TAPROOT_ADDR, value: 49_000 }, // change
            ],
            fee: 1_000,
            status: { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 },
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const txs = await getBitcoinIndexer().getAddressTxs(TAPROOT_ADDR);
    expect(txs.length).toBe(1);
    const t = txs[0];
    expect(t.txid).toBe("aa".repeat(32));
    expect(t.sentSats).toBe(200_000n);
    expect(t.receivedSats).toBe(49_000n);
    expect(t.feeSats).toBe(1_000n);
    expect(t.blockHeight).toBe(800_000);
    expect(t.blockTime).toBe(1_700_000_000);
    expect(t.rbfEligible).toBe(true);
  });

  it("clamps the result to the requested limit", async () => {
    const fakeTx = (txid: string) => ({
      txid,
      vin: [],
      vout: [],
      fee: 0,
      status: { confirmed: true, block_height: 1, block_time: 0 },
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([fakeTx("aa"), fakeTx("bb"), fakeTx("cc")]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const txs = await getBitcoinIndexer().getAddressTxs(TAPROOT_ADDR, { limit: 2 });
    expect(txs.length).toBe(2);
  });
});

describe("indexer — getBlockTip (issue #183)", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
  });

  it("returns height + hash + timestamp + ageSeconds + optional fields", async () => {
    const fixedHash =
      "0000000000000000000123456789abcdef0123456789abcdef0123456789abcd";
    const blockTime = Math.floor(Date.now() / 1000) - 600; // ~10 min ago
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/blocks/tip/hash")) {
        return new Response(fixedHash, { status: 200 });
      }
      if (url.endsWith(`/block/${fixedHash}`)) {
        return new Response(
          JSON.stringify({
            id: fixedHash,
            height: 946_598,
            timestamp: blockTime,
            mediantime: blockTime - 300,
            difficulty: 110_568_428_300_421.94,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const tip = await getBitcoinIndexer().getBlockTip();
    expect(tip.height).toBe(946_598);
    expect(tip.hash).toBe(fixedHash);
    expect(tip.timestamp).toBe(blockTime);
    expect(tip.medianTimePast).toBe(blockTime - 300);
    expect(tip.difficulty).toBe(110_568_428_300_421.94);
    // ageSeconds: server-side computed; allow ±2s for test wall-clock drift.
    expect(tip.ageSeconds).toBeGreaterThanOrEqual(599);
    expect(tip.ageSeconds).toBeLessThanOrEqual(602);
  });

  it("omits medianTimePast/difficulty when the indexer doesn't expose them", async () => {
    const fixedHash =
      "0000000000000000000abcdef0123456789abcdef0123456789abcdef0123456";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/blocks/tip/hash")) {
        return new Response(fixedHash, { status: 200 });
      }
      // Esplora-pure stripped to just height/timestamp.
      return new Response(
        JSON.stringify({ height: 100, timestamp: 1_700_000_000 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    const tip = await getBitcoinIndexer().getBlockTip();
    expect(tip.height).toBe(100);
    expect(tip.medianTimePast).toBeUndefined();
    expect(tip.difficulty).toBeUndefined();
  });

  it("rejects a malformed tip-hash response (sanity check on the indexer URL)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>404</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    await expect(getBitcoinIndexer().getBlockTip()).rejects.toThrow(
      /not a 64-hex block hash/,
    );
  });

  it("throws on indexer HTTP failure", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    await expect(getBitcoinIndexer().getBlockTip()).rejects.toThrow(
      /returned 502/,
    );
  });
});

describe("indexer URL resolution", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
    delete process.env.BITCOIN_INDEXER_URL;
  });

  it("respects BITCOIN_INDEXER_URL env var", async () => {
    process.env.BITCOIN_INDEXER_URL = "https://my-esplora.example/api";
    const fetchMock = vi.fn(async (url: string) => {
      expect(url.startsWith("https://my-esplora.example/api/")).toBe(true);
      return new Response(
        JSON.stringify({
          address: P2PKH_ADDR,
          chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
          mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinIndexer } = await import("../src/modules/btc/indexer.js");
    await getBitcoinIndexer().getBalance(P2PKH_ADDR);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("balances — getBitcoinBalance / getBitcoinBalances", () => {
  beforeEach(() => {
    resetBitcoinIndexer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBitcoinIndexer();
  });

  it("formats sats as BTC decimal strings (8 decimal places, trailing zeros stripped)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          address: TAPROOT_ADDR,
          chain_stats: {
            funded_txo_count: 1,
            funded_txo_sum: 123_456_789, // 1.23456789 BTC
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 1,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalance } = await import("../src/modules/btc/balances.js");
    const bal = await getBitcoinBalance(TAPROOT_ADDR);
    expect(bal.confirmedSats).toBe(123_456_789n);
    expect(bal.confirmedBtc).toBe("1.23456789");
    expect(bal.totalBtc).toBe("1.23456789");
    expect(bal.addressType).toBe("p2tr");
    expect(bal.symbol).toBe("BTC");
    expect(bal.decimals).toBe(8);
  });

  it("formats whole BTC without trailing fractional dust", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          address: TAPROOT_ADDR,
          chain_stats: {
            funded_txo_count: 1,
            funded_txo_sum: 100_000_000, // exactly 1 BTC
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 1,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalance } = await import("../src/modules/btc/balances.js");
    const bal = await getBitcoinBalance(TAPROOT_ADDR);
    expect(bal.confirmedBtc).toBe("1");
  });

  it("multi-address fan-out: one ok, one errored — both surface", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            address: TAPROOT_ADDR,
            chain_stats: { funded_txo_count: 1, funded_txo_sum: 50_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
            mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response("Server Error", { status: 500, statusText: "Server Error" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalances } = await import("../src/modules/btc/balances.js");
    const results = await getBitcoinBalances([TAPROOT_ADDR, SEGWIT_ADDR]);
    expect(results.length).toBe(2);
    expect(results[0].ok).toBe(true);
    if (!results[0].ok) throw new Error("unreachable");
    expect(results[0].balance.confirmedSats).toBe(50_000n);
    expect(results[1].ok).toBe(false);
    if (results[1].ok) throw new Error("unreachable");
    expect(results[1].address).toBe(SEGWIT_ADDR);
    expect(results[1].error).toMatch(/500/);
  });

  it("rejects malformed addresses up-front before any fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getBitcoinBalances } = await import("../src/modules/btc/balances.js");
    await expect(
      getBitcoinBalances([TAPROOT_ADDR, "0xnotbtc"]),
    ).rejects.toThrow(/not a valid Bitcoin mainnet address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
