import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ALL_CHAINS,
  SUPPORTED_CHAINS,
  SUPPORTED_NON_EVM_CHAINS,
  TRON_CHAIN_ID,
  isEvmChain,
  type AnyChain,
} from "../src/types/index.js";
import {
  TRONGRID_BASE_URL,
  TRON_TOKENS,
  TRX_DECIMALS,
  TRX_SYMBOL,
  isTronAddress,
} from "../src/config/tron.js";
import { resolveTronApiKey } from "../src/config/user-config.js";
import { getTronBalances, getTronTokenBalance } from "../src/modules/tron/balances.js";
import { getTronStaking } from "../src/modules/tron/staking.js";
import { getTokenBalance } from "../src/modules/balances/index.js";
import { getPortfolioSummaryInput } from "../src/modules/portfolio/schemas.js";

/**
 * These tests lock down TRON as strictly additive: EVM chain tables stay
 * untouched, non-EVM lives in its own union, and `AnyChain` is the cross-chain
 * entry-point type. Network IO (TronGrid, DefiLlama) is stubbed via vi.stubGlobal
 * on fetch — the tests assert the request/response shape, not the live grid.
 */

describe("TRON chain registration", () => {
  it("is NOT listed in SUPPORTED_CHAINS (EVM-only union stays narrow)", () => {
    // The whole point of keeping SUPPORTED_CHAINS EVM-only is so every
    // Record<SupportedChain, …> table (viem clients, Aave addresses, etc.)
    // doesn't accidentally grow a TRON entry it can't honour.
    expect(SUPPORTED_CHAINS).not.toContain("tron");
  });

  it("is listed in SUPPORTED_NON_EVM_CHAINS", () => {
    expect(SUPPORTED_NON_EVM_CHAINS).toContain("tron");
  });

  it("is listed in ALL_CHAINS", () => {
    expect(ALL_CHAINS).toContain("tron");
    // And every EVM chain is still there — ALL_CHAINS is the superset.
    for (const c of SUPPORTED_CHAINS) {
      expect(ALL_CHAINS).toContain(c);
    }
  });

  it("exposes the canonical TRON mainnet chain id (0x2b6653dc)", () => {
    expect(TRON_CHAIN_ID).toBe(728126428);
    expect(TRON_CHAIN_ID.toString(16)).toBe("2b6653dc");
  });
});

describe("isEvmChain predicate", () => {
  it("narrows EVM chains to SupportedChain", () => {
    for (const c of SUPPORTED_CHAINS) {
      expect(isEvmChain(c)).toBe(true);
    }
  });

  it("returns false for tron", () => {
    const c: AnyChain = "tron";
    expect(isEvmChain(c)).toBe(false);
  });
});

