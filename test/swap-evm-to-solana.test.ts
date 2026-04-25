import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeAbiParameters, parseUnits } from "viem";
import {
  LIFI_BRIDGE_DATA_TUPLE,
  NON_EVM_RECEIVER_SENTINEL,
} from "../src/abis/lifi-diamond.js";

/**
 * EVM → Solana bridge via the existing `prepare_swap` / `get_swap_quote`
 * tools. These exercise the cross-chain-type widening:
 *   - `toChain: "solana"` accepted alongside the EVM enum.
 *   - `toToken` allowed as Solana base58.
 *   - `toAddress` REQUIRED + must be base58.
 *   - Exact-out (`amountSide: "to"`) rejected for cross-chain-type.
 *   - Destination on-chain decimals cross-check skipped (we can't read SPL
 *     via EVM RPC); LiFi's reported decimals are the source of truth on
 *     the destination side.
 *   - Source-side checks (decimals cross-check, fromAmount drift refuse,
 *     ERC-20 allowance dance) all still fire, since the user's signed
 *     bytes still pull EVM tokens.
 */

const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RECIPIENT = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const ETH_USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  fetchSolanaQuote: vi.fn(),
}));

vi.mock("../src/modules/swap/oneinch.js", () => ({
  fetchOneInchQuote: vi.fn(),
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

/**
 * Build proper bridge-shaped calldata so the new `verifyLifiBridgeIntent`
 * cross-check has a BridgeData tuple to inspect. Tests that don't care
 * about specific fields can override `bridgeData` with the defaults shown.
 */
function makeBridgeCalldata(): `0x${string}` {
  const argsHex = encodeAbiParameters(
    [LIFI_BRIDGE_DATA_TUPLE, { type: "bytes", name: "_facetData" }],
    [
      {
        transactionId: ("0x" + "11".repeat(32)) as `0x${string}`,
        bridge: "mayan",
        integrator: "vaultpilot-mcp",
        referrer: "0x0000000000000000000000000000000000000000",
        sendingAssetId: ETH_USDC_MAINNET.toLowerCase() as `0x${string}`,
        receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
        minAmount: 9_900_000n,
        destinationChainId: 1151111081099710n, // Solana
        hasSourceSwaps: false,
        hasDestinationCall: false,
      },
      "0xc0de",
    ],
  );
  return ("0xdeadbeef" + argsHex.slice(2)) as `0x${string}`;
}

function makeEvmToSolQuote(overrides?: { fromAmount?: string; toAmount?: string }) {
  return {
    action: {
      fromToken: {
        address: ETH_USDC_MAINNET,
        symbol: "USDC",
        decimals: 6,
        priceUSD: "1",
      },
      toToken: {
        address: SOL_USDC_MINT,
        symbol: "USDC",
        decimals: 6,
        priceUSD: "1",
      },
      fromAmount: overrides?.fromAmount ?? "10000000", // 10 USDC
    },
    estimate: {
      toAmount: overrides?.toAmount ?? "9950000", // 9.95 USDC after bridge fee
      toAmountMin: "9900000",
      executionDuration: 60,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: makeBridgeCalldata(),
      value: "0",
      gasLimit: "500000",
    },
    tool: "mayan",
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  evmClientStub.readContract.mockReset();
  evmClientStub.multicall.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSwapQuote — EVM → Solana", () => {
  it("forwards toChain and toAddress to LiFi; returns the bridge quote", async () => {
    fetchQuoteMock.mockResolvedValue(makeEvmToSolQuote());
    evmClientStub.readContract.mockResolvedValue(6); // USDC decimals on EVM source

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "solana",
      fromToken: ETH_USDC_MAINNET,
      toToken: SOL_USDC_MINT,
      toAddress: SOL_RECIPIENT,
      amount: "10",
    });

    expect(fetchQuoteMock).toHaveBeenCalledTimes(1);
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.fromChain).toBe("ethereum");
    expect(lifiCall.toChain).toBe("solana");
    expect(lifiCall.toAddress).toBe(SOL_RECIPIENT);
    expect(lifiCall.fromAddress).toBe(EVM_WALLET);
    expect(lifiCall.fromAmount).toBe(parseUnits("10", 6).toString());

    expect(out.toChain).toBe("solana");
    expect(out.crossChain).toBe(true);
    expect(out.tool).toBe("mayan");
  });

  it("requires toAddress when toChain === 'solana'", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDC_MAINNET,
        toToken: SOL_USDC_MINT,
        amount: "10",
      }),
    ).rejects.toThrow(/toAddress is required when toChain === "solana"/);
  });

  it("rejects toAddress not in Solana base58 format for solana destination", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDC_MAINNET,
        toToken: SOL_USDC_MINT,
        toAddress: "0xnotvalidsolana",
        amount: "10",
      }),
    ).rejects.toThrow(/not a valid Solana base58 address/);
  });

  it("rejects exact-out (amountSide: 'to') for cross-chain bridges to Solana", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDC_MAINNET,
        toToken: SOL_USDC_MINT,
        toAddress: SOL_RECIPIENT,
        amount: "10",
        amountSide: "to",
      }),
    ).rejects.toThrow(/Exact-out.*not supported for cross-chain bridges to solana/);
  });
});

