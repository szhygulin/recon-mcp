import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseEther, toFunctionSelector } from "viem";

/**
 * Calldata + preflight tests for prepare_rocketpool_stake / unstake.
 *
 * Stake builder reads `getMaximumDepositAmount()` to refuse when the deposit
 * pool is paused (returns 0) or saturated (returns < requested amount).
 * Unstake builder reads rETH `balanceOf` + `getEthValue` + `getTotalCollateral`
 * via multicall and refuses on insufficient wallet balance or insufficient
 * on-protocol collateral. The rest is calldata-shape: `deposit()` selector,
 * `burn(uint256)` selector, value/data fields.
 */

describe("buildRocketPoolStake", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;

  function mockClient(maxAmount: bigint) {
    return {
      readContract: vi.fn(async () => maxAmount),
    };
  }

  it("produces a payable tx to RocketDepositPool with deposit() selector", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient(parseEther("100")),
      resetClients: () => {},
    }));
    const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
    const { CONTRACTS } = await import("../src/config/contracts.js");
    const tx = await buildRocketPoolStake({ wallet, amountEth: "1.5" });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(CONTRACTS.ethereum.rocketpool.depositPool.toLowerCase());
    expect(tx.from).toBe(wallet);
    expect(tx.value).toBe(parseEther("1.5").toString());
    const selector = toFunctionSelector("deposit()");
    expect(tx.data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true);
    // No args → 4-byte selector only.
    expect(tx.data.length).toBe(2 + 8);
  });

  it("decoded metadata preserves user-facing amount", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient(parseEther("100")),
      resetClients: () => {},
    }));
    const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
    const tx = await buildRocketPoolStake({ wallet, amountEth: "2.25" });
    expect(tx.decoded?.functionName).toBe("deposit");
    expect(tx.decoded?.args.value).toBe("2.25 ETH");
    expect(tx.description).toContain("2.25 ETH");
  });

  it("refuses when the deposit pool is disabled (getMaximumDepositAmount=0)", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient(0n),
      resetClients: () => {},
    }));
    const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
    await expect(buildRocketPoolStake({ wallet, amountEth: "1" })).rejects.toThrow(
      /currently disabled or the deposit pool is at capacity/,
    );
  });

  it("refuses when amount exceeds current pool capacity", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient(parseEther("0.5")),
      resetClients: () => {},
    }));
    const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
    await expect(buildRocketPoolStake({ wallet, amountEth: "1" })).rejects.toThrow(
      /can currently accept at most 0.5 ETH/,
    );
  });
});

describe("buildRocketPoolUnstake", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const wallet = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  function mockMulticall(balance: bigint, ethValue: bigint, totalCollateral: bigint) {
    return {
      multicall: vi.fn(async () => [balance, ethValue, totalCollateral]),
    };
  }

  it("produces a tx to rETH with burn(uint256) selector encoding amount in wei", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockMulticall(parseEther("10"), parseEther("0.27"), parseEther("100")),
      resetClients: () => {},
    }));
    const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
    const { CONTRACTS } = await import("../src/config/contracts.js");
    const tx = await buildRocketPoolUnstake({ wallet, amountReth: "0.25" });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(CONTRACTS.ethereum.rocketpool.rETH.toLowerCase());
    expect(tx.from).toBe(wallet);
    expect(tx.value).toBe("0");
    const selector = toFunctionSelector("burn(uint256)");
    expect(tx.data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true);
    expect(tx.data.length).toBe(2 + 8 + 64);
    const argHex = tx.data.slice(2 + 8);
    expect(BigInt("0x" + argHex)).toBe(parseEther("0.25"));
  });

  it("decoded metadata reports both rETH burned and ETH received from getEthValue", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockMulticall(parseEther("10"), parseEther("1.1"), parseEther("100")),
      resetClients: () => {},
    }));
    const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
    const tx = await buildRocketPoolUnstake({ wallet, amountReth: "1" });
    expect(tx.decoded?.functionName).toBe("burn");
    expect(tx.decoded?.args.rethAmount).toBe("1 rETH");
    expect(tx.decoded?.args.ethReceived).toBe("1.1 ETH");
    expect(tx.description).toContain("1 rETH");
    expect(tx.description).toContain("1.1 ETH");
  });

  it("refuses when wallet rETH balance is below the burn amount", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockMulticall(parseEther("0.1"), parseEther("0.11"), parseEther("100")),
      resetClients: () => {},
    }));
    const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
    await expect(
      buildRocketPoolUnstake({ wallet, amountReth: "1" }),
    ).rejects.toThrow(/Insufficient rETH balance/);
  });

  it("refuses when on-protocol collateral cannot cover the redemption", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () =>
        mockMulticall(parseEther("10"), parseEther("5"), parseEther("1")),
      resetClients: () => {},
    }));
    const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
    await expect(
      buildRocketPoolUnstake({ wallet, amountReth: "5" }),
    ).rejects.toThrow(/on-protocol ETH collateral is 1/);
  });
});
