import { describe, it, expect } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import { cometAbi } from "../src/abis/compound-comet.js";
import { morphoBlueAbi } from "../src/abis/morpho-blue.js";

/**
 * We can't exercise the full builders without an RPC (they read baseToken / idToMarketParams
 * on chain), but we can assert that the ABI encodings used inside them produce the right
 * selector + argument shapes — this catches ABI drift and argument-order bugs.
 */

describe("Compound V3 (Comet) calldata", () => {
  it("supply(asset, amount) uses selector 0xf2b9fdb8", () => {
    const data = encodeFunctionData({
      abi: cometAbi,
      functionName: "supply",
      args: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1_000_000n],
    });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("supply(address,uint256)").slice(0, 10));
  });

  it("withdraw(asset, amount) uses selector for withdraw(address,uint256)", () => {
    const data = encodeFunctionData({
      abi: cometAbi,
      functionName: "withdraw",
      args: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1_000_000n],
    });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("withdraw(address,uint256)").slice(0, 10));
  });
});

describe("Morpho Blue calldata", () => {
  const params = {
    loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
    collateralToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as `0x${string}`,
    oracle: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    irm: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    lltv: 860000000000000000n,
  };
  const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;

  it("supply selector matches supply((address,address,address,address,uint256),uint256,uint256,address,bytes)", () => {
    const data = encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supply",
      args: [params, 1_000_000n, 0n, wallet, "0x"],
    });
    const expected = toFunctionSelector(
      "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"
    );
    expect(data.slice(0, 10)).toBe(expected.slice(0, 10));
  });

  it("supplyCollateral selector matches its 4-arg signature", () => {
    const data = encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supplyCollateral",
      args: [params, 1_000_000n, wallet, "0x"],
    });
    const expected = toFunctionSelector(
      "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"
    );
    expect(data.slice(0, 10)).toBe(expected.slice(0, 10));
  });

  it("borrow selector matches its 5-arg signature", () => {
    const data = encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "borrow",
      args: [params, 1_000_000n, 0n, wallet, wallet],
    });
    const expected = toFunctionSelector(
      "borrow((address,address,address,address,uint256),uint256,uint256,address,address)"
    );
    expect(data.slice(0, 10)).toBe(expected.slice(0, 10));
  });
});
