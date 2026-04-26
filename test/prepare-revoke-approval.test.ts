/**
 * Tests for `prepareRevokeApproval` — the write-side counterpart to
 * `get_token_allowances`. Builds an `approve(spender, 0)` tx after
 * pre-checking the live allowance is non-zero, with friendly spender
 * labels resolved from the canonical CONTRACTS table.
 *
 * Coverage:
 *   - Happy path: live allowance > 0 → returns UnsignedTx whose
 *     calldata decodes to `approve(spender, 0)`.
 *   - Refuses when the live allowance is already 0 (no-op gas burn
 *     guard).
 *   - Surfaces the friendly label for known protocol contracts (Aave
 *     V3 Pool) in description + decoded.args.
 *   - Description includes the previous allowance amount so the user
 *     sees what's being zeroed out.
 *   - Pre-flight runs BEFORE token-metadata lookup; allowance read is
 *     the gating call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
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
// Aave V3 Pool on Ethereum — known label in CONTRACTS.
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const RANDOM_SPENDER = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
  callMock.mockReset();
  estimateGasMock.mockReset();
  getGasPriceMock.mockReset();
  // Default: token metadata = USDC (6 decimals). Both name+symbol get
  // pulled by resolveTokenMeta.
  multicallMock.mockResolvedValue([6, "USDC"]);
  // simulateTx → eth_call returns a 32-byte truthy bool (for approve).
  callMock.mockResolvedValue({
    data: "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
  estimateGasMock.mockResolvedValue(50_000n);
  getGasPriceMock.mockResolvedValue(10_000_000_000n);
});

describe("prepareRevokeApproval — happy path", () => {
  it("builds approve(spender, 0) calldata with the right `to` and `value: 0`", async () => {
    // Live allowance = 1 USDC (1_000_000 in 6-decimal raw).
    readContractMock.mockResolvedValue(1_000_000n);
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(tx.value).toBe("0");
    expect(tx.from?.toLowerCase()).toBe(WALLET.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[0]).toBe(RANDOM_SPENDER);
    expect(decoded.args?.[1]).toBe(0n);
    expect(tx.decoded?.functionName).toBe("approve");
    expect(tx.decoded?.args.amount).toBe("0");
    expect(tx.decoded?.args.note).toBe("revoke");
  });

  it("includes the previous allowance amount in the description", async () => {
    readContractMock.mockResolvedValue(50_000_000n); // 50 USDC (6 decimals)
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(tx.description).toContain("Revoke USDC");
    expect(tx.description).toContain("was 50 USDC");
  });

  it("resolves the friendly label for known protocol spenders (Aave V3 Pool)", async () => {
    readContractMock.mockResolvedValue(1_000_000n);
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet: WALLET,
      token: USDC,
      spender: AAVE_POOL,
      chain: "ethereum",
    });
    expect(tx.description).toContain("Aave V3 Pool");
    expect(tx.decoded?.args.spenderLabel).toBe("Aave V3 Pool");
  });

  it("omits spenderLabel for arbitrary (non-protocol) spenders", async () => {
    readContractMock.mockResolvedValue(1_000_000n);
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(tx.decoded?.args.spenderLabel).toBeUndefined();
    // Description carries the raw spender address only.
    expect(tx.description).toContain(RANDOM_SPENDER);
  });
});

describe("prepareRevokeApproval — refuses no-op", () => {
  it("throws when the live allowance is already 0", async () => {
    readContractMock.mockResolvedValue(0n);
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareRevokeApproval({
        wallet: WALLET,
        token: USDC,
        spender: RANDOM_SPENDER,
        chain: "ethereum",
      }),
    ).rejects.toThrow(/no allowance to revoke|already 0/i);
  });

  it("does NOT call resolveTokenMeta when the allowance check fails", async () => {
    readContractMock.mockResolvedValue(0n);
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      prepareRevokeApproval({
        wallet: WALLET,
        token: USDC,
        spender: RANDOM_SPENDER,
        chain: "ethereum",
      }),
    ).rejects.toThrow();
    // resolveTokenMeta uses multicall — should not be invoked when the
    // pre-flight zero-allowance check throws first.
    expect(multicallMock).not.toHaveBeenCalled();
  });
});

describe("prepareRevokeApproval — calldata exact-match", () => {
  it("emits the exact bytes for approve(spender, 0)", async () => {
    readContractMock.mockResolvedValue(1n);
    const expected = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [RANDOM_SPENDER, 0n],
    });
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(tx.data).toBe(expected);
  });
});

describe("prepareRevokeApprovalInput — schema", () => {
  it("accepts a well-formed input", async () => {
    const { prepareRevokeApprovalInput } = await import(
      "../src/modules/execution/schemas.js"
    );
    const res = prepareRevokeApprovalInput.safeParse({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(res.success).toBe(true);
  });

  it("defaults chain to ethereum", async () => {
    const { prepareRevokeApprovalInput } = await import(
      "../src/modules/execution/schemas.js"
    );
    const res = prepareRevokeApprovalInput.safeParse({
      wallet: WALLET,
      token: USDC,
      spender: RANDOM_SPENDER,
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.chain).toBe("ethereum");
    }
  });

  it("rejects malformed addresses", async () => {
    const { prepareRevokeApprovalInput } = await import(
      "../src/modules/execution/schemas.js"
    );
    const res = prepareRevokeApprovalInput.safeParse({
      wallet: "not-an-address",
      token: USDC,
      spender: RANDOM_SPENDER,
      chain: "ethereum",
    });
    expect(res.success).toBe(false);
  });
});
