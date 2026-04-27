/**
 * Tests for the three NFT tools (`get_nft_portfolio`,
 * `get_nft_collection`, `get_nft_history`). Mocks the global `fetch`
 * via `fetchWithTimeout`'s underlying call so no live HTTP fires.
 *
 * Coverage:
 *   - get_nft_portfolio happy path: 2-chain fan-out, per-collection
 *     aggregation, USD rollup, sort desc by total value.
 *   - get_nft_portfolio rate-limit: 429 on one chain → coverage flags
 *     it, other chain still surfaces, setup hint in notes.
 *   - get_nft_portfolio filters: minFloorEth, collections whitelist.
 *   - get_nft_collection happy path: floor, top bid, volume rollups,
 *     royalty.
 *   - get_nft_collection — no listings → notes flag + floor absent.
 *   - get_nft_history happy path: 2-chain merge, sorted desc by
 *     timestamp, capped at limit.
 *   - get_nft_history truncation flag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/data/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchMock(...a),
}));

const fetchMock = vi.fn();

vi.mock("../src/config/user-config.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/config/user-config.ts")>();
  return {
    ...actual,
    readUserConfig: vi.fn().mockReturnValue(null),
    resolveReservoirApiKey: vi.fn().mockReturnValue(undefined),
  };
});

const WALLET = "0x000000000000000000000000000000000000dEaD";
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const PUDGY = "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8";
const PHISHY = "0x9999999999999999999999999999999999999999";

interface MockResponse {
  status: number;
  body: unknown;
}

/**
 * Build a vitest-friendly `Response`-like stub from the mocked
 * `fetchWithTimeout`. Has the minimal shape the Reservoir client uses:
 * `ok` / `status` / `text()`.
 */
