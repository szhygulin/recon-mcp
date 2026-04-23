import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cache } from "../src/data/cache.js";

/**
 * Portfolio integration for Solana. Verifies the aggregator's plumbing:
 *   1. `solanaAddress` on a single-wallet call produces a `breakdown.solana`
 *      and populates `solanaUsd` + `coverage.solana`.
 *   2. A Solana RPC failure degrades gracefully — coverage reflects the
 *      error and the EVM portion of the summary is unaffected (same
 *      catch-and-continue contract TRON has).
 *   3. `solanaAddress` + multi-wallet throws (ambiguous pairing, same rule
 *      as `tronAddress`).
 */

const connectionStub = {
  getBalance: vi.fn(),
  getTokenAccountsByOwner: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Stub the heavy EVM modules so the portfolio handler doesn't try to
// multicall / fetch on-chain state in unit tests.
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    getBalance: async () => 0n,
    multicall: async () => [],
    getChainId: async () => 1,
    estimateGas: async () => 0n,
    getGasPrice: async () => 0n,
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

vi.mock("../src/data/prices.ts", () => ({
  getTokenPrice: async () => undefined,
  priceTokenAmounts: async () => undefined,
}));

vi.mock("../src/modules/positions/index.js", () => ({
  getLendingPositions: async () => ({ wallet: "0x0", positions: [] }),
  getLpPositions: async () => ({ wallet: "0x0", positions: [] }),
}));

vi.mock("../src/modules/staking/index.js", () => ({
  getStakingPositions: async () => ({ wallet: "0x0", positions: [] }),
}));

vi.mock("../src/modules/compound/index.js", () => ({
  getCompoundPositions: async () => ({ wallet: "0x0", positions: [] }),
}));

vi.mock("../src/modules/morpho/index.js", () => ({
  getMorphoPositions: async () => ({ wallet: "0x0", positions: [] }),
}));

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const SOL_WALLET = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";

beforeEach(() => {
  cache.clear();
  connectionStub.getBalance.mockReset();
  connectionStub.getTokenAccountsByOwner.mockReset();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ coins: {} }),
      json: async () => ({ coins: {} }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_portfolio_summary with solanaAddress", () => {
  it("folds the Solana slice into breakdown.solana + solanaUsd + coverage.solana", async () => {
    connectionStub.getBalance.mockResolvedValue(1_000_000_000); // 1 SOL
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const res = await getPortfolioSummary({
      wallet: EVM_WALLET,
      chains: ["ethereum"],
      solanaAddress: SOL_WALLET,
    });

    expect("breakdown" in res).toBe(true);
    if (!("breakdown" in res)) return;
    expect(res.breakdown.solana).toBeDefined();
    expect(res.breakdown.solana?.address).toBe(SOL_WALLET);
    expect(res.breakdown.solana?.native.length).toBe(1);
    expect(res.coverage.solana?.covered).toBe(true);
    expect(res.coverage.solana?.errored).toBeUndefined();
    // 1 SOL with no price → walletBalancesUsd is 0 (priceMissing) but the
    // slice is still present.
    expect(res.breakdown.solana?.walletBalancesUsd).toBe(0);
  });

  it("marks coverage.solana as errored when the Solana RPC fails — EVM summary is unaffected", async () => {
    connectionStub.getBalance.mockRejectedValueOnce(new Error("Helius 503"));
    connectionStub.getTokenAccountsByOwner.mockRejectedValue(new Error("Helius 503"));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const res = await getPortfolioSummary({
      wallet: EVM_WALLET,
      chains: ["ethereum"],
      solanaAddress: SOL_WALLET,
    });

    expect("breakdown" in res).toBe(true);
    if (!("breakdown" in res)) return;
    expect(res.coverage.solana?.errored).toBe(true);
    expect(res.breakdown.solana).toBeUndefined();
    expect(res.totalUsd).toBeGreaterThanOrEqual(0); // EVM summary still works.
  });

  it("throws when solanaAddress is combined with multi-wallet", async () => {
    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    await expect(
      getPortfolioSummary({
        wallets: [EVM_WALLET, "0x2222222222222222222222222222222222222222"],
        chains: ["ethereum"],
        solanaAddress: SOL_WALLET,
      }),
    ).rejects.toThrow(/solanaAddress.*single EVM `wallet`/);
  });
});
