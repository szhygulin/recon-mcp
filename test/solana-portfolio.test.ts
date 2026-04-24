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
  getParsedTokenAccountsByOwner: vi.fn(),
  getParsedProgramAccounts: vi.fn(),
  getEpochInfo: vi.fn(),
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

// Stub the staking reader's SDK deps so the staking fan-out inside the
// aggregator doesn't try to decode a real Marinade state or Jito pool.
const marinadeStateStub = { mSolPrice: 1 };
const getMarinadeStateMock = vi.fn(async () => marinadeStateStub);
vi.mock("@marinade.finance/marinade-ts-sdk", () => {
  class MarinadeConfig {}
  class Marinade {
    async getMarinadeState() {
      return getMarinadeStateMock();
    }
  }
  return { MarinadeConfig, Marinade };
});

const getStakePoolAccountMock = vi.fn();
vi.mock("@solana/spl-stake-pool", () => ({
  getStakePoolAccount: getStakePoolAccountMock,
}));

beforeEach(() => {
  cache.clear();
  connectionStub.getBalance.mockReset();
  connectionStub.getTokenAccountsByOwner.mockReset();
  connectionStub.getParsedTokenAccountsByOwner.mockReset();
  connectionStub.getParsedProgramAccounts.mockReset();
  connectionStub.getEpochInfo.mockReset();
  getMarinadeStateMock.mockClear();
  getStakePoolAccountMock.mockReset();
  // Sensible defaults — empty-staking, rate=1 so staking tests start
  // neutral. Individual tests override for non-zero holdings.
  connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue({ value: [] });
  connectionStub.getParsedProgramAccounts.mockResolvedValue([]);
  connectionStub.getEpochInfo.mockResolvedValue({ epoch: 500 });
  marinadeStateStub.mSolPrice = 1;
  getStakePoolAccountMock.mockResolvedValue({
    account: {
      data: {
        totalLamports: { toString: () => "0" },
        poolTokenSupply: { toString: () => "0" },
      },
    },
  });

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

  it("folds staking positions into breakdown.solana.staking + solanaStakingUsd when holdings exist + SOL price resolved", async () => {
    // Balance path: 1 SOL native, priced at $100 → solanaBalancesUsd = 100,
    // and SOL price propagates to the staking USD conversion.
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });
    // The balance reader URL-encodes the coin keys
    // (`coingecko%3Asolana,solana%3A<mint>,...`), so match loosely on the
    // encoded form. Return a stub price map that covers native SOL.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          coins: { "coingecko:solana": { price: 100 } },
        }),
      })),
    );

    // Staking path: 10 mSOL at rate 1.2 (→ 12 SOL), 5 jitoSOL at rate 1.1
    // (→ 5.5 SOL), no native stakes. Total SOL-equivalent = 17.5 → USD = 1750.
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue({
      value: [
        {
          pubkey: { toBase58: () => "ATA" },
          account: {
            lamports: 0,
            owner: {},
            executable: false,
            rentEpoch: 0,
            data: {
              program: "spl-token",
              parsed: {
                type: "account",
                info: { tokenAmount: { uiAmount: 10 } },
              },
              space: 165,
            },
          },
        },
      ],
    });
    marinadeStateStub.mSolPrice = 1.2;
    // Override one call to return jitoSOL balance = 5. Since both Marinade
    // and Jito readers call getParsedTokenAccountsByOwner, the stub above
    // returns 10 for both — close enough for the math assertion below.
    // We'll assert the aggregate instead of per-LST.
    getStakePoolAccountMock.mockResolvedValue({
      account: {
        data: {
          totalLamports: { toString: () => "110000000000" },
          poolTokenSupply: { toString: () => "100000000000" },
        },
      },
    });

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const res = await getPortfolioSummary({
      wallet: EVM_WALLET,
      chains: ["ethereum"],
      solanaAddress: SOL_WALLET,
    });

    expect("breakdown" in res).toBe(true);
    if (!("breakdown" in res)) return;
    const solana = res.breakdown.solana;
    expect(solana).toBeDefined();
    // Staking subtotal: 10 mSOL × 1.2 + 10 jitoSOL × 1.1 = 23 SOL. ($100 each → $2300.)
    expect(solana?.staking).toBeDefined();
    expect(solana?.staking?.totalSolEquivalent).toBeCloseTo(23);
    expect(solana?.stakingNetUsd).toBeCloseTo(2300, 0);
    expect(res.solanaStakingUsd).toBeCloseTo(2300, 0);
    // Coverage flag is present + clean.
    expect(res.coverage.solanaStaking?.covered).toBe(true);
    // Top-level totalUsd now includes the staking USD.
    expect(res.totalUsd).toBeGreaterThanOrEqual(2300);
  });

  it("marks coverage.solanaStaking as errored when the reader fails — balance + MarginFi coverage unaffected", async () => {
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });
    // Make the staking reader's RPC path throw.
    connectionStub.getParsedTokenAccountsByOwner.mockRejectedValue(
      new Error("Helius 503 on parsed token accounts"),
    );

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const res = await getPortfolioSummary({
      wallet: EVM_WALLET,
      chains: ["ethereum"],
      solanaAddress: SOL_WALLET,
    });

    expect("breakdown" in res).toBe(true);
    if (!("breakdown" in res)) return;
    expect(res.coverage.solanaStaking?.errored).toBe(true);
    expect(res.coverage.solana?.covered).toBe(true); // balance fetch survived
    expect(res.breakdown.solana?.staking).toBeUndefined();
    expect(res.solanaStakingUsd).toBeUndefined();
  });

  it("omits solanaStakingUsd when staking fetch succeeds but user has zero holdings", async () => {
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });
    // Defaults (beforeEach) leave all staking readers empty.

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const res = await getPortfolioSummary({
      wallet: EVM_WALLET,
      chains: ["ethereum"],
      solanaAddress: SOL_WALLET,
    });

    expect("breakdown" in res).toBe(true);
    if (!("breakdown" in res)) return;
    expect(res.coverage.solanaStaking?.covered).toBe(true);
    expect(res.breakdown.solana?.staking).toBeUndefined();
    expect(res.solanaStakingUsd).toBeUndefined();
  });
});
