import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for issue #201 — `get_portfolio_summary` multi-wallet mode
 * + non-EVM addresses now produces a `nonEvm` block at the top
 * level rather than throwing or folding non-EVM into a chosen EVM
 * wallet's totals.
 *
 * The two prior tests in `btc-pr4-portfolio-message-sign.test.ts`
 * and `solana-portfolio.test.ts` already exercise the per-chain
 * happy paths in isolation. This file covers the cross-cutting
 * cases:
 *   - multi-wallet + multi-TRON (the issue's specific complaint)
 *   - multi-wallet + ALL THREE non-EVM types (the user's example)
 *   - single-wallet + multi-TRON / multi-Solana → throws
 *   - mutual exclusivity between singular and plural args
 */

// Stub heavy EVM modules so the portfolio handler doesn't try to
// multicall on-chain state in unit tests.
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    getBalance: async () => 0n,
    multicall: async () => [],
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

vi.mock("../src/data/prices.ts", () => ({
  getTokenPrice: async () => undefined,
  getTokenPrices: async () => new Map(),
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
  prefetchCompoundProbes: async () => undefined,
}));

vi.mock("../src/modules/positions/aave.js", () => ({
  prefetchAaveAccountData: async () => undefined,
}));

vi.mock("../src/modules/staking/lido.js", () => ({
  prefetchLidoMainnet: async () => undefined,
}));

vi.mock("../src/modules/morpho/index.js", () => ({
  getMorphoPositions: async () => ({
    wallet: "0x0",
    positions: [],
    discoverySkipped: false,
  }),
}));

// Solana subreaders — cheap stubs so the portfolio aggregator's
// Solana fan-out doesn't try to load real on-chain state.
vi.mock("../src/modules/solana/balances.js", () => ({
  getSolanaBalances: vi.fn(),
}));

vi.mock("../src/modules/positions/marginfi.js", () => ({
  getMarginfiPositions: async () => [],
}));

vi.mock("../src/modules/positions/kamino.js", () => ({
  getKaminoPositions: async () => [],
}));

vi.mock("../src/modules/positions/solana-staking.js", () => ({
  getSolanaStakingPositions: async () => null,
}));

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => ({}),
  resetSolanaConnection: () => {},
}));

// TRON subreaders.
vi.mock("../src/modules/tron/balances.js", () => ({
  getTronBalances: vi.fn(),
}));

vi.mock("../src/modules/tron/staking.js", () => ({
  getTronStaking: vi.fn(),
}));

// Bitcoin: indexer + price.
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: vi.fn(),
  }),
  resetBitcoinIndexer: () => {},
}));

vi.mock("../src/modules/btc/price.ts", () => ({
  fetchBitcoinPrice: vi.fn(),
}));

vi.mock("../src/modules/btc/balances.js", () => ({
  getBitcoinBalances: vi.fn(),
}));

const EVM_WALLET_A = "0x1111111111111111111111111111111111111111";
const EVM_WALLET_B = "0x2222222222222222222222222222222222222222";
const TRON_A = "TPoa3HeAJZsZ8KCKWmPi3xRrfjDGmqHaaa";
const TRON_B = "TAV6CGzaWMaSMFrG4uM4nZqfCt9X1jbbbb";
const SOL_A = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const SEGWIT_A = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SEGWIT_B = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_portfolio_summary — multi-wallet + multi-TRON (issue #201)", () => {
  it("surfaces every TRON address as a parallel slice in nonEvm.tron[], not folded into any EVM wallet", async () => {
    const { getTronBalances } = await import("../src/modules/tron/balances.js");
    const { getTronStaking } = await import("../src/modules/tron/staking.js");
    (getTronBalances as ReturnType<typeof vi.fn>).mockImplementation(
      async (addr: string) => ({
        address: addr,
        native: [
          {
            token: "native",
            symbol: "TRX",
            decimals: 6,
            amount: "100000000",
            formatted: "100",
            valueUsd: addr === TRON_A ? 12.34 : 56.78,
            priceUsd: 0.12,
          },
        ],
        trc20: [],
        walletBalancesUsd: addr === TRON_A ? 12.34 : 56.78,
      }),
    );
    (getTronStaking as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: "stub",
      frozen: [],
      pendingUnfreezes: [],
      claimableRewards: { sun: "0", trx: "0" },
      totalStakedUsd: 0,
    });

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    const out = await getPortfolioSummary({
      wallets: [EVM_WALLET_A, EVM_WALLET_B],
      tronAddresses: [TRON_A, TRON_B],
    });
    if (!("perWallet" in out)) throw new Error("expected multi-wallet shape");
    // The crux of #201: per-wallet entries don't carry tron USD anywhere.
    expect(out.perWallet[0].tronUsd).toBeUndefined();
    expect(out.perWallet[1].tronUsd).toBeUndefined();
    // Top-level rollups + slices are populated.
    expect(out.tronUsd).toBeCloseTo(69.12, 2);
    expect(out.nonEvm?.tron).toHaveLength(2);
    expect(out.nonEvm?.tron?.[0].address).toBe(TRON_A);
    expect(out.nonEvm?.tron?.[1].address).toBe(TRON_B);
    // totalUsd includes the non-EVM contribution.
    expect(out.totalUsd).toBeCloseTo(69.12, 2);
  });

  it("rejects mutually-exclusive tronAddress + tronAddresses", async () => {
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    await expect(
      getPortfolioSummary({
        wallets: [EVM_WALLET_A, EVM_WALLET_B],
        tronAddress: TRON_A,
        tronAddresses: [TRON_B],
      }),
    ).rejects.toThrow(/single.*OR.*array/i);
  });
});

