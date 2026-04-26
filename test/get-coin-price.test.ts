import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cache } from "../src/data/cache.js";

/**
 * Unit tests for `get_coin_price` (issue #274) and the underlying
 * `getDefillamaCoinPrice` helper. The DefiLlama HTTP layer is mocked
 * via `vi.stubGlobal("fetch", …)` so no real network is involved.
 */

const fetchMock = vi.fn(async (url: string) => {
  // Default: empty response. Individual tests override.
  return new Response(JSON.stringify({ coins: {} }));
}) as unknown as typeof fetch;

beforeEach(() => {
  cache.clear();
  vi.stubGlobal("fetch", fetchMock);
  (fetchMock as unknown as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSymbolToCoingeckoId — allowlist", () => {
  it("resolves canonical tickers (case-insensitive)", async () => {
    const { resolveSymbolToCoingeckoId } = await import("../src/data/coin-allowlist.js");
    expect(resolveSymbolToCoingeckoId("BTC")).toBe("bitcoin");
    expect(resolveSymbolToCoingeckoId("btc")).toBe("bitcoin");
    expect(resolveSymbolToCoingeckoId("ltc")).toBe("litecoin");
    expect(resolveSymbolToCoingeckoId("SOL")).toBe("solana");
    expect(resolveSymbolToCoingeckoId("USDC")).toBe("usd-coin");
    // Trim whitespace.
    expect(resolveSymbolToCoingeckoId("  doge  ")).toBe("dogecoin");
  });

  it("returns undefined for symbols not on the allowlist", async () => {
    const { resolveSymbolToCoingeckoId } = await import("../src/data/coin-allowlist.js");
    expect(resolveSymbolToCoingeckoId("FAKETICKER")).toBeUndefined();
    expect(resolveSymbolToCoingeckoId("")).toBeUndefined();
  });

  it("knows about the issue's seed list (smoke check)", async () => {
    const { resolveSymbolToCoingeckoId } = await import("../src/data/coin-allowlist.js");
    // Spot-check the seed tickers from the issue body so a future PR
    // that accidentally drops one of them surfaces here.
    const required = ["btc", "eth", "sol", "ltc", "usdc", "usdt", "doge", "ada", "trx", "atom", "xmr", "etc", "xrp"];
    for (const sym of required) {
      expect(resolveSymbolToCoingeckoId(sym)).toBeDefined();
    }
  });

  it("polygon ticker resolves to the post-rebrand id (POL not MATIC)", async () => {
    const { resolveSymbolToCoingeckoId } = await import("../src/data/coin-allowlist.js");
    // CoinGecko renamed `matic-network` → `polygon-ecosystem-token` in 2024.
    // The `matic` legacy alias should still resolve to the new id.
    expect(resolveSymbolToCoingeckoId("pol")).toBe("polygon-ecosystem-token");
    expect(resolveSymbolToCoingeckoId("matic")).toBe("polygon-ecosystem-token");
  });
});

describe("getDefillamaCoinPrice — DefiLlama integration", () => {
  it("fetches and returns the price entry on a happy-path response", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          coins: {
            "coingecko:litecoin": {
              price: 100.5,
              symbol: "LTC",
              decimals: 8,
              timestamp: 1750000000,
              confidence: 0.95,
            },
          },
        }),
      ),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    const entry = await getDefillamaCoinPrice("litecoin");
    expect(entry).toEqual({
      price: 100.5,
      symbol: "LTC",
      decimals: 8,
      timestamp: 1750000000,
      confidence: 0.95,
    });
  });

  it("normalizes the ID (trim + lowercase)", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: { "coingecko:bitcoin": { price: 1 } } })),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    const entry = await getDefillamaCoinPrice("  Bitcoin  ");
    expect(entry?.price).toBe(1);
    // The mock URL should have used the lowercased + trimmed id.
    const calledUrl = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(decodeURIComponent(calledUrl)).toContain("coingecko:bitcoin");
    expect(decodeURIComponent(calledUrl)).not.toContain("Bitcoin");
  });

  it("returns undefined when DefiLlama has no entry", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} })),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    expect(await getDefillamaCoinPrice("nonexistent-coin-xyz")).toBeUndefined();
  });

  it("returns undefined on HTTP error (degrades gracefully)", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("err", { status: 500 }),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    expect(await getDefillamaCoinPrice("litecoin")).toBeUndefined();
  });

  it("returns undefined on fetch throw (network error)", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ENOTFOUND coins.llama.fi"),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    expect(await getDefillamaCoinPrice("litecoin")).toBeUndefined();
  });

  it("rejects empty IDs without hitting the network", async () => {
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    expect(await getDefillamaCoinPrice("")).toBeUndefined();
    expect(await getDefillamaCoinPrice("   ")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches successful responses (second call hits cache, no second fetch)", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ coins: { "coingecko:litecoin": { price: 100 } } })),
    );
    const { getDefillamaCoinPrice } = await import("../src/data/prices.js");
    await getDefillamaCoinPrice("litecoin");
    await getDefillamaCoinPrice("litecoin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCoinPriceTool — public tool surface", () => {
  it("happy path: symbol → resolved price + envelope", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          coins: {
            "coingecko:litecoin": {
              price: 100,
              symbol: "LTC",
              timestamp: 1750000000,
              confidence: 0.92,
            },
          },
        }),
      ),
    );
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    const out = await getCoinPriceTool({ symbol: "LTC" });
    expect(out).toEqual({
      symbol: "LTC",
      priceUsd: 100,
      source: "defillama-coingecko",
      resolvedKey: "coingecko:litecoin",
      asOf: 1750000000,
      confidence: 0.92,
    });
  });

  it("happy path: coingeckoId escape hatch (long-tail asset)", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          coins: { "coingecko:nervous-system": { price: 0.42, symbol: "NRV" } },
        }),
      ),
    );
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    const out = await getCoinPriceTool({ coingeckoId: "nervous-system" });
    expect(out.symbol).toBe("NRV");
    expect(out.priceUsd).toBe(0.42);
    expect(out.resolvedKey).toBe("coingecko:nervous-system");
    expect(out.confidence).toBeUndefined();
  });

  it("rejects unknown symbol with a helpful error pointing at coingeckoId escape", async () => {
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    await expect(getCoinPriceTool({ symbol: "THIS_IS_NOT_REAL" })).rejects.toThrow(
      /not on the curated symbol allowlist/,
    );
    await expect(getCoinPriceTool({ symbol: "THIS_IS_NOT_REAL" })).rejects.toThrow(
      /coingeckoId/,
    );
  });

  it("rejects empty input (neither symbol nor coingeckoId)", async () => {
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    await expect(getCoinPriceTool({})).rejects.toThrow(/Pass exactly one/);
  });

  it("rejects both symbol AND coingeckoId (XOR enforcement)", async () => {
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    await expect(
      getCoinPriceTool({ symbol: "LTC", coingeckoId: "litecoin" }),
    ).rejects.toThrow(/Pass exactly one/);
  });

  it("surfaces a typo-friendly error when DefiLlama returns no entry", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} })),
    );
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    await expect(
      getCoinPriceTool({ coingeckoId: "made-up-id-xyz" }),
    ).rejects.toThrow(/no price for "coingecko:made-up-id-xyz"/);
  });

  it("uses the symbol's UPPERCASE display when no upstream symbol is provided", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ coins: { "coingecko:litecoin": { price: 100 } } }),
      ),
    );
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    // Pass lowercase — the response has no symbol field, so we should
    // get back the user's input UPPERCASED.
    const out = await getCoinPriceTool({ symbol: "ltc" });
    expect(out.symbol).toBe("LTC");
  });

  it("omits asOf and confidence from envelope when DefiLlama doesn't return them", async () => {
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ coins: { "coingecko:bitcoin": { price: 50000 } } }),
      ),
    );
    const { getCoinPriceTool } = await import("../src/modules/prices/index.js");
    const out = await getCoinPriceTool({ symbol: "BTC" });
    expect(out.priceUsd).toBe(50000);
    expect("asOf" in out).toBe(false);
    expect("confidence" in out).toBe(false);
  });
});
