/**
 * Tests for `prepareTokenApprove` — the write-side counterpart to
 * `prepare_revoke_approval`, gated dedicated tool for setting non-zero
 * ERC-20 allowances. Issue #556.
 *
 * Coverage:
 *   - Happy path: decimal amount + "max" both encode to the right
 *     approve(spender, amount) calldata; friendly label appears in the
 *     description / decoded.args when the spender is in CONTRACTS.
 *   - Burn-address gate: refuses unlimited approve to canonical no-key
 *     addresses (0x0…0, 0x0…dEaD, 0xdEaD…0, 0xff…ff).
 *   - Override: `acknowledgeBurnApproval: true` allows the call through.
 *   - Decimal-amount + burn spender is NOT refused (only unlimited is).
 *   - amount === 0 refuses with a redirect to prepare_revoke_approval.
 *   - amount validation rejects non-decimal / non-"max" inputs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

const { readContractMock, multicallMock, callMock, estimateGasMock, getGasPriceMock } =
  vi.hoisted(() => ({
    readContractMock: vi.fn(),
    multicallMock: vi.fn(),
    callMock: vi.fn(),
    estimateGasMock: vi.fn(),
    getGasPriceMock: vi.fn(),
  }));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
    call: callMock,
    estimateGas: estimateGasMock,
    getGasPrice: getGasPriceMock,
    getChainId: vi.fn(),
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

vi.mock("../src/data/prices.js", () => ({
  getTokenPrice: vi.fn().mockResolvedValue(undefined),
  getTokenPrices: vi.fn().mockResolvedValue(new Map()),
  getDefillamaCoinPrice: vi.fn().mockResolvedValue(undefined),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"; // known label
const RANDOM_SPENDER = "0x1111111111111111111111111111111111111111";
const UINT256_MAX = (1n << 256n) - 1n;

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
  callMock.mockReset();
  estimateGasMock.mockReset();
  getGasPriceMock.mockReset();
  // Token metadata = USDC (6 decimals).
  multicallMock.mockResolvedValue([6, "USDC"]);
  callMock.mockResolvedValue({
    data: "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
  estimateGasMock.mockResolvedValue(50_000n);
  getGasPriceMock.mockResolvedValue(10_000_000_000n);
});

describe("prepareTokenApprove — happy path", () => {
  it("encodes approve(spender, amountWei) for a decimal amount", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareTokenApprove({
      wallet: WALLET,
      chain: "ethereum",
      token: USDC,
      spender: RANDOM_SPENDER,
      amount: "100",
    });
    expect(tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[0]).toBe(RANDOM_SPENDER);
    expect(decoded.args?.[1]).toBe(100_000_000n); // 100 * 10^6
  });

  it("encodes approve(spender, uint256.max) for amount=\"max\"", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareTokenApprove({
      wallet: WALLET,
      chain: "ethereum",
      token: USDC,
      spender: RANDOM_SPENDER,
      amount: "max",
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.args?.[1]).toBe(UINT256_MAX);
    expect(tx.description).toContain("unlimited");
  });

  it("surfaces friendly spender label for known protocol contracts", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareTokenApprove({
      wallet: WALLET,
      chain: "ethereum",
      token: USDC,
      spender: AAVE_POOL,
      amount: "100",
    });
    expect(tx.description).toContain("Aave V3");
    expect(tx.decoded?.args.spenderLabel).toContain("Aave V3");
  });
});

describe("prepareTokenApprove — burn-address gate (issue #556)", () => {
  it.each([
    ["0xdead000000000000000000000000000000000000"],
    ["0x000000000000000000000000000000000000dead"],
    ["0x0000000000000000000000000000000000000000"],
    ["0xffffffffffffffffffffffffffffffffffffffff"],
  ])("refuses amount=\"max\" to canonical burn address %s", async (burn) => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareTokenApprove({
        wallet: WALLET,
        chain: "ethereum",
        token: USDC,
        spender: burn as `0x${string}`,
        amount: "max",
      }),
    ).rejects.toThrow(/BURN_ADDRESS_UNLIMITED_APPROVAL/);
  });

  it("allows amount=\"max\" to burn address with acknowledgeBurnApproval=true", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareTokenApprove({
      wallet: WALLET,
      chain: "ethereum",
      token: USDC,
      spender: "0xdead000000000000000000000000000000000000",
      amount: "max",
      acknowledgeBurnApproval: true,
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.args?.[1]).toBe(UINT256_MAX);
  });

  it("allows finite amount to burn address (gate fires only on unlimited)", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareTokenApprove({
      wallet: WALLET,
      chain: "ethereum",
      token: USDC,
      spender: "0xdead000000000000000000000000000000000000",
      amount: "100",
    });
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });
});

describe("prepareTokenApprove — input validation", () => {
  it("refuses amount=0 with a redirect to prepare_revoke_approval", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareTokenApprove({
        wallet: WALLET,
        chain: "ethereum",
        token: USDC,
        spender: RANDOM_SPENDER,
        amount: "0",
      }),
    ).rejects.toThrow(/prepare_revoke_approval/);
  });

  it("refuses non-decimal non-\"max\" amount strings", async () => {
    const { prepareTokenApprove } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareTokenApprove({
        wallet: WALLET,
        chain: "ethereum",
        token: USDC,
        spender: RANDOM_SPENDER,
        amount: "abc",
      }),
    ).rejects.toThrow(/decimal string|max/);
  });
});