function fakeResponse(opts: MockResponse): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
} {
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    text: async () => JSON.stringify(opts.body),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_nft_portfolio — happy path", () => {
  it("merges 2-chain results, aggregates per collection, sorts desc by total floor USD", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // Ethereum: 2 BAYCs (one row) + 1 PUDGY → 2 collections
      if (url.includes("api.reservoir.tools")) {
        return fakeResponse({
          status: 200,
          body: {
            tokens: [
              {
                token: {
                  contract: BAYC,
                  tokenId: "100",
                  name: "BAYC #100",
                  collection: {
                    id: BAYC,
                    name: "Bored Ape Yacht Club",
                    slug: "boredapeyachtclub",
                    floorAskPrice: {
                      amount: { decimal: 25, usd: 65000 },
                      currency: { symbol: "ETH" },
                    },
                  },
                },
                ownership: { tokenCount: "1" },
              },
              {
                token: {
                  contract: BAYC,
                  tokenId: "101",
                  collection: {
                    id: BAYC,
                    name: "Bored Ape Yacht Club",
                    floorAskPrice: {
                      amount: { decimal: 25, usd: 65000 },
                      currency: { symbol: "ETH" },
                    },
                  },
                },
                ownership: { tokenCount: "1" },
              },
              {
                token: {
                  contract: PUDGY,
                  tokenId: "1",
                  collection: {
                    id: PUDGY,
                    name: "Pudgy Penguins",
                    floorAskPrice: {
                      amount: { decimal: 8, usd: 20800 },
                      currency: { symbol: "ETH" },
                    },
                  },
                },
                ownership: { tokenCount: "1" },
              },
            ],
          },
        });
      }
      // Arbitrum: 1 random collection
      if (url.includes("api-arbitrum.reservoir.tools")) {
        return fakeResponse({
          status: 200,
          body: {
            tokens: [
              {
                token: {
                  contract: PHISHY,
                  tokenId: "1",
                  collection: {
                    id: PHISHY,
                    name: "Some L2 Collection",
                    floorAskPrice: {
                      amount: { decimal: 0.05, usd: 130 },
                      currency: { symbol: "ETH" },
                    },
                  },
                },
                ownership: { tokenCount: "1" },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { getNftPortfolio } = await import("../src/modules/nft/index.ts");
    const r = await getNftPortfolio({
      wallet: WALLET,
      chains: ["ethereum", "arbitrum"],
    });

    expect(r.coverage).toHaveLength(2);
    expect(r.coverage.every((c) => !c.errored)).toBe(true);

    // 3 unique collections, 4 tokens.
    expect(r.collectionCount).toBe(3);
    expect(r.totalTokenCount).toBe(4);

    // Sorted desc: BAYC ($130k) > PUDGY ($20.8k) > L2 ($130).
    expect(r.rows[0].collectionName).toBe("Bored Ape Yacht Club");
    expect(r.rows[0].tokenCount).toBe(2);
    expect(r.rows[0].totalFloorUsd).toBe(130_000);
    expect(r.rows[1].collectionName).toBe("Pudgy Penguins");
    expect(r.rows[2].chain).toBe("arbitrum");

    expect(r.totalFloorUsd).toBe(130_000 + 20_800 + 130);
    // Floor != liquidation note always present.
    expect(r.notes.some((n) => n.toLowerCase().includes("floor"))).toBe(true);
  });
});

describe("get_nft_portfolio — rate-limit + filters", () => {
  it("flags rate-limited chains in coverage and surfaces the setup hint", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.reservoir.tools")) {
        // Ethereum returns one row.
        return fakeResponse({
          status: 200,
          body: {
            tokens: [
              {
                token: {
                  contract: BAYC,
                  tokenId: "100",
                  collection: {
                    id: BAYC,
                    name: "BAYC",
                    floorAskPrice: {
                      amount: { decimal: 25, usd: 65000 },
                      currency: { symbol: "ETH" },
                    },
                  },
                },
                ownership: { tokenCount: "1" },
              },
            ],
          },
        });
      }
      // Arbitrum is rate-limited.
      return fakeResponse({ status: 429, body: { message: "Rate limited" } });
    });

    const { getNftPortfolio } = await import("../src/modules/nft/index.ts");
    const r = await getNftPortfolio({
      wallet: WALLET,
      chains: ["ethereum", "arbitrum"],
    });

    expect(r.rows).toHaveLength(1);
    expect(r.coverage.find((c) => c.chain === "arbitrum")?.errored).toBe(true);
    expect(r.coverage.find((c) => c.chain === "arbitrum")?.reason).toBe(
      "rate_limited",
    );
    expect(r.notes.some((n) => n.toLowerCase().includes("rate"))).toBe(true);
    expect(r.notes.some((n) => n.includes("RESERVOIR_API_KEY"))).toBe(true);
  });

  it("respects minFloorEth filter — drops rows below threshold", async () => {
    fetchMock.mockImplementation(async () =>
      fakeResponse({
        status: 200,
        body: {
          tokens: [
            {
              token: {
                contract: BAYC,
                tokenId: "100",
                collection: {
                  id: BAYC,
                  name: "BAYC",
                  floorAskPrice: { amount: { decimal: 25, usd: 65000 } },
                },
              },
              ownership: { tokenCount: "1" },
            },
            {
              token: {
                contract: PHISHY,
                tokenId: "1",
                collection: {
                  id: PHISHY,
                  name: "Spam",
                  floorAskPrice: { amount: { decimal: 0.001, usd: 2.6 } },
                },
              },
              ownership: { tokenCount: "1" },
            },
          ],
        },
      }),
    );

    const { getNftPortfolio } = await import("../src/modules/nft/index.ts");
    const r = await getNftPortfolio({
      wallet: WALLET,
      chains: ["ethereum"],
      minFloorEth: 1,
    });

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].collectionName).toBe("BAYC");
  });

  it("respects collections whitelist — keeps only listed contracts", async () => {
    fetchMock.mockImplementation(async () =>
      fakeResponse({
        status: 200,
        body: {
          tokens: [
            {
              token: {
                contract: BAYC,
                tokenId: "100",
                collection: {
                  id: BAYC,
                  name: "BAYC",
                  floorAskPrice: { amount: { decimal: 25, usd: 65000 } },
                },
              },
              ownership: { tokenCount: "1" },
            },
            {
              token: {
                contract: PUDGY,
                tokenId: "1",
                collection: {
                  id: PUDGY,
                  name: "Pudgy",
                  floorAskPrice: { amount: { decimal: 8, usd: 20800 } },
                },
              },
              ownership: { tokenCount: "1" },
            },
          ],
        },
      }),
    );

    const { getNftPortfolio } = await import("../src/modules/nft/index.ts");
    const r = await getNftPortfolio({
      wallet: WALLET,
      chains: ["ethereum"],
      collections: [BAYC],
    });

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].collectionName).toBe("BAYC");
  });
});