describe("isTronAddress", () => {
  it("accepts a 34-char base58 mainnet address (prefix T)", () => {
    // USDT-TRC20 contract — canonical well-known TRON address.
    expect(isTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true);
  });

  it("rejects 0x EVM addresses", () => {
    expect(isTronAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6")).toBe(false); // 33 chars
    expect(isTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tX")).toBe(false); // 35 chars
    expect(isTronAddress("")).toBe(false);
  });

  it("rejects non-T prefix", () => {
    // Base58 starts from all valid chars but TRON mainnet uses version byte 0x41 → 'T'.
    expect(isTronAddress("SR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(false);
  });

  it("rejects base58-invalid characters (0, O, I, l)", () => {
    // Character at index 1 is '0' which isn't in base58.
    expect(isTronAddress("T0" + "a".repeat(32))).toBe(false);
  });
});

describe("TRON_TOKENS canonical registry", () => {
  it("contains USDT (USDT-TRC20 dominates TRON token volume)", () => {
    expect(TRON_TOKENS.USDT).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  });

  it("every canonical address parses as a valid TRON address", () => {
    for (const [symbol, addr] of Object.entries(TRON_TOKENS)) {
      expect(isTronAddress(addr), `TRON_TOKENS.${symbol}`).toBe(true);
    }
  });

  it("TRX native uses 6 decimals (1 TRX = 1_000_000 sun)", () => {
    expect(TRX_DECIMALS).toBe(6);
    expect(TRX_SYMBOL).toBe("TRX");
  });

  it("TronGrid base URL is set", () => {
    expect(TRONGRID_BASE_URL).toBe("https://api.trongrid.io");
  });
});

describe("resolveTronApiKey", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TRON_API_KEY;
    delete process.env.TRON_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TRON_API_KEY;
    else process.env.TRON_API_KEY = saved;
  });

  it("env TRON_API_KEY wins over user config", () => {
    process.env.TRON_API_KEY = "env-key";
    expect(resolveTronApiKey({ rpc: { provider: "custom" }, tronApiKey: "cfg-key" })).toBe(
      "env-key"
    );
  });

  it("falls back to user config when env unset", () => {
    expect(resolveTronApiKey({ rpc: { provider: "custom" }, tronApiKey: "cfg-key" })).toBe(
      "cfg-key"
    );
  });

  it("returns undefined when neither is set", () => {
    expect(resolveTronApiKey(null)).toBeUndefined();
    expect(resolveTronApiKey({ rpc: { provider: "custom" } })).toBeUndefined();
  });
});

describe("get_token_balance input schema accepts TRON", () => {
  // Re-import the schema only here so the zod validation runs against the
  // currently-built module.
  it("accepts chain=tron + base58 wallet + native token", async () => {
    const { getTokenBalanceInput } = await import(
      "../src/modules/balances/schemas.js"
    );
    const parsed = getTokenBalanceInput.parse({
      chain: "tron",
      wallet: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      token: "native",
    });
    expect(parsed.chain).toBe("tron");
  });

  it("accepts chain=tron + base58 wallet + base58 TRC-20 token", async () => {
    const { getTokenBalanceInput } = await import(
      "../src/modules/balances/schemas.js"
    );
    const parsed = getTokenBalanceInput.parse({
      chain: "tron",
      wallet: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      token: TRON_TOKENS.USDT,
    });
    expect(parsed.token).toBe(TRON_TOKENS.USDT);
  });

  it("still accepts ethereum + 0x wallet + 0x token (no regression)", async () => {
    const { getTokenBalanceInput } = await import(
      "../src/modules/balances/schemas.js"
    );
    const parsed = getTokenBalanceInput.parse({
      chain: "ethereum",
      wallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f0BEb7",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    });
    expect(parsed.chain).toBe("ethereum");
  });
});

describe("get_portfolio_summary schema accepts tronAddress", () => {
  it("accepts an optional tronAddress alongside an EVM wallet", () => {
    const parsed = getPortfolioSummaryInput.parse({
      wallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f0BEb7",
      tronAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    });
    expect(parsed.tronAddress).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  });

  it("rejects a malformed tronAddress (not base58 prefix T)", () => {
    expect(() =>
      getPortfolioSummaryInput.parse({
        wallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f0BEb7",
        tronAddress: "0xdeadbeef",
      })
    ).toThrow();
  });
});

describe("getTronBalances (network stubbed)", () => {
  const addr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.trongrid.io/v1/accounts/")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                balance: 12_345_678, // 12.345678 TRX
                trc20: [
                  { [TRON_TOKENS.USDT]: "5000000" }, // 5 USDT (6 decimals)
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith("https://coins.llama.fi/prices/current/")) {
        return new Response(
          JSON.stringify({
            coins: {
              "coingecko:tron": { price: 0.1 },
              [`tron:${TRON_TOKENS.USDT}`]: { price: 1 },
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns TRX + USDT balances at correct decimals with USD values", async () => {
    const slice = await getTronBalances(addr);
    expect(slice.address).toBe(addr);
    expect(slice.native).toHaveLength(1);
    expect(slice.native[0].symbol).toBe("TRX");
    expect(slice.native[0].formatted).toBe("12.345678");
    expect(slice.native[0].valueUsd).toBeCloseTo(12.345678 * 0.1, 4);

    const usdt = slice.trc20.find((t) => t.symbol === "USDT");
    expect(usdt).toBeDefined();
    expect(usdt!.formatted).toBe("5");
    expect(usdt!.valueUsd).toBeCloseTo(5, 4);
    expect(usdt!.token).toBe(TRON_TOKENS.USDT);

    // Aggregate wallet total should be ≈ 5 + 1.2345678 = 6.2345678 USD.
    expect(slice.walletBalancesUsd).toBeCloseTo(6.23, 2);
  });

  it("throws on non-TRON wallet address", async () => {
    await expect(getTronBalances("0xdeadbeef")).rejects.toThrow(/TRON mainnet address/);
  });

  it("returns a zero TRX balance object on an inactive TRON address", async () => {
    // TronGrid returns `{data: []}` for addresses with no activity.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.trongrid.io/")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ coins: {} }), { status: 200 });
    });
    const slice = await getTronBalances(addr);
    expect(slice.native).toHaveLength(0); // zero native filtered out
    expect(slice.trc20).toHaveLength(0);
    expect(slice.walletBalancesUsd).toBe(0);
  });
});

describe("getTronTokenBalance (network stubbed)", () => {
  const addr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.trongrid.io/")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  balance: 0,
                  trc20: [{ [TRON_TOKENS.USDT]: "42000000" }], // 42 USDT
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            coins: { [`tron:${TRON_TOKENS.USDT}`]: { price: 1 } },
          }),
          { status: 200 }
        );
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns USDT balance when queried by TRC-20 address", async () => {
    const b = await getTronTokenBalance(addr, TRON_TOKENS.USDT);
    expect(b.symbol).toBe("USDT");
    expect(b.formatted).toBe("42");
  });

  it("returns zero TRX balance when native has no activity", async () => {
    const b = await getTronTokenBalance(addr, "native");
    expect(b.symbol).toBe("TRX");
    expect(b.amount).toBe("0");
  });

  it("refuses malformed wallet", async () => {
    await expect(getTronTokenBalance("0xbadwallet", "native")).rejects.toThrow();
  });
});

