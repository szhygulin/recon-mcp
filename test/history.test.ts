import { describe, it, expect, vi, beforeEach } from "vitest";
import { cache } from "../src/data/cache.js";

// We intercept the global fetch. Each test sets up responses per URL-substring
// via `routeMatch` rules in order; the first match wins and counters bump so
// assertions can check call counts.

type Route = {
  match: (url: string) => boolean;
  respond: (url: string) => { ok: boolean; status?: number; body: unknown };
};

let routes: Route[] = [];
let fetchCalls: string[] = [];

const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push(url);
  for (const r of routes) {
    if (r.match(url)) {
      const result = r.respond(url);
      const bodyText = JSON.stringify(result.body);
      return {
        ok: result.ok,
        status: result.status ?? (result.ok ? 200 : 500),
        statusText: result.ok ? "OK" : "ERR",
        text: async () => bodyText,
        json: async () => result.body,
      } as unknown as Response;
    }
  }
  throw new Error(`Unmatched fetch URL in test: ${url}`);
});

beforeEach(() => {
  routes = [];
  fetchCalls = [];
  fakeFetch.mockClear();
  cache.clear();
  // Override global fetch. Node 18+ uses global fetch; vi.stubGlobal handles it.
  vi.stubGlobal("fetch", fakeFetch);
  // Stub API key — Etherscan V2 requires one. Tests mock fetch so the value
  // never hits the wire; without this, test runs on clean machines (CI) would
  // throw EtherscanApiKeyMissingError before hitting the mock.
  vi.stubEnv("ETHERSCAN_API_KEY", "test-key");
});

const WALLET = "0x1234567890123456789012345678901234567890";
const TRON_WALLET = "TXYZabcdefghijkmnopqrstuvwxyz23456";

function actionOf(url: string): string | undefined {
  const m = url.match(/[?&]action=([^&]+)/);
  return m ? m[1] : undefined;
}

function chainIdOf(url: string): string | undefined {
  const m = url.match(/[?&]chainid=([^&]+)/);
  return m ? m[1] : undefined;
}

/**
 * V2 URL shape: https://api.etherscan.io/v2/api?chainid=N&module=...&action=...&apikey=...
 * The matcher pins the V2 path prefix explicitly so a regression to V1
 * (`api.etherscan.io/api?...`) would fall through to the "unmatched fetch"
 * throw rather than silently matching.
 */
function etherscanOk(action: string, result: unknown[]) {
  return {
    match: (url: string) =>
      url.includes("api.etherscan.io/v2/api") && actionOf(url) === action && chainIdOf(url) !== undefined,
    respond: () => ({ ok: true, body: { status: "1", message: "OK", result } }),
  };
}

function etherscanNoTx(action: string) {
  return {
    match: (url: string) =>
      url.includes("api.etherscan.io/v2/api") && actionOf(url) === action && chainIdOf(url) !== undefined,
    respond: () => ({
      ok: true,
      body: { status: "0", message: "No transactions found", result: [] },
    }),
  };
}

/** V1-style response used in the deprecation-reproduction test. */
function etherscanDeprecated(action: string) {
  return {
    match: (url: string) =>
      url.includes("api.etherscan.io/v2/api") && actionOf(url) === action,
    respond: () => ({
      ok: true,
      body: {
        status: "0",
        message: "NOTOK",
        result: "You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration",
      },
    }),
  };
}

function llamaOk(coins: Record<string, { price: number }>) {
  return {
    match: (url: string) => url.includes("coins.llama.fi/prices/historical"),
    respond: () => ({ ok: true, body: { coins } }),
  };
}

function llamaNotFound() {
  return {
    match: (url: string) => url.includes("coins.llama.fi/prices/historical"),
    respond: () => ({ ok: false, status: 404, body: {} }),
  };
}

function fourbyteOk(sigs: string[]) {
  return {
    match: (url: string) => url.includes("4byte.directory"),
    respond: () => ({
      ok: true,
      body: { results: sigs.map((s) => ({ text_signature: s })) },
    }),
  };
}

function trongridOk(path: string, data: unknown[]) {
  return {
    match: (url: string) => url.includes("trongrid.io") && url.includes(path),
    respond: () => ({ ok: true, body: { data } }),
  };
}

