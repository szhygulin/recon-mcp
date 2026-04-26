/**
 * Issue #232 — proactive late-broadcast detection on WalletConnect
 * timeout. Unit tests for `probeForLateBroadcast` and the two new
 * timeout-path message helpers.
 *
 * Scope: the probe helper itself (chain probe + recent-block walk).
 * Exercising the full `requestSendTransaction` timeout integration
 * needs a stubbed SignClient + session state and is intentionally NOT
 * covered here; the wording and message helpers below pin the
 * agent-facing contract that the integration relies on.
 */
import { describe, it, expect } from "vitest";
import { keccak256, serializeTransaction } from "viem";
import {
  probeForLateBroadcast,
  consumedUnmatchedMessage,
  noBroadcastConfirmedMessage,
} from "../src/signing/walletconnect.js";

const FROM = "0x1111111111111111111111111111111111111111" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;

interface PinnedFields {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

const SAMPLE_TX_FIELDS: PinnedFields = {
  nonce: 273,
  maxFeePerGas: 50_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  gas: 100_000n,
  to: RECIPIENT,
  value: 0n,
  data: "0x" as `0x${string}`,
};

const CHAIN_ID = 1;

/** Compute the EIP-1559 pre-sign hash exactly the way the server pins it. */
function preSignHashOf(fields: PinnedFields): `0x${string}` {
  return keccak256(
    serializeTransaction({
      type: "eip1559",
      chainId: CHAIN_ID,
      nonce: fields.nonce,
      maxFeePerGas: fields.maxFeePerGas,
      maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
      gas: fields.gas,
      to: fields.to,
      value: fields.value,
      data: fields.data,
    }),
  );
}

/**
 * Build a viem-shaped EIP-1559 tx object as it would appear inside
 * `client.getBlock({ includeTransactions: true })`. Adds the on-chain
 * fields the probe doesn't read (hash, blockHash, gasPrice, etc.) so
 * the type pins are realistic.
 */
function eip1559TxOnBlock(
  fields: PinnedFields,
  opts: { from?: `0x${string}`; hash?: `0x${string}` } = {},
) {
  return {
    type: "eip1559" as const,
    hash: opts.hash ?? ("0xabc" + "0".repeat(61)) as `0x${string}`,
    from: opts.from ?? FROM,
    to: fields.to,
    nonce: fields.nonce,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    gas: fields.gas,
    value: fields.value,
    input: fields.data,
    blockHash: ("0x" + "1".repeat(64)) as `0x${string}`,
    blockNumber: 24_961_478n,
    transactionIndex: 0,
    chainId: CHAIN_ID,
    accessList: [],
  };
}

describe("probeForLateBroadcast", () => {
  it("returns no_broadcast when pending nonce equals the pinned nonce (nothing landed)", async () => {
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce,
      getBlockNumber: async () => {
        throw new Error("must not be called when pending=pinned");
      },
      getBlock: async () => {
        throw new Error("must not be called when pending=pinned");
      },
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
    });
    expect(result.status).toBe("no_broadcast");
    if (result.status === "no_broadcast") {
      expect(result.pendingNonce).toBe(SAMPLE_TX_FIELDS.nonce);
    }
  });