describe("get_nft_collection", () => {
  it("returns floor + top bid + volume + royalty for a known collection", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: {
          collections: [
            {
              id: BAYC,
              name: "Bored Ape Yacht Club",
              symbol: "BAYC",
              tokenCount: "10000",
              ownerCount: 5500,
              floorAsk: {
                price: {
                  amount: { decimal: 25, usd: 65000 },
                  currency: { symbol: "ETH" },
                },
              },
              topBid: {
                price: {
                  amount: { decimal: 23, usd: 59800 },
                  currency: { symbol: "ETH" },
                },
              },
              volume: {
                "1day": 100,
                "7day": 800,
                "30day": 3500,
                allTime: 950000,
              },
              royalties: { bps: 250, recipient: "0xCreator" },
            },
          ],
        },
      }),
    );

    const { getNftCollection } = await import("../src/modules/nft/index.ts");
    const r = await getNftCollection({
      contractAddress: BAYC,
      chain: "ethereum",
    });

    expect(r.name).toBe("Bored Ape Yacht Club");
    expect(r.floorEth).toBe(25);
    expect(r.floorUsd).toBe(65000);
    expect(r.topBidEth).toBe(23);
    expect(r.volume24hEth).toBe(100);
    expect(r.volumeAllTimeEth).toBe(950000);
    expect(r.royaltyBps).toBe(250);
    expect(r.notes.some((n) => n.includes("2.50%"))).toBe(true);
  });

  it("flags missing floor when the collection has no listings", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: {
          collections: [
            {
              id: BAYC,
              name: "Quiet Collection",
              tokenCount: "100",
              ownerCount: 50,
              // No floorAsk.
            },
          ],
        },
      }),
    );

    const { getNftCollection } = await import("../src/modules/nft/index.ts");
    const r = await getNftCollection({
      contractAddress: BAYC,
      chain: "ethereum",
    });
    expect(r.floorEth).toBeUndefined();
    expect(r.notes.some((n) => n.toLowerCase().includes("no active listings"))).toBe(true);
  });

  it("throws when no collection found at the given address", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: { collections: [] },
      }),
    );
    const { getNftCollection } = await import("../src/modules/nft/index.ts");
    await expect(
      getNftCollection({
        contractAddress: "0x0000000000000000000000000000000000000001",
        chain: "ethereum",
      }),
    ).rejects.toThrow(/No Reservoir collection found/);
  });
});

describe("get_nft_history", () => {
  it("merges 2-chain activity, sorts desc by timestamp, caps at limit", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.reservoir.tools")) {
        return fakeResponse({
          status: 200,
          body: {
            activities: [
              {
                type: "sale",
                timestamp: 1_700_000_000,
                contract: BAYC,
                price: {
                  amount: { decimal: 25, usd: 65000 },
                  currency: { symbol: "ETH" },
                },
                token: { tokenId: "100", tokenName: "BAYC #100" },
                collection: { collectionName: "BAYC" },
                fromAddress: "0xseller",
                toAddress: WALLET,
                txHash: "0xabc",
              },
              {
                type: "mint",
                timestamp: 1_690_000_000,
                contract: PUDGY,
                token: { tokenId: "5" },
                collection: { collectionName: "Pudgy Penguins" },
                toAddress: WALLET,
                txHash: "0xdef",
              },
            ],
          },
        });
      }
      if (url.includes("api-arbitrum.reservoir.tools")) {
        return fakeResponse({
          status: 200,
          body: {
            activities: [
              {
                type: "transfer",
                timestamp: 1_710_000_000, // newer than ethereum's 1.7B
                contract: PHISHY,
                token: { tokenId: "1" },
                collection: { collectionName: "Some L2" },
                fromAddress: WALLET,
                toAddress: "0xrecipient",
                txHash: "0xfeed",
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { getNftHistory } = await import("../src/modules/nft/index.ts");
    const r = await getNftHistory({
      wallet: WALLET,
      chains: ["ethereum", "arbitrum"],
      limit: 25,
    });

    expect(r.items).toHaveLength(3);
    // Sorted desc: arbitrum transfer (1.71B) > eth sale (1.70B) > eth mint (1.69B).
    expect(r.items[0].type).toBe("transfer");
    expect(r.items[0].chain).toBe("arbitrum");
    expect(r.items[1].type).toBe("sale");
    expect(r.items[1].priceEth).toBe(25);
    expect(r.items[2].type).toBe("mint");
  });

  it("flags truncated:true when merged items exceed limit", async () => {
    fetchMock.mockImplementation(async () =>
      fakeResponse({
        status: 200,
        body: {
          activities: Array.from({ length: 30 }, (_, i) => ({
            type: "transfer",
            timestamp: 1_700_000_000 + i,
            contract: BAYC,
            token: { tokenId: String(i) },
            txHash: `0x${i.toString(16).padStart(64, "0")}`,
          })),
        },
      }),
    );
    const { getNftHistory } = await import("../src/modules/nft/index.ts");
    const r = await getNftHistory({
      wallet: WALLET,
      chains: ["ethereum"],
      limit: 5,
    });
    expect(r.items).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});