describe("get_transaction_history: EVM merge + sort + truncate", () => {
  it("merges external/tokentx/internal and returns desc-by-timestamp", async () => {
    routes = [
      etherscanOk("txlist", [
        {
          hash: "0xaaa",
          timeStamp: "1700000000",
          from: WALLET,
          to: "0x000000000000000000000000000000000000dead",
          value: "1000000000000000000",
          input: "0x",
          isError: "0",
          txreceipt_status: "1",
        },
        {
          hash: "0xbbb",
          timeStamp: "1700000200",
          from: WALLET,
          to: "0x000000000000000000000000000000000000beef",
          value: "0",
          input: "0xa9059cbb00000000",
          isError: "0",
          txreceipt_status: "1",
        },
      ]),
      etherscanOk("tokentx", [
        {
          hash: "0xccc",
          timeStamp: "1700000100",
          from: WALLET,
          to: "0x1111111111111111111111111111111111111111",
          contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          value: "500000",
          tokenSymbol: "USDC",
          tokenName: "USD Coin",
          tokenDecimal: "6",
        },
      ]),
      etherscanOk("txlistinternal", [
        {
          hash: "0xddd",
          timeStamp: "1700000300",
          from: "0x1111111111111111111111111111111111111111",
          to: WALLET,
          value: "250000000000000000",
          isError: "0",
          traceId: "0_1",
        },
      ]),
      fourbyteOk(["transfer(address,uint256)"]),
      llamaOk({
        "coingecko:ethereum": { price: 2000 },
        "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { price: 1 },
      }),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });

    expect(res.items.length).toBe(4);
    // Sorted desc by timestamp.
    expect(res.items.map((i) => i.timestamp)).toEqual([
      1700000300, 1700000200, 1700000100, 1700000000,
    ]);
    // Internal, external, token_transfer, external.
    expect(res.items.map((i) => i.type)).toEqual([
      "internal",
      "external",
      "token_transfer",
      "external",
    ]);
    // Method name decoded on the external tx that had calldata.
    const externalWithCalldata = res.items.find(
      (i): i is Extract<typeof res.items[number], { type: "external" }> =>
        i.type === "external" && i.hash === "0xbbb"
    );
    expect(externalWithCalldata?.methodName).toBe("transfer");
  });

  it("truncates to limit when merged results exceed it", async () => {
    const txs = Array.from({ length: 30 }, (_, i) => ({
      hash: `0x${i.toString().padStart(3, "0")}`,
      timeStamp: String(1700000000 + i * 100),
      from: WALLET,
      to: "0x0000000000000000000000000000000000000001",
      value: "0",
      input: "0x",
      isError: "0",
      txreceipt_status: "1",
    }));
    routes = [
      etherscanOk("txlist", txs),
      etherscanNoTx("tokentx"),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 10,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(res.items.length).toBe(10);
    expect(res.truncated).toBe(true);
  });
});