describe("get_portfolio_summary — multi-wallet + all three non-EVM (issue #201 example)", () => {
  it("the user's example call returns a clean rollup with parallel non-EVM slices", async () => {
    const { getTronBalances } = await import("../src/modules/tron/balances.js");
    const { getTronStaking } = await import("../src/modules/tron/staking.js");
    const { getSolanaBalances } = await import(
      "../src/modules/solana/balances.js"
    );
    const { getBitcoinBalances } = await import(
      "../src/modules/btc/balances.js"
    );
    const { fetchBitcoinPrice } = await import("../src/modules/btc/price.ts");

    (getTronBalances as ReturnType<typeof vi.fn>).mockImplementation(
      async (addr: string) => ({
        address: addr,
        native: [],
        trc20: [],
        walletBalancesUsd: addr === TRON_A ? 30 : 50,
      }),
    );
    (getTronStaking as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: "stub",
      frozen: [],
      pendingUnfreezes: [],
      claimableRewards: { sun: "0", trx: "0" },
      totalStakedUsd: 0,
    });
    (getSolanaBalances as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: SOL_A,
      native: [],
      spl: [],
      walletBalancesUsd: 25,
    });
    // Issue #274: pricing moved into the BTC reader, so the mocked
    // balance now needs to include priceUsd / valueUsd directly. The
    // separate fetchBitcoinPrice mock below is preserved for compat
    // but is no longer load-bearing for this test path.
    (getBitcoinBalances as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ok: true as const,
        balance: {
          address: SEGWIT_A,
          addressType: "p2wpkh",
          confirmedSats: 200_000n,
          mempoolSats: 0n,
          totalSats: 200_000n,
          confirmedBtc: "0.002",
          totalBtc: "0.002",
          symbol: "BTC",
          decimals: 8,
          txCount: 1,
          priceUsd: 50_000,
          valueUsd: 100,
        },
      },
      {
        ok: true as const,
        balance: {
          address: SEGWIT_B,
          addressType: "p2wpkh",
          confirmedSats: 100_000n,
          mempoolSats: 0n,
          totalSats: 100_000n,
          confirmedBtc: "0.001",
          totalBtc: "0.001",
          symbol: "BTC",
          decimals: 8,
          txCount: 1,
          priceUsd: 50_000,
          valueUsd: 50,
        },
      },
    ]);
    (fetchBitcoinPrice as ReturnType<typeof vi.fn>).mockResolvedValue(50_000);

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    const out = await getPortfolioSummary({
      wallets: [EVM_WALLET_A, EVM_WALLET_B],
      tronAddresses: [TRON_A, TRON_B],
      solanaAddress: SOL_A,
      bitcoinAddresses: [SEGWIT_A, SEGWIT_B],
    });
    if (!("perWallet" in out)) throw new Error("expected multi-wallet shape");

    // No per-wallet entry carries non-EVM USD anywhere.
    for (const w of out.perWallet) {
      expect(w.tronUsd).toBeUndefined();
      expect(w.solanaUsd).toBeUndefined();
      expect(w.bitcoinUsd).toBeUndefined();
    }

    // Each non-EVM source has its slice + rolled-up USD.
    expect(out.nonEvm?.tron?.length).toBe(2);
    expect(out.nonEvm?.solana?.length).toBe(1);
    expect(out.nonEvm?.bitcoin?.balances.length).toBe(2);

    expect(out.tronUsd).toBe(80);
    expect(out.solanaUsd).toBe(25);
    // 0.002 + 0.001 = 0.003 BTC × $50,000 = $150
    expect(out.bitcoinUsd).toBe(150);

    // Top-line totalUsd folds in all three.
    expect(out.totalUsd).toBeCloseTo(80 + 25 + 150, 2);
  });
});

describe("get_portfolio_summary — single-wallet rejects multi-TRON / multi-Solana", () => {
  it("throws on tronAddresses with >1 entry under a single wallet", async () => {
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    await expect(
      getPortfolioSummary({
        wallet: EVM_WALLET_A,
        tronAddresses: [TRON_A, TRON_B],
      }),
    ).rejects.toThrow(/multi-wallet mode/);
  });

  it("throws on solanaAddresses with >1 entry under a single wallet", async () => {
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    await expect(
      getPortfolioSummary({
        wallet: EVM_WALLET_A,
        solanaAddresses: [SOL_A, SOL_A],
      }),
    ).rejects.toThrow(/multi-wallet mode/);
  });

  it("ALLOWS single-wallet + tronAddresses with exactly 1 entry (folds in like tronAddress)", async () => {
    const { getTronBalances } = await import("../src/modules/tron/balances.js");
    const { getTronStaking } = await import("../src/modules/tron/staking.js");
    (getTronBalances as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: TRON_A,
      native: [],
      trc20: [],
      walletBalancesUsd: 42,
    });
    (getTronStaking as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: TRON_A,
      frozen: [],
      pendingUnfreezes: [],
      claimableRewards: { sun: "0", trx: "0" },
      totalStakedUsd: 0,
    });
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    const out = await getPortfolioSummary({
      wallet: EVM_WALLET_A,
      tronAddresses: [TRON_A],
    });
    if ("perWallet" in out) throw new Error("expected single-wallet shape");
    // Single-wallet path folds non-EVM into the wallet's totals.
    expect(out.tronUsd).toBe(42);
  });
});