describe("prepareSwap — EVM → Solana", () => {
  it("returns an EVM UnsignedTx after the source-side decimals check; skips destination-side cross-check", async () => {
    fetchQuoteMock.mockResolvedValue(makeEvmToSolQuote());
    // Source-side decimals read (USDC on Ethereum). Destination-side
    // (SOL_USDC_MINT) read MUST NOT be attempted — assertion below.
    // First call resolves source decimals (USDC = 6); second + third are
    // allowance/source-decimals-cross-check; we make the mock return 6
    // unconditionally so the path that *does* fire stays happy.
    evmClientStub.readContract.mockResolvedValue(6);
    // Allowance check: pretend high enough so no approve is prepended.
    evmClientStub.readContract.mockImplementation(async (req: { functionName: string }) => {
      if (req.functionName === "allowance") return parseUnits("1000", 6);
      return 6;
    });

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "solana",
      fromToken: ETH_USDC_MAINNET,
      toToken: SOL_USDC_MINT,
      toAddress: SOL_RECIPIENT,
      amount: "10",
    });

    expect(tx.chain).toBe("ethereum"); // source chain — that's what the user signs
    expect(tx.to).toBe(LIFI_DIAMOND);
    expect(tx.data.startsWith("0xdeadbeef")).toBe(true);
    expect(tx.description).toContain("Bridge");
    expect(tx.description).toContain("solana");

    // Destination-side decimals read MUST NOT have fired against the SPL
    // mint — `readContract` was called for source decimals + allowance,
    // not for the SPL mint (which would error since SPL isn't an EVM
    // contract).
    const calls = evmClientStub.readContract.mock.calls as Array<
      [{ address?: string; functionName?: string }]
    >;
    const dstSplCall = calls.find((c) => c[0].address === SOL_USDC_MINT);
    expect(dstSplCall).toBeUndefined();
  });

  it("still enforces the source-side fromAmount drift refuse on cross-chain-type", async () => {
    // LiFi returns a fromAmount different from what we asked — must refuse,
    // same as intra-EVM. The user's signed bytes pull EVM tokens; the
    // destination chain doesn't relax the source-side guard.
    fetchQuoteMock.mockResolvedValue(makeEvmToSolQuote({ fromAmount: "20000000" })); // 20, but caller asked for 10
    evmClientStub.readContract.mockImplementation(async (req: { functionName: string }) => {
      if (req.functionName === "allowance") return parseUnits("1000", 6);
      return 6;
    });

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDC_MAINNET,
        toToken: SOL_USDC_MINT,
        toAddress: SOL_RECIPIENT,
        amount: "10",
      }),
    ).rejects.toThrow(/LiFi returned fromAmount=20000000/);
  });

  it("requires toAddress on prepare too — same guard as quote", async () => {
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDC_MAINNET,
        toToken: SOL_USDC_MINT,
        amount: "10",
      }),
    ).rejects.toThrow(/toAddress is required when toChain === "solana"/);
  });
});

describe("intra-EVM regression — adding 'solana' to toChain doesn't change existing flows", () => {
  it("still accepts toChain as an EVM chain without toAddress (default to source wallet)", async () => {
    // Same-chain swap: ethereum → ethereum. No toAddress. Should work
    // exactly as before.
    fetchQuoteMock.mockResolvedValue({
      action: {
        fromToken: { address: ETH_USDC_MAINNET, symbol: "USDC", decimals: 6, priceUSD: "1" },
        toToken: {
          address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          symbol: "WETH",
          decimals: 18,
          priceUSD: "3000",
        },
        fromAmount: parseUnits("10", 6).toString(),
      },
      estimate: {
        toAmount: parseUnits("0.0033", 18).toString(),
        toAmountMin: parseUnits("0.0032", 18).toString(),
        executionDuration: 30,
        feeCosts: [],
        gasCosts: [],
        approvalAddress: LIFI_DIAMOND,
      },
      tool: "lifi-dex-aggregator",
    });

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC_MAINNET,
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "10",
    });
    expect(out.crossChain).toBe(false);
    expect(out.toChain).toBe("ethereum");

    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.toAddress).toBeUndefined(); // not forwarded when omitted
  });
});