describe("get_transaction_history: phishing-token sanitization", () => {
  it("drops tokentx rows whose symbol contains a URL or claim-bait", async () => {
    routes = [
      etherscanNoTx("txlist"),
      etherscanOk("tokentx", [
        {
          hash: "0xsafe",
          timeStamp: "1700000000",
          from: WALLET,
          to: "0x2222222222222222222222222222222222222222",
          contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          value: "100",
          tokenSymbol: "USDC",
          tokenName: "USD Coin",
          tokenDecimal: "6",
        },
        {
          hash: "0xphishing",
          timeStamp: "1700000100",
          from: "0xdead000000000000000000000000000000000000",
          to: WALLET,
          contractAddress: "0x9999999999999999999999999999999999999999",
          value: "1000000000",
          tokenSymbol: "CLAIM https://evil.example",
          tokenName: "Visit to claim",
          tokenDecimal: "6",
        },
      ]),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    expect(item.type).toBe("token_transfer");
    if (item.type === "token_transfer") expect(item.tokenSymbol).toBe("USDC");
  });
});

describe("get_transaction_history: price degradation", () => {
  it("surfaces priceCoverage=none and leaves valueUsd absent when DefiLlama 404s", async () => {
    routes = [
      etherscanOk("txlist", [
        {
          hash: "0xaaa",
          timeStamp: "1700000000",
          from: WALLET,
          to: "0x000000000000000000000000000000000000dead",
          value: "1000000000000000000",
          input: "0x",
          isError: "0",
          txreceipt_status: "1",
        },
      ]),
      etherscanNoTx("tokentx"),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(res.priceCoverage).toBe("none");
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    if (item.type === "external") expect(item.valueUsd).toBeUndefined();
  });
});

describe("get_transaction_history: TRON dispatch", () => {
  it("routes TRON wallet to TronGrid and ignores includeInternal without error", async () => {
    routes = [
      trongridOk("/transactions/trc20", [
        {
          transaction_id: "0xtrc",
          block_timestamp: 1700000000000,
          from: "TFromAddress000000000000000000000",
          to: TRON_WALLET,
          value: "1000000",
          token_info: {
            address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            decimals: 6,
            symbol: "USDT",
          },
        },
      ]),
      trongridOk("/transactions", []),
      llamaOk({
        "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t": { price: 1 },
      }),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: TRON_WALLET,
      chain: "tron",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(res.items.length).toBe(1);
    expect(res.items[0].type).toBe("token_transfer");
    const item = res.items[0];
    if (item.type === "token_transfer") {
      expect(item.tokenSymbol).toBe("USDT");
      expect(item.valueUsd).toBe(1);
    }
  });
});

describe("get_transaction_history: timestamp filter", () => {
  it("excludes items outside [startTimestamp, endTimestamp]", async () => {
    routes = [
      etherscanOk("txlist", [
        {
          hash: "0xold",
          timeStamp: "1600000000",
          from: WALLET,
          to: "0x000000000000000000000000000000000000dead",
          value: "0",
          input: "0x",
          isError: "0",
          txreceipt_status: "1",
        },
        {
          hash: "0xmid",
          timeStamp: "1700000000",
          from: WALLET,
          to: "0x000000000000000000000000000000000000dead",
          value: "0",
          input: "0x",
          isError: "0",
          txreceipt_status: "1",
        },
      ]),
      etherscanNoTx("tokentx"),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
      startTimestamp: 1650000000,
      endTimestamp: 1750000000,
    });
    expect(res.items.length).toBe(1);
    expect(res.items[0].hash).toBe("0xmid");
  });
});

describe("get_transaction_history: V2 migration", () => {
  it("sends chainid=1 for ethereum and chainid=42161 for arbitrum", async () => {
    routes = [
      etherscanNoTx("txlist"),
      etherscanNoTx("tokentx"),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];
    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(fetchCalls.every((u) => !u.includes("api.etherscan.io/v2/api") || chainIdOf(u) === "1")).toBe(
      true
    );

    fetchCalls = [];
    cache.clear();
    await getTransactionHistory({
      wallet: WALLET,
      chain: "arbitrum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(
      fetchCalls.every((u) => !u.includes("api.etherscan.io/v2/api") || chainIdOf(u) === "42161")
    ).toBe(true);
  });

  it("propagates a clear error when ETHERSCAN_API_KEY is missing", async () => {
    vi.unstubAllEnvs();
    // Also make sure the user-config lookup doesn't resolve a key from disk —
    // mock readUserConfig to return null so the test is deterministic on the
    // developer's machine regardless of ~/.vaultpilot-mcp/config.json.
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
        "../src/config/user-config.js"
      );
      return { ...actual, readUserConfig: () => null };
    });
    vi.resetModules();
    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    await expect(
      getTransactionHistory({
        wallet: WALLET,
        chain: "ethereum",
        limit: 25,
        includeExternal: true,
        includeTokenTransfers: true,
        includeInternal: true,
      })
    ).rejects.toThrow(/ETHERSCAN_API_KEY/);
    vi.doUnmock("../src/config/user-config.js");
    vi.resetModules();
  });

  it("surfaces the V1-deprecation `result` field in error messages", async () => {
    routes = [
      etherscanDeprecated("txlist"),
      etherscanDeprecated("tokentx"),
      etherscanDeprecated("txlistinternal"),
      llamaNotFound(),
    ];
    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    const res = await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    expect(res.items.length).toBe(0);
    expect(res.errors?.length).toBe(3);
    const joined = (res.errors ?? []).map((e) => e.message).join(" | ");
    expect(joined).toContain("deprecated V1 endpoint");
  });
});

describe("get_transaction_history: cache", () => {
  it("second call within TTL does not re-hit Etherscan", async () => {
    routes = [
      etherscanOk("txlist", [
        {
          hash: "0xaaa",
          timeStamp: "1700000000",
          from: WALLET,
          to: "0x000000000000000000000000000000000000dead",
          value: "0",
          input: "0x",
          isError: "0",
          txreceipt_status: "1",
        },
      ]),
      etherscanNoTx("tokentx"),
      etherscanNoTx("txlistinternal"),
      llamaNotFound(),
    ];

    const { getTransactionHistory } = await import("../src/modules/history/index.js");
    await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    const etherscanCallsAfterFirst = fetchCalls.filter((u) => u.includes("etherscan.io")).length;

    await getTransactionHistory({
      wallet: WALLET,
      chain: "ethereum",
      limit: 25,
      includeExternal: true,
      includeTokenTransfers: true,
      includeInternal: true,
    });
    const etherscanCallsAfterSecond = fetchCalls.filter((u) => u.includes("etherscan.io")).length;

    expect(etherscanCallsAfterFirst).toBe(3);
    expect(etherscanCallsAfterSecond).toBe(3);
  });
});