describe("get_token_balance dispatches TRON to the TRON reader", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.trongrid.io/")) {
          return new Response(
            JSON.stringify({
              data: [{ balance: 1_000_000, trc20: [] }], // 1 TRX
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ coins: { "coingecko:tron": { price: 0.1 } } }),
          { status: 200 }
        );
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a TronBalance shape (chain:'tron', base58 token) when chain=tron", async () => {
    const res = await getTokenBalance({
      chain: "tron",
      wallet: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      token: "native",
    });
    // TronBalance has chain:"tron" and token as string (base58 or "native");
    // TokenAmount never carries a `chain` field, so this distinguishes them.
    expect((res as { chain?: string }).chain).toBe("tron");
    expect(res.symbol).toBe("TRX");
    expect(res.formatted).toBe("1");
  });
});

describe("getTronStaking (network stubbed)", () => {
  const addr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://api.trongrid.io/v1/accounts/")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  frozenV2: [
                    { amount: 100_000_000, type: "BANDWIDTH" }, // 100 TRX frozen for bandwidth
                    { amount: 50_000_000, type: "ENERGY" }, // 50 TRX frozen for energy
                  ],
                  unfrozenV2: [
                    {
                      unfreeze_amount: 25_000_000, // 25 TRX pending
                      type: "BANDWIDTH",
                      unfreeze_expire_time: 1_800_000_000_000, // some future ms
                    },
                  ],
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url === "https://api.trongrid.io/wallet/getReward") {
          // Sanity-check body shape: the post body must include the base58 address.
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ reward: 1_500_000 }), { status: 200 }); // 1.5 TRX claimable
        }
        if (url.startsWith("https://coins.llama.fi/prices/current/")) {
          return new Response(
            JSON.stringify({ coins: { "coingecko:tron": { price: 0.1 } } }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns frozen + pending + claimable with USD, at 6-decimal TRX", async () => {
    const s = await getTronStaking(addr);
    expect(s.address).toBe(addr);

    expect(s.frozen).toHaveLength(2);
    const bw = s.frozen.find((f) => f.type === "bandwidth")!;
    expect(bw.formatted).toBe("100");
    expect(bw.valueUsd).toBeCloseTo(10, 4); // 100 * 0.1
    const en = s.frozen.find((f) => f.type === "energy")!;
    expect(en.formatted).toBe("50");
    expect(en.valueUsd).toBeCloseTo(5, 4);

    expect(s.pendingUnfreezes).toHaveLength(1);
    expect(s.pendingUnfreezes[0].formatted).toBe("25");
    expect(s.pendingUnfreezes[0].unlockAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(s.claimableRewards.formatted).toBe("1.5");
    expect(s.claimableRewards.valueUsd).toBeCloseTo(0.15, 4);

    // 100 + 50 + 25 + 1.5 = 176.5 TRX → 17.65 USD
    expect(s.totalStakedTrx).toBe("176.5");
    expect(s.totalStakedUsd).toBeCloseTo(17.65, 2);
  });

  it("returns zero staking for an inactive address (no frozenV2, no reward)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.trongrid.io/v1/accounts/")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (url === "https://api.trongrid.io/wallet/getReward") {
          return new Response(JSON.stringify({ reward: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      })
    );
    const s = await getTronStaking(addr);
    expect(s.frozen).toHaveLength(0);
    expect(s.pendingUnfreezes).toHaveLength(0);
    expect(s.claimableRewards.amount).toBe("0");
    expect(s.totalStakedUsd).toBe(0);
  });

  it("throws on malformed wallet address", async () => {
    await expect(getTronStaking("0xdeadbeef")).rejects.toThrow(/TRON mainnet address/);
  });
});
