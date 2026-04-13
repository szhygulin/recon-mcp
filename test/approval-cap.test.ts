/**
 * Tests for the shared approvalCap option. Every prepare_* tool that emits
 * an ERC-20 approval (Compound supply/repay, Morpho supply/repay/supplyCollateral,
 * Lido unstake, EigenLayer deposit) accepts an `approvalCap` param:
 *   - undefined / "unlimited" → approve(maxUint256) (traditional DeFi UX)
 *   - "exact"                 → approve(amountWei)
 *   - decimal string          → approve(parseUnits(str, decimals)), must be ≥ amountWei
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, maxUint256, parseUnits } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

const { readContractMock, multicallMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
  multicallMock: vi.fn(),
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
    getChainId: vi.fn(),
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MARKET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3"; // cUSDCv3
const WALLET = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
  // Token metadata: 6 decimals (USDC-like), symbol "USDC".
  multicallMock.mockResolvedValue([6, "USDC"]);
  // allowance(wallet, market) = 0 → approval is emitted.
  readContractMock.mockResolvedValue(0n);
});

describe("resolveApprovalCap", () => {
  it("undefined → maxUint256 (unlimited default)", async () => {
    const { resolveApprovalCap } = await import("../src/modules/shared/approval.js");
    const { approvalAmount, display } = resolveApprovalCap(undefined, 500_000_000n, 6);
    expect(approvalAmount).toBe(maxUint256);
    expect(display).toBe("unlimited");
  });

  it('"unlimited" → maxUint256', async () => {
    const { resolveApprovalCap } = await import("../src/modules/shared/approval.js");
    const { approvalAmount } = resolveApprovalCap("unlimited", 500n, 6);
    expect(approvalAmount).toBe(maxUint256);
  });

  it('"exact" → amountWei', async () => {
    const { resolveApprovalCap } = await import("../src/modules/shared/approval.js");
    const { approvalAmount, display } = resolveApprovalCap("exact", 500_000_000n, 6);
    expect(approvalAmount).toBe(500_000_000n);
    expect(display).toBe("exact amount");
  });

  it("decimal string → parseUnits(decimal, decimals)", async () => {
    const { resolveApprovalCap } = await import("../src/modules/shared/approval.js");
    // cap "1000" USDC with 6 decimals = 1_000_000_000 wei.
    const { approvalAmount, display } = resolveApprovalCap("1000", 500_000_000n, 6);
    expect(approvalAmount).toBe(1_000_000_000n);
    expect(display).toBe("1000 (capped)");
  });

  it("decimal string below action amount → throws", async () => {
    const { resolveApprovalCap } = await import("../src/modules/shared/approval.js");
    expect(() => resolveApprovalCap("100", 500_000_000n, 6)).toThrow(
      /less than the amount being transacted/
    );
  });
});

describe("buildCompoundSupply: approvalCap flows through", () => {
  it('default (omitted) → approve(maxUint256)', async () => {
    const { buildCompoundSupply } = await import("../src/modules/compound/actions.js");
    const tx = await buildCompoundSupply({
      wallet: WALLET,
      chain: "ethereum",
      market: MARKET,
      asset: USDC,
      amount: "500",
    });
    // tx is the approve (first step); supply is tx.next.
    expect(tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[1]).toBe(maxUint256);
    expect(tx.description).toMatch(/unlimited/);
  });

  it('"exact" → approve(amountWei)', async () => {
    const { buildCompoundSupply } = await import("../src/modules/compound/actions.js");
    const tx = await buildCompoundSupply({
      wallet: WALLET,
      chain: "ethereum",
      market: MARKET,
      asset: USDC,
      amount: "500",
      approvalCap: "exact",
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    // 500 USDC with 6 decimals = 500_000_000.
    expect(decoded.args?.[1]).toBe(parseUnits("500", 6));
    expect(tx.description).toMatch(/exact amount/);
  });

  it('"1000" → approve(parseUnits("1000", 6))', async () => {
    const { buildCompoundSupply } = await import("../src/modules/compound/actions.js");
    const tx = await buildCompoundSupply({
      wallet: WALLET,
      chain: "ethereum",
      market: MARKET,
      asset: USDC,
      amount: "500",
      approvalCap: "1000",
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.args?.[1]).toBe(parseUnits("1000", 6));
    expect(tx.description).toMatch(/1000 \(capped\)/);
  });

  it("cap below amount → throws", async () => {
    const { buildCompoundSupply } = await import("../src/modules/compound/actions.js");
    await expect(
      buildCompoundSupply({
        wallet: WALLET,
        chain: "ethereum",
        market: MARKET,
        asset: USDC,
        amount: "500",
        approvalCap: "100",
      })
    ).rejects.toThrow(/less than the amount being transacted/);
  });

  it("schema accepts approvalCap", async () => {
    const { prepareCompoundSupplyInput } = await import("../src/modules/compound/schemas.js");
    const res = prepareCompoundSupplyInput.safeParse({
      wallet: WALLET,
      chain: "ethereum",
      market: MARKET,
      asset: USDC,
      amount: "500",
      approvalCap: "500",
    });
    expect(res.success).toBe(true);
  });
});
