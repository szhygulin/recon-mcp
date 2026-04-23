import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { cache } from "../src/data/cache.js";

/**
 * Solana balance-read tests. We mock the Solana connection factory so the
 * canned responses land in the balance/price code paths without hitting
 * the network. Fetch is also mocked to intercept the DefiLlama price call.
 */

const WALLET = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Build a 165-byte Token account data Buffer. Layout starts with:
 *   mint (32 bytes) || owner (32 bytes) || amount (u64 LE, 8 bytes) || ...
 * The rest is padded with zeros — we only need the first 72 bytes to decode
 * mint + amount (owner is ignored by the balance reader).
 */
function buildTokenAccountData(mint: string, amount: bigint): Buffer {
  const buf = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(buf, 0);
  // owner (filled with any 32 bytes — doesn't matter for balance reads).
  new PublicKey(WALLET).toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(amount, 64);
  return buf;
}

const connectionStub = {
  getBalance: vi.fn(),
  getTokenAccountsByOwner: vi.fn(),
  getTokenSupply: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  cache.clear();
  connectionStub.getBalance.mockReset();
  connectionStub.getTokenAccountsByOwner.mockReset();
  connectionStub.getTokenSupply.mockReset();

  // Default DefiLlama fetch returns no prices (priceMissing path). Specific
  // tests override with vi.stubGlobal.
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

describe("getSolanaBalances", () => {
  it("returns SOL native balance from getBalance", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(2_500_000_000); // 2.5 SOL
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    const { getSolanaBalances } = await import("../src/modules/solana/balances.js");
    const slice = await getSolanaBalances(WALLET);

    expect(slice.address).toBe(WALLET);
    expect(slice.native.length).toBe(1);
    expect(slice.native[0].symbol).toBe("SOL");
    expect(slice.native[0].formatted).toBe("2.5");
    expect(slice.spl.length).toBe(0);
  });

  it("aggregates SPL holdings from both SPL-Token and Token-2022 programs", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(0);
    // First call (SPL Token): USDC account with 100 USDC = 100_000_000 raw (6 decimals).
    // Second call (Token-2022): JUP account with 50 JUP = 50_000_000 raw (6 decimals).
    connectionStub.getTokenAccountsByOwner
      .mockResolvedValueOnce({
        value: [
          { account: { data: buildTokenAccountData(USDC_MINT, 100_000_000n) } },
        ],
      })
      .mockResolvedValueOnce({
        value: [
          { account: { data: buildTokenAccountData(JUP_MINT, 50_000_000n) } },
        ],
      });

    const { getSolanaBalances } = await import("../src/modules/solana/balances.js");
    const slice = await getSolanaBalances(WALLET);

    const symbols = slice.spl.map((s) => s.symbol).sort();
    expect(symbols).toEqual(["JUP", "USDC"]);
    const usdc = slice.spl.find((s) => s.symbol === "USDC");
    expect(usdc?.formatted).toBe("100");
    expect(usdc?.decimals).toBe(6);
  });

  it("marks unpriced tokens with priceMissing: true when DefiLlama returns nothing", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(1_000_000_000); // 1 SOL
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    const { getSolanaBalances } = await import("../src/modules/solana/balances.js");
    const slice = await getSolanaBalances(WALLET);
    expect(slice.native[0].priceMissing).toBe(true);
    expect(slice.native[0].valueUsd).toBeUndefined();
  });

  it("surfaces USD valuation when DefiLlama returns a price", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(2_000_000_000); // 2 SOL
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ coins: { "coingecko:solana": { price: 150 } } }),
        json: async () => ({ coins: { "coingecko:solana": { price: 150 } } }),
      })),
    );

    const { getSolanaBalances } = await import("../src/modules/solana/balances.js");
    const slice = await getSolanaBalances(WALLET);
    expect(slice.native[0].valueUsd).toBe(300); // 2 × 150
    expect(slice.native[0].priceUsd).toBe(150);
    expect(slice.walletBalancesUsd).toBe(300);
  });

  it("throws on non-Solana address input", async () => {
    const { getSolanaBalances } = await import("../src/modules/solana/balances.js");
    await expect(getSolanaBalances("0x1234567890123456789012345678901234567890")).rejects.toThrow();
  });
});

describe("getSolanaTokenBalance single-token API", () => {
  it("returns SOL balance for token:native", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(5_000_000_000); // 5 SOL
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    const { getSolanaTokenBalance } = await import("../src/modules/solana/balances.js");
    const bal = await getSolanaTokenBalance(WALLET, "native");
    expect(bal.symbol).toBe("SOL");
    expect(bal.formatted).toBe("5");
  });

  it("returns zero-balance shape when the wallet doesn't hold the mint", async () => {
    connectionStub.getBalance.mockResolvedValueOnce(0);
    connectionStub.getTokenAccountsByOwner.mockResolvedValue({ value: [] });

    const { getSolanaTokenBalance } = await import("../src/modules/solana/balances.js");
    const bal = await getSolanaTokenBalance(WALLET, USDC_MINT);
    expect(bal.symbol).toBe("USDC");
    expect(bal.amount).toBe("0");
    expect(bal.formatted).toBe("0");
  });
});
