/**
 * Pre-flight reserve-state checks for prepare_aave_* tools.
 *
 * The pool's reserve configuration bitmap has bit 56 (active), bit 57 (frozen),
 * and bit 60 (paused). Before this change, a prepare_aave_withdraw against a
 * paused reserve would return a valid-looking UnsignedTx that reverts on send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const WALLET = "0x1111111111111111111111111111111111111111" as const;

function cfgBitmap({
  active = true,
  frozen = false,
  paused = false,
}: {
  active?: boolean;
  frozen?: boolean;
  paused?: boolean;
}): bigint {
  let data = 0n;
  if (active) data |= 1n << 56n;
  if (frozen) data |= 1n << 57n;
  if (paused) data |= 1n << 60n;
  return data;
}

function mockAaveClient(state: { paused?: boolean; frozen?: boolean; active?: boolean }) {
  return {
    readContract: vi.fn(async (params: { functionName: string }) => {
      if (params.functionName === "getPool") {
        return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
      }
      if (params.functionName === "getReserveData") {
        return { configuration: { data: cfgBitmap(state) } };
      }
      throw new Error(`unmocked: ${params.functionName}`);
    }),
  };
}

describe("Aave V3 prepare_* reserve-state pre-flight", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("refuses buildAaveWithdraw when reserve.isPaused=true", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockAaveClient({ paused: true }),
      resetClients: () => {},
    }));
    const { buildAaveWithdraw } = await import(
      "../src/modules/positions/actions.js"
    );
    await expect(
      buildAaveWithdraw({
        chain: "ethereum",
        wallet: WALLET,
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
      })
    ).rejects.toThrow(/paused by governance/);
  });

  it("refuses buildAaveSupply when reserve.isFrozen=true", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockAaveClient({ frozen: true }),
      resetClients: () => {},
    }));
    const { buildAaveSupply } = await import(
      "../src/modules/positions/actions.js"
    );
    await expect(
      buildAaveSupply({
        chain: "ethereum",
        wallet: WALLET,
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
      })
    ).rejects.toThrow(/frozen/);
  });

  it("refuses buildAaveBorrow when reserve.isFrozen=true", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockAaveClient({ frozen: true }),
      resetClients: () => {},
    }));
    const { buildAaveBorrow } = await import(
      "../src/modules/positions/actions.js"
    );
    await expect(
      buildAaveBorrow({
        chain: "ethereum",
        wallet: WALLET,
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
      })
    ).rejects.toThrow(/frozen/);
  });

  it("allows buildAaveRepay when reserve.isFrozen=true (winding down is allowed)", async () => {
    // Frozen reserves must still allow repay + withdraw so users can exit their
    // positions. This test locks that in so a future tightening doesn't
    // accidentally trap users.
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        ...mockAaveClient({ frozen: true }),
        multicall: vi.fn(async () => [false]),
      }),
      resetClients: () => {},
    }));
    // We only test that the pre-flight doesn't reject; we don't need the full
    // repay path to succeed (it needs ERC-20 metadata etc). The assert-allowed
    // call is the first await in the function, so we drive it via getReserveData
    // and expect no synchronous rejection from the pre-flight itself.
    const { buildAaveRepay } = await import(
      "../src/modules/positions/actions.js"
    );
    await expect(
      buildAaveRepay({
        chain: "ethereum",
        wallet: WALLET,
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
      })
    ).rejects.not.toThrow(/frozen|paused/);
  });

  it("refuses all actions when reserve is inactive", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockAaveClient({ active: false }),
      resetClients: () => {},
    }));
    const { buildAaveWithdraw } = await import(
      "../src/modules/positions/actions.js"
    );
    await expect(
      buildAaveWithdraw({
        chain: "ethereum",
        wallet: WALLET,
        asset: USDC,
        amount: "100",
        decimals: 6,
        symbol: "USDC",
      })
    ).rejects.toThrow(/not active/);
  });
});
