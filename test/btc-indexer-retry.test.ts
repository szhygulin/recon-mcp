import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for `EsploraIndexer.getJson` retry behavior on transient
 * failures (HTTP 429, network errors). Issue #199 — without retry, a
 * single rate-limit response from mempool.space drops the cached
 * txCount refresh for that address until the next manual rescan.
 *
 * Kept in a SEPARATE FILE from `btc-rescan-throttle-tristate.test.ts`
 * because it needs the REAL `EsploraIndexer` module (not the mock the
 * other file installs at file scope) — `vi.unmock` is module-global
 * within a worker, so co-locating the two breaks the file-scope mock
 * for tests scheduled later in the same describe.
 */

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function freshIndexer() {
  return import("../src/modules/btc/indexer.js").then(
    ({ getBitcoinIndexer, resetBitcoinIndexer }) => {
      resetBitcoinIndexer();
      return getBitcoinIndexer();
    },
  );
}

const balancePayload = {
  address: SEGWIT_ADDR,
  chain_stats: {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  },
  mempool_stats: {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  },
};

describe("EsploraIndexer — retry on 429 / network error (issue #199)", () => {
  it("retries once on HTTP 429 and honors Retry-After (seconds)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(balancePayload), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    const out = await indexer.getBalance(SEGWIT_ADDR);
    expect(out.txCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on HTTP 429 with no Retry-After header (uses jittered backoff)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(balancePayload), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    const out = await indexer.getBalance(SEGWIT_ADDR);
    expect(out.txCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the 429 error after the second 429 response (does NOT retry forever)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    await expect(indexer.getBalance(SEGWIT_ADDR)).rejects.toThrow(
      /returned 429/,
    );
    // Single retry: original + 1 retry = 2 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on a network error and surfaces the error if both fail", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    await expect(indexer.getBalance(SEGWIT_ADDR)).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first network error is followed by a successful response", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(balancePayload), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    const out = await indexer.getBalance(SEGWIT_ADDR);
    expect(out.txCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on HTTP 5xx (caller decides whether to rerun)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream broken", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    await expect(indexer.getBalance(SEGWIT_ADDR)).rejects.toThrow(
      /returned 503/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on HTTP 4xx other than 429 (e.g. 400 = bad request)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("malformed", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const indexer = await freshIndexer();
    await expect(indexer.getBalance(SEGWIT_ADDR)).rejects.toThrow(
      /returned 400/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
