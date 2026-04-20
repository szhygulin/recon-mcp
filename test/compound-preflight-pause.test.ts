/**
 * Pre-flight pause checks for prepare_compound_* tools.
 *
 * The prior behavior was to build an UnsignedTx unconditionally; the Paused()
 * revert would only surface during simulate_transaction or signing. That's the
 * bug that bit cUSDCv3 on 2026-04-20 after the rsETH exploit — governance
 * paused withdraws but prepare_compound_withdraw still produced a handle and a
 * decoded preview that both looked fine. These tests lock in the refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Compound V3 prepare_* pause pre-flight", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  function mockClient(paused: Record<string, boolean>) {
    return {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName in paused) return paused[params.functionName];
        if (params.functionName === "baseToken") {
          return "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
        }
        throw new Error(`unmocked readContract: ${params.functionName}`);
      }),
      multicall: vi.fn(async () => [6, "USDC"]),
    };
  }

  it("buildCompoundWithdraw refuses when isWithdrawPaused=true", async () => {
    const client = mockClient({ isWithdrawPaused: true });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildCompoundWithdraw } = await import(
      "../src/modules/compound/actions.js"
    );
    await expect(
      buildCompoundWithdraw({
        chain: "ethereum",
        market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        wallet: "0x1111111111111111111111111111111111111111",
        amount: "100",
      })
    ).rejects.toThrow(/withdraw paused/);
  });

  it("buildCompoundSupply refuses when isSupplyPaused=true", async () => {
    const client = mockClient({ isSupplyPaused: true });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildCompoundSupply } = await import(
      "../src/modules/compound/actions.js"
    );
    await expect(
      buildCompoundSupply({
        chain: "ethereum",
        market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        wallet: "0x1111111111111111111111111111111111111111",
        amount: "100",
      })
    ).rejects.toThrow(/supply paused/);
  });

  it("buildCompoundBorrow refuses when isWithdrawPaused=true (borrow == withdraw of base)", async () => {
    const client = mockClient({ isWithdrawPaused: true });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildCompoundBorrow } = await import(
      "../src/modules/compound/actions.js"
    );
    await expect(
      buildCompoundBorrow({
        chain: "ethereum",
        market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        wallet: "0x1111111111111111111111111111111111111111",
        amount: "100",
      })
    ).rejects.toThrow(/withdraw paused/);
  });

  it("buildCompoundRepay refuses when isSupplyPaused=true (repay == supply of base)", async () => {
    const client = mockClient({ isSupplyPaused: true });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildCompoundRepay } = await import(
      "../src/modules/compound/actions.js"
    );
    await expect(
      buildCompoundRepay({
        chain: "ethereum",
        market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        wallet: "0x1111111111111111111111111111111111111111",
        amount: "100",
      })
    ).rejects.toThrow(/supply paused/);
  });
});