  it("returns matched + the on-chain hash when the recent-block walk finds the pinned tx", async () => {
    const expectedHash = ("0xcee2a965b8e35a85dbce7b7389bc5ea2ffb1846c8abdaea676ee709d9d0f0165" as const);
    const tx = eip1559TxOnBlock(SAMPLE_TX_FIELDS, { hash: expectedHash });
    const client = {
      // pendingNonce > pinned → slot consumed, walk required
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce + 1,
      getBlockNumber: async () => 24_961_480n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        // Put the matching tx in the latest block; lower blocks are empty.
        if (blockNumber === 24_961_480n) {
          return { number: blockNumber, transactions: [tx] };
        }
        return { number: blockNumber, transactions: [] };
      },
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
    });
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.txHash).toBe(expectedHash);
    }
  });

  it("returns consumed_unmatched when the slot is taken but no tx in the window matches the pre-sign hash", async () => {
    // A different tx with the SAME (from, nonce) but DIFFERENT bytes —
    // e.g. an RBF replacement, or a parallel-tooling submission. The
    // pre-sign hash must NOT match.
    const otherFields: PinnedFields = {
      ...SAMPLE_TX_FIELDS,
      // Different gas → different RLP → different pre-sign hash
      gas: 200_000n,
    };
    const tx = eip1559TxOnBlock(otherFields, { hash: "0xdead000000000000000000000000000000000000000000000000000000000001" });
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce + 1,
      getBlockNumber: async () => 24_961_480n,
      getBlock: async () => ({ number: 24_961_480n, transactions: [tx] }),
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
      blockWindow: 4,
    });
    expect(result.status).toBe("consumed_unmatched");
    if (result.status === "consumed_unmatched") {
      expect(result.pendingNonce).toBe(SAMPLE_TX_FIELDS.nonce + 1);
    }
  });

  it("ignores txs that match nonce but are from a different sender", async () => {
    // Sanity: `from` filter is applied. Same nonce + same hash bytes
    // wouldn't really exist with a different `from` (RLP encodes the
    // signer indirectly via signature recovery), but the filter must
    // run BEFORE the hash compute either way.
    const otherSender = "0x9999999999999999999999999999999999999999" as const;
    const tx = eip1559TxOnBlock(SAMPLE_TX_FIELDS, { from: otherSender });
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce + 1,
      getBlockNumber: async () => 24_961_480n,
      getBlock: async () => ({ number: 24_961_480n, transactions: [tx] }),
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
      blockWindow: 4,
    });
    expect(result.status).toBe("consumed_unmatched");
  });

  it("survives a per-block getBlock failure and continues walking", async () => {
    // A flaky block fetch in the middle of the window must not abort
    // the probe — it should skip the block and keep walking.
    const tx = eip1559TxOnBlock(SAMPLE_TX_FIELDS);
    const expectedHash = tx.hash;
    let callCount = 0;
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce + 1,
      getBlockNumber: async () => 24_961_482n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        callCount++;
        // First two block fetches throw; third returns the matching tx.
        if (callCount <= 2) throw new Error("rpc-temporarily-unavailable");
        if (blockNumber === 24_961_480n) {
          return { number: blockNumber, transactions: [tx] };
        }
        return { number: blockNumber, transactions: [] };
      },
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
      blockWindow: 8,
    });
    expect(result.status).toBe("matched");
    if (result.status === "matched") expect(result.txHash).toBe(expectedHash);
  });
});

describe("noBroadcastConfirmedMessage — issue #232 wording lock", () => {
  it("tells the agent it's safe to retry the same handle", async () => {
    const msg = noBroadcastConfirmedMessage({
      from: FROM,
      pinnedNonce: 273,
      chainId: 1,
      timeoutSeconds: 120,
    });
    expect(msg).toContain("did not complete within 120s");
    expect(msg).toContain("Safe to retry");
    expect(msg).toContain("SAME handle");
    expect(msg).toContain(FROM);
    expect(msg).toContain("273");
    expect(msg).toContain("Issue #232");
  });
});

describe("consumedUnmatchedMessage — issue #232 wording lock", () => {
  it("tells the agent NOT to retry and points at a block explorer", async () => {
    const msg = consumedUnmatchedMessage({
      from: FROM,
      pinnedNonce: 273,
      pendingNonce: 274,
      chainId: 1,
      probeWindowBlocks: 16,
    });
    expect(msg).toContain("DO NOT retry");
    expect(msg).toContain("nonce is consumed");
    expect(msg).toContain("block explorer");
    expect(msg).toContain("pending=274");
    expect(msg).toContain("pinned=273");
    expect(msg).toContain("16 blocks");
    expect(msg).toContain("Issue #232");
  });
});
