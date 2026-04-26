import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  prepareSafeTxPropose,
  prepareSafeTxApprove,
  submitSafeTxSignature,
} from "../src/modules/safe/actions.js";
import {
  rememberSafeTx,
  clearSafeTxStoreForTesting,
  lookupSafeTx,
} from "../src/modules/safe/safe-tx-store.js";
import { computeSafeTxHash, buildSafeTxBody } from "../src/modules/safe/safe-tx.js";

// Mock the SDK so the tests don't need a SAFE_API_KEY.
const mockKit = {
  getNextNonce: vi.fn(async () => "12"),
  proposeTransaction: vi.fn(async () => undefined),
  confirmTransaction: vi.fn(async () => ({ signature: "0x" })),
  getTransaction: vi.fn(),
};
vi.mock("../src/modules/safe/sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/safe/sdk.js")>();
  return {
    ...actual,
    getSafeApiKit: () => mockKit,
  };
});

// Mock the on-chain reads. `nonce()` for resolveNonce, `approvedHashes()`
// for the submit gate.
const mockClient = {
  readContract: vi.fn(),
};
vi.mock("../src/data/rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/rpc.js")>();
  return {
    ...actual,
    getClient: () => mockClient,
  };
});

const SAFE = "0x1111111111111111111111111111111111111111";
const SIGNER = "0x742d35cc6634c0532925a3b844bc9e7595f8b8b8";
const RECIPIENT = "0x0000000000000000000000000000000000000abc";

describe("prepare_safe_tx_propose", () => {
  beforeEach(() => {
    clearSafeTxStoreForTesting();
    mockKit.getNextNonce.mockReset();
    mockKit.getNextNonce.mockResolvedValue("12");
    mockClient.readContract.mockReset();
    mockClient.readContract.mockResolvedValue(11n); // on-chain nonce — under service nonce
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an approveHash UnsignedTx whose `to` is the Safe and stashes the SafeTx body", async () => {
    const tx = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: RECIPIENT, value: "1000", data: "0x", operation: 0 },
    });
    expect(tx.to.toLowerCase()).toBe(SAFE.toLowerCase());
    // approveHash selector
    expect(tx.data.slice(0, 10)).toBe("0xd4d9bdcd");
    expect(tx.value).toBe("0");
    expect(tx.from?.toLowerCase()).toBe(SIGNER.toLowerCase());

    // The expected hash should be in the store (keyed by hash).
    const expectedHash = computeSafeTxHash({
      chain: "ethereum",
      safeAddress: SAFE,
      body: buildSafeTxBody({
        to: RECIPIENT,
        value: "1000",
        data: "0x",
        operation: 0,
        nonce: "12",
      }),
    });
    expect(lookupSafeTx(expectedHash)).toBeDefined();
  });

  it("refuses when the service nonce drops below on-chain nonce (queue corruption guard)", async () => {
    mockKit.getNextNonce.mockResolvedValueOnce("5");
    mockClient.readContract.mockResolvedValueOnce(20n);
    await expect(
      prepareSafeTxPropose({
        signer: SIGNER,
        safeAddress: SAFE,
        chain: "ethereum",
        inner: { to: RECIPIENT, value: "0", data: "0x", operation: 0 },
      }),
    ).rejects.toThrow(/stale nonce/);
  });

  it("uses nonceOverride verbatim when supplied (replacement-tx case)", async () => {
    await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      nonceOverride: "99",
      inner: { to: RECIPIENT, value: "0", data: "0x", operation: 0 },
    });
    const expectedHash = computeSafeTxHash({
      chain: "ethereum",
      safeAddress: SAFE,
      body: buildSafeTxBody({
        to: RECIPIENT,
        value: "0",
        data: "0x",
        operation: 0,
        nonce: "99",
      }),
    });
    expect(lookupSafeTx(expectedHash)).toBeDefined();
    expect(mockKit.getNextNonce).not.toHaveBeenCalled();
  });
});

describe("prepare_safe_tx_approve", () => {
  beforeEach(() => {
    clearSafeTxStoreForTesting();
  });

  it("returns an approveHash tx for an existing safeTxHash", async () => {
    const safeTxHash = "0x" + "ab".repeat(32);
    const tx = await prepareSafeTxApprove({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash as `0x${string}`,
    });
    expect(tx.to.toLowerCase()).toBe(SAFE.toLowerCase());
    expect(tx.data.slice(0, 10)).toBe("0xd4d9bdcd");
    expect(tx.data.toLowerCase()).toContain(safeTxHash.slice(2));
  });
});

describe("submit_safe_tx_signature", () => {
  const safeTxHash = `0x${"cd".repeat(32)}` as `0x${string}`;

  beforeEach(() => {
    clearSafeTxStoreForTesting();
    mockClient.readContract.mockReset();
    mockKit.proposeTransaction.mockReset();
    mockKit.confirmTransaction.mockReset();
  });

  it("throws when approvedHashes returns 0 (user hasn't broadcast yet)", async () => {
    mockClient.readContract.mockResolvedValue(0n);
    await expect(
      submitSafeTxSignature({
        signer: SIGNER,
        safeAddress: SAFE,
        chain: "ethereum",
        safeTxHash,
      }),
    ).rejects.toThrow(/has not approved/);
  });

  it("calls proposeTransaction when the SafeTx body is in the local store", async () => {
    rememberSafeTx({
      safeTxHash,
      chain: "ethereum",
      safeAddress: SAFE,
      body: buildSafeTxBody({
        to: RECIPIENT,
        value: "0",
        data: "0x",
        operation: 0,
        nonce: "1",
      }),
    });
    mockClient.readContract.mockResolvedValue(1n);

    const result = await submitSafeTxSignature({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash,
    });
    expect(result.action).toBe("proposed");
    expect(mockKit.proposeTransaction).toHaveBeenCalledOnce();
    expect(mockKit.confirmTransaction).not.toHaveBeenCalled();
  });

  it("calls confirmTransaction when the SafeTx body is unknown locally", async () => {
    mockClient.readContract.mockResolvedValue(1n);

    const result = await submitSafeTxSignature({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash,
    });
    expect(result.action).toBe("confirmed");
    expect(mockKit.confirmTransaction).toHaveBeenCalledOnce();
    expect(mockKit.proposeTransaction).not.toHaveBeenCalled();
  });
});
