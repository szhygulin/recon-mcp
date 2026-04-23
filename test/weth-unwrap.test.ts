import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseEther, toFunctionSelector } from "viem";
import { CONTRACTS } from "../src/config/contracts.js";

/**
 * Tests for the `prepare_weth_unwrap` builder (issue #72). The builder
 * consults an RPC `readContract` for the balance check + the `"max"`
 * resolver, so tests mock `getClient` to a stub.
 */

const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;

const readContractMock = vi.fn();

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
  }),
}));

beforeEach(() => {
  readContractMock.mockReset();
});

describe("buildWethUnwrap", () => {
  it("targets the canonical WETH9 address for ethereum", async () => {
    readContractMock.mockResolvedValueOnce(parseEther("10")); // wallet has 10 WETH
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    const tx = await buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "0.5" });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(CONTRACTS.ethereum.tokens.WETH.toLowerCase());
    expect(tx.value).toBe("0");
    expect(tx.from).toBe(WALLET);
  });

  it("produces calldata starting with the withdraw(uint256) selector", async () => {
    readContractMock.mockResolvedValueOnce(parseEther("10"));
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    const tx = await buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "1" });
    const selector = toFunctionSelector("withdraw(uint256)");
    expect(tx.data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true);
    // selector (8) + uint256 (64) = 72 hex chars after 0x.
    expect(tx.data.length).toBe(2 + 8 + 64);
  });

  it("resolves `max` via on-chain balanceOf", async () => {
    const bal = parseEther("3.14");
    readContractMock.mockResolvedValueOnce(bal);
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    const tx = await buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "max" });
    expect(tx.description).toContain("3.14 WETH");
    // The uint256 argument (last 64 hex chars of data) should equal bal in hex, zero-padded.
    const argHex = tx.data.slice(2 + 8);
    expect(BigInt("0x" + argHex)).toBe(bal);
  });

  it("refuses pre-sign when the wallet is short", async () => {
    readContractMock.mockResolvedValueOnce(parseEther("0.1")); // only 0.1 WETH
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    await expect(
      buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "1" }),
    ).rejects.toThrow(/Insufficient WETH/);
  });

  it("refuses `max` when the wallet holds zero WETH", async () => {
    readContractMock.mockResolvedValueOnce(0n);
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    await expect(
      buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "max" }),
    ).rejects.toThrow(/holds 0 WETH/);
  });

  it("uses the L2-predeploy WETH address on base and optimism (0x4200…0006)", async () => {
    readContractMock.mockResolvedValueOnce(parseEther("1"));
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    const baseTx = await buildWethUnwrap({ wallet: WALLET, chain: "base", amount: "0.5" });
    expect(baseTx.to.toLowerCase()).toBe("0x4200000000000000000000000000000000000006");

    readContractMock.mockResolvedValueOnce(parseEther("1"));
    const opTx = await buildWethUnwrap({ wallet: WALLET, chain: "optimism", amount: "0.5" });
    expect(opTx.to.toLowerCase()).toBe("0x4200000000000000000000000000000000000006");
  });

  it("uses the chain-specific WETH address on arbitrum and polygon", async () => {
    readContractMock.mockResolvedValueOnce(parseEther("1"));
    const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
    const arbTx = await buildWethUnwrap({ wallet: WALLET, chain: "arbitrum", amount: "0.5" });
    expect(arbTx.to.toLowerCase()).toBe(CONTRACTS.arbitrum.tokens.WETH.toLowerCase());

    readContractMock.mockResolvedValueOnce(parseEther("1"));
    const polyTx = await buildWethUnwrap({ wallet: WALLET, chain: "polygon", amount: "0.5" });
    expect(polyTx.to.toLowerCase()).toBe(CONTRACTS.polygon.tokens.WETH.toLowerCase());
  });
});
