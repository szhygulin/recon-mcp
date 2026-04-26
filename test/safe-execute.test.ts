import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prepareSafeTxExecute } from "../src/modules/safe/execute.js";
import {
  rememberSafeTx,
  clearSafeTxStoreForTesting,
} from "../src/modules/safe/safe-tx-store.js";
import { buildSafeTxBody } from "../src/modules/safe/safe-tx.js";

const mockKit = {
  getTransaction: vi.fn(),
};
vi.mock("../src/modules/safe/sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/safe/sdk.js")>();
  return {
    ...actual,
    getSafeApiKit: () => mockKit,
  };
});

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
const RECIPIENT = "0x0000000000000000000000000000000000000abc";
// Three owner addresses, deliberately NOT in ascending order so the
// signatures-blob ordering test can detect mistakes.
const OWNER_A = "0x9999999999999999999999999999999999999999";
const OWNER_B = "0x4444444444444444444444444444444444444444";
const OWNER_C = "0x7777777777777777777777777777777777777777";
const STRANGER = "0x0000000000000000000000000000000000001234";

function safeTxHash(): `0x${string}` {
  return `0x${"ab".repeat(32)}` as `0x${string}`;
}

function setOnChainState(args: {
  threshold: bigint;
  owners: readonly `0x${string}`[];
  approvalsByOwner: Record<string, bigint>;
}): void {
  mockClient.readContract.mockImplementation((req: { functionName: string; args?: unknown[] }) => {
    if (req.functionName === "getThreshold") return Promise.resolve(args.threshold);
    if (req.functionName === "getOwners") return Promise.resolve(args.owners);
    if (req.functionName === "approvedHashes") {
      const owner = (req.args?.[0] as string).toLowerCase();
      return Promise.resolve(args.approvalsByOwner[owner] ?? 0n);
    }
    return Promise.resolve(0n);
  });
}

beforeEach(() => {
  clearSafeTxStoreForTesting();
  mockClient.readContract.mockReset();
  mockKit.getTransaction.mockReset();
  rememberSafeTx({
    safeTxHash: safeTxHash(),
    chain: "ethereum",
    safeAddress: SAFE as `0x${string}`,
    body: buildSafeTxBody({
      to: RECIPIENT as `0x${string}`,
      value: "1000",
      data: "0x",
      operation: 0,
      nonce: "5",
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepare_safe_tx_execute — threshold gating", () => {
  it("refuses when fewer than `threshold` signers are ready", async () => {
    // Threshold 2, but only OWNER_A approved + executor is OWNER_B (an owner).
    // Eligible = {A, B} → 2 ≥ 2: actually meets! Use a tighter case.
    // Threshold 3, OWNER_A approved, executor OWNER_B → eligible = 2.
    setOnChainState({
      threshold: 3n,
      owners: [OWNER_A, OWNER_B, OWNER_C],
      approvalsByOwner: { [OWNER_A.toLowerCase()]: 1n },
    });
    await expect(
      prepareSafeTxExecute({
        executor: OWNER_B,
        safeAddress: SAFE,
        chain: "ethereum",
        safeTxHash: safeTxHash(),
      }),
    ).rejects.toThrow(/Threshold not met/);
  });

  it("does not count the executor when they're NOT an owner", async () => {
    // Threshold 2, OWNER_A approved, executor is a stranger → eligible = 1.
    setOnChainState({
      threshold: 2n,
      owners: [OWNER_A, OWNER_B, OWNER_C],
      approvalsByOwner: { [OWNER_A.toLowerCase()]: 1n },
    });
    await expect(
      prepareSafeTxExecute({
        executor: STRANGER,
        safeAddress: SAFE,
        chain: "ethereum",
        safeTxHash: safeTxHash(),
      }),
    ).rejects.toThrow(/Threshold not met/);
  });

  it("counts the executor when they ARE an owner", async () => {
    // Threshold 2, OWNER_A approved, executor is OWNER_B (an owner) → eligible = 2 OK.
    setOnChainState({
      threshold: 2n,
      owners: [OWNER_A, OWNER_B, OWNER_C],
      approvalsByOwner: { [OWNER_A.toLowerCase()]: 1n },
    });
    const tx = await prepareSafeTxExecute({
      executor: OWNER_B,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash(),
    });
    expect(tx.to.toLowerCase()).toBe(SAFE.toLowerCase());
    // execTransaction selector is 0x6a761202.
    expect(tx.data.slice(0, 10)).toBe("0x6a761202");
  });
});

describe("prepare_safe_tx_execute — signature ordering", () => {
  it("orders signatures by ascending signer address", async () => {
    // All three owners approved; threshold 3 → blob has 3*65 = 195 bytes.
    setOnChainState({
      threshold: 3n,
      owners: [OWNER_A, OWNER_B, OWNER_C],
      approvalsByOwner: {
        [OWNER_A.toLowerCase()]: 1n,
        [OWNER_B.toLowerCase()]: 1n,
        [OWNER_C.toLowerCase()]: 1n,
      },
    });
    const tx = await prepareSafeTxExecute({
      executor: OWNER_A,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash(),
    });

    // Find the signatures bytes in the calldata. The blob is at the tail of
    // execTransaction calldata (bytes is dynamic, so it sits after the offset
    // table). For our test we just check that the three signer addresses
    // appear in ascending order anywhere in the calldata.
    const lower = tx.data.toLowerCase();
    const idxB = lower.indexOf(OWNER_B.slice(2).toLowerCase());
    const idxC = lower.indexOf(OWNER_C.slice(2).toLowerCase());
    const idxA = lower.indexOf(OWNER_A.slice(2).toLowerCase());
    // OWNER_B (0x44…) < OWNER_C (0x77…) < OWNER_A (0x99…); the signatures
    // blob must list them in that order. (idxA may also match the executor
    // field earlier in the calldata; we only check that B and C exist with
    // B before C, then C before A.)
    expect(idxB).toBeGreaterThan(0);
    expect(idxC).toBeGreaterThan(idxB);
    expect(idxA).toBeGreaterThan(idxC);
  });
});

describe("prepare_safe_tx_execute — body resolution", () => {
  it("falls back to Safe Tx Service when the body isn't in the local cache", async () => {
    // Wipe the seeded store entry and force the SDK fallback.
    clearSafeTxStoreForTesting();
    mockKit.getTransaction.mockResolvedValueOnce({
      safeTxHash: safeTxHash(),
      to: RECIPIENT,
      value: "777",
      data: "0xabcdef",
      operation: 0,
      nonce: "9",
      confirmationsRequired: 1,
      confirmations: [{ owner: OWNER_A }],
      proposer: OWNER_A,
      submissionDate: "",
      transactionHash: null,
      executionDate: null,
      isExecuted: false,
    });
    setOnChainState({
      threshold: 1n,
      owners: [OWNER_A],
      approvalsByOwner: { [OWNER_A.toLowerCase()]: 1n },
    });
    const tx = await prepareSafeTxExecute({
      executor: OWNER_A,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash(),
    });
    expect(mockKit.getTransaction).toHaveBeenCalledOnce();
    // The recipient + the inner value should appear inside the encoded
    // execTransaction calldata.
    expect(tx.data.toLowerCase()).toContain(RECIPIENT.slice(2).toLowerCase());
  });
});
