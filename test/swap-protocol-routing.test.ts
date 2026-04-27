/**
 * Issue #411 — protocol-routing preference on `prepare_swap` /
 * `get_swap_quote`. The user said "swap on 1inch", LiFi silently
 * routed via SushiSwap, and the prepare receipt didn't surface that
 * the named protocol was not honoured.
 *
 * Coverage:
 *   - `exchanges` filter is forwarded to LiFi as `allowExchanges`.
 *   - `bridges` filter is forwarded as `allowBridges`.
 *   - Filter omitted ⇒ LiFi receives no allowExchanges/allowBridges
 *     fields (default routing).
 *   - Response carries a `routedVia` field naming the resolved tool +
 *     whether it matched the requested filter.
 *   - Prepare-tx description includes a routing note when the filter
 *     matched, and a clear MISMATCH note when it didn't.
 *   - LiFi NotFound errors get rephrased to mention the filter so
 *     the agent can offer to retry without it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUnits } from "viem";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  fetchSolanaQuote: vi.fn(),
}));

const fetchOneInchMock = vi.fn();
vi.mock("../src/modules/swap/oneinch.js", () => ({
  fetchOneInchQuote: (...args: unknown[]) => fetchOneInchMock(...args),
}));

const evmClientStub = {
  readContract: vi.fn(),
  multicall: vi.fn(),
};
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => evmClientStub,
  resetClients: () => {},
  verifyChainId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config/user-config.js", () => ({
  readUserConfig: () => ({}),
  resolveOneInchApiKey: () => undefined,
}));

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

function makeIntraChainQuote(tool: string) {
  return {
    action: {
      fromToken: {
        address: ETH_USDC,
        symbol: "USDC",
        decimals: 6,
        priceUSD: "1",
      },
      toToken: {
        address: ETH_WETH,
        symbol: "WETH",
        decimals: 18,
        priceUSD: "3000",
      },
      fromAmount: "100000000", // 100 USDC
    },
    estimate: {
      toAmount: "33000000000000000", // 0.033 WETH
      toAmountMin: "32700000000000000",
      executionDuration: 60,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      // Intra-chain swap calldata: NOT bridge-shaped, so
      // `verifyLifiBridgeIntent` returns silently. Any non-bridge
      // bytes work as long as the prefix isn't accidentally a
      // valid LiFi bridge selector.
      data: ("0xfeedface" + "00".repeat(36)) as `0x${string}`,
      value: "0",
      gasLimit: "200000",
    },
    tool,
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  fetchOneInchMock.mockReset();
  evmClientStub.readContract.mockReset();
  evmClientStub.readContract.mockImplementation(
    async (req: { functionName: string; address?: string }) => {
      if (req.functionName === "allowance") return parseUnits("1000", 6);
      if (req.functionName === "decimals") {
        // USDC = 6, WETH = 18 — the on-chain decimals cross-check
        // refuses if these don't match LiFi's reported metadata.
        return req.address?.toLowerCase() === ETH_WETH.toLowerCase() ? 18 : 6;
      }
      return 0;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue #411 — exchanges/bridges filter forwarding", () => {
  it("forwards `exchanges: ['1inch']` to LiFi as allowExchanges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowExchanges).toEqual(["1inch"]);
  });

  it("forwards `bridges` to LiFi as allowBridges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("across"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      bridges: ["across", "stargate"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowBridges).toEqual(["across", "stargate"]);
  });

  it("does NOT set allowExchanges/allowBridges when filter is omitted (default routing preserved)", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowExchanges).toBeUndefined();
    expect(lifiCall.allowBridges).toBeUndefined();
  });
});

describe("issue #411 — routedVia surfacing in getSwapQuote", () => {
  it("response carries `routedVia.tool` matching LiFi's resolved tool", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    expect(out.routedVia.tool).toBe("sushiswap");
    expect(out.routedVia.matchedRequestedExchanges).toBeUndefined();
  });

  it("when filter matches, routedVia.matchedRequestedExchanges = true", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(out.routedVia.tool).toBe("1inch");
    expect(out.routedVia.matchedRequestedExchanges).toBe(true);
    expect(out.routedVia.requestedExchanges).toEqual(["1inch"]);
  });

  it("when filter set but resolved tool is aliased differently, matchedRequestedExchanges = false", async () => {
    // LiFi sometimes exposes a tool name aliased differently from the
    // filter input. Filter forwarding still narrows the routing graph;
    // this just records the post-resolution mismatch so the receipt
    // can flag it.
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("oneinch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(out.routedVia.tool).toBe("oneinch");
    expect(out.routedVia.matchedRequestedExchanges).toBe(false);
  });
});

describe("issue #411 — prepareSwap description carries the routing note", () => {
  it("description includes 'via <tool>' even with no filter", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    expect(tx.description).toContain("via sushiswap");
  });

  it("filter matches: description appends '(matched requested exchange filter: ...)'", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(tx.description).toContain("via 1inch");
    expect(tx.description).toMatch(/matched requested exchange filter/);
  });

  it("filter set but resolved tool different: description carries an explicit MISMATCH note", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("oneinch"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(tx.description).toContain("via oneinch");
    expect(tx.description).toContain("did not match");
    // Decoded args also carry the mismatch flag for structured consumers.
    expect(tx.decoded?.args.matchedRequestedExchanges).toBe("no");
    expect(tx.decoded?.args.requestedExchanges).toBe("1inch");
  });
});

describe("issue #411 — LiFi no-route error gets rephrased to name the filter", () => {
  it("when filter is set, NotFound error is wrapped with filter context", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("No available routes for the requested swap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/no route satisfying exchanges=\[1inch\]/);
  });

  it("when filter is omitted, LiFi error is passed through unchanged", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("No available routes for the requested swap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
      }),
    ).rejects.toThrow(/No available routes/);
  });

  it("non-no-route LiFi errors pass through even when filter is set (don't mis-rephrase)", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("rate limit exceeded"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });
});
