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
  ambiguousNonceDisagreementMessage,
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

describe("probeForLateBroadcast — issue #326 multi-source nonce cross-check", () => {
  it("when local says no_broadcast AND etherscan agrees → no_broadcast (with cross-check value surfaced)", async () => {
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
      etherscanPendingNonceProbe: async () => SAMPLE_TX_FIELDS.nonce,
    });
    expect(result.status).toBe("no_broadcast");
    if (result.status === "no_broadcast") {
      expect(result.pendingNonce).toBe(SAMPLE_TX_FIELDS.nonce);
      expect(result.etherscanPendingNonce).toBe(SAMPLE_TX_FIELDS.nonce);
    }
  });

  it("when local says no_broadcast BUT etherscan reports pending > pinned → ambiguous_nonce_disagreement", async () => {
    // Canonical issue #326 scenario: Ledger Live broadcast through its
    // own RPC, Etherscan's mempool indexer saw it, our local node
    // hasn't caught up yet. Retrying queues the duplicate-prompt.
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce,
      getBlockNumber: async () => {
        throw new Error("must not be called on disagreement (no walk needed)");
      },
      getBlock: async () => {
        throw new Error("must not be called on disagreement");
      },
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
      etherscanPendingNonceProbe: async () => SAMPLE_TX_FIELDS.nonce + 1,
    });
    expect(result.status).toBe("ambiguous_nonce_disagreement");
    if (result.status === "ambiguous_nonce_disagreement") {
      expect(result.localPendingNonce).toBe(SAMPLE_TX_FIELDS.nonce);
      expect(result.etherscanPendingNonce).toBe(SAMPLE_TX_FIELDS.nonce + 1);
    }
  });

  it("when local says no_broadcast and etherscan probe THROWS → falls back to no_broadcast (no regression for users without API key)", async () => {
    // Defense in depth — a failed cross-check (no API key, rate limit,
    // network blip) must not turn a benign no_broadcast into a scary
    // ambiguous error. Users without an Etherscan key get the
    // pre-issue-326 single-source behavior unchanged.
    const client = {
      getTransactionCount: async () => SAMPLE_TX_FIELDS.nonce,
      getBlockNumber: async () => {
        throw new Error("must not be called");
      },
      getBlock: async () => {
        throw new Error("must not be called");
      },
    };
    const result = await probeForLateBroadcast({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      from: FROM,
      pinnedNonce: SAMPLE_TX_FIELDS.nonce,
      expectedPreSignHash: preSignHashOf(SAMPLE_TX_FIELDS),
      chainId: CHAIN_ID,
      etherscanPendingNonceProbe: async () => {
        throw new Error("ETHERSCAN_API_KEY is not set");
      },
    });
    expect(result.status).toBe("no_broadcast");
    if (result.status === "no_broadcast") {
      expect(result.pendingNonce).toBe(SAMPLE_TX_FIELDS.nonce);
      expect(result.etherscanPendingNonce).toBeUndefined();
    }
  });

  it("when local says pending > pinned, the etherscan probe is NOT called (slot already consumed locally)", async () => {
    // Optimization regression guard: when the local RPC already saw
    // the slot consumed, the cross-check has no value — we proceed
    // straight to the matched/consumed_unmatched walk.
    const expectedHash = ("0xcee2a965b8e35a85dbce7b7389bc5ea2ffb1846c8abdaea676ee709d9d0f0165" as const);
    const tx = eip1559TxOnBlock(SAMPLE_TX_FIELDS, { hash: expectedHash });
    let etherscanCalls = 0;
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
      etherscanPendingNonceProbe: async () => {
        etherscanCalls++;
        return SAMPLE_TX_FIELDS.nonce + 1;
      },
    });
    expect(result.status).toBe("matched");
    expect(etherscanCalls).toBe(0);
  });
});

describe("noBroadcastConfirmedMessage — wording lock", () => {
  it("tells the agent it's safe to retry the same handle (issue #232 baseline)", async () => {
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
    expect(msg).toContain("Issue");
  });

  it("issue #326: includes the duplicate-prompt warning the agent must relay to the user on retry", async () => {
    // Even when retry IS safe (per the cross-check), the user should
    // know that if the WC subapp had silently completed signing in
    // the background, retrying CAN still queue a duplicate prompt.
    // Reject the duplicate; original tx lands normally.
    const msg = noBroadcastConfirmedMessage({
      from: FROM,
      pinnedNonce: 273,
      chainId: 1,
      timeoutSeconds: 120,
    });
    expect(msg).toMatch(/REJECT the duplicate prompt/i);
    expect(msg).toMatch(/original tx will land normally/i);
    expect(msg).toContain("#326");
  });

  it("when etherscan cross-check ran and agreed, surfaces the second-source value", async () => {
    const msg = noBroadcastConfirmedMessage({
      from: FROM,
      pinnedNonce: 273,
      chainId: 1,
      timeoutSeconds: 120,
      etherscanPendingNonce: 273,
    });
    expect(msg).toMatch(/Etherscan/);
    expect(msg).toMatch(/two sources agree/i);
  });
});

describe("ambiguousNonceDisagreementMessage — issue #326 wording lock", () => {
  it("tells the agent NOT to retry and explains the duplicate-prompt risk", async () => {
    const msg = ambiguousNonceDisagreementMessage({
      from: FROM,
      pinnedNonce: 278,
      localPendingNonce: 278,
      etherscanPendingNonce: 279,
      chainId: 1,
      timeoutSeconds: 120,
    });
    expect(msg).toMatch(/DO NOT retry/i);
    expect(msg).toMatch(/duplicate signing prompt/i);
    expect(msg).toMatch(/key-leak attack pattern/i);
    expect(msg).toContain("278");
    expect(msg).toContain("279");
    expect(msg).toContain(FROM);
    expect(msg).toContain("#326");
    // The recovery guidance — block-explorer check + "if no tx with the
    // pinned nonce, it's safe to re-prepare from scratch" — gives the
    // user a concrete way out instead of leaving them stuck.
    expect(msg).toMatch(/block explorer/i);
    expect(msg).toMatch(/re-prepare/i);
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
