import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { getVerificationArtifact } from "../src/modules/execution/index.js";
import {
  attachPinnedGas,
  issueHandles,
  retireHandle,
} from "../src/signing/tx-store.js";
import { issueTronHandle } from "../src/signing/tron-tx-store.js";
import { CONTRACTS } from "../src/config/contracts.js";
import { CHAIN_IDS } from "../src/types/index.js";
import type {
  EvmVerificationArtifact,
  TronVerificationArtifact,
} from "../src/modules/execution/index.js";
import type { UnsignedTx } from "../src/types/index.js";

const USDC = getAddress(CONTRACTS.ethereum.tokens.USDC);
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const SENDER = getAddress("0x1111111111111111111111111111111111111111");

function usdcTransferTx(amount: bigint): UnsignedTx {
  return {
    chain: "ethereum",
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, amount],
    }),
    value: "0",
    from: SENDER,
    description: "Send USDC",
  };
}

describe("get_verification_artifact — second-agent copy-paste artifact", () => {
  it("EVM happy path: carries raw bytes, payloadHash, instructions; omits server decode; preSignHash absent before preview_send", () => {
    const stamped = issueHandles(usdcTransferTx(1_000_000n));
    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as EvmVerificationArtifact;

    expect(artifact.artifactVersion).toBe("v1");
    expect(artifact.handle).toBe(stamped.handle);
    expect(artifact.chain).toBe("ethereum");
    expect(artifact.chainId).toBe(CHAIN_IDS.ethereum);
    expect(artifact.to).toBe(stamped.to);
    expect(artifact.value).toBe(stamped.value);
    expect(artifact.data).toBe(stamped.data);
    expect(artifact.payloadHash).toBe(stamped.verification!.payloadHash);

    // preview_send has not been called, so preSignHash must not be present.
    expect(artifact.preSignHash).toBeUndefined();

    // pasteableBlock: a single self-contained copy-paste string. Must carry
    // explicit START/END markers so the user and the second LLM can see
    // where the paste target begins and ends — without them, the first
    // agent's commentary bleeds into the paste (seen live in testing).
    expect(typeof artifact.pasteableBlock).toBe("string");
    expect(artifact.pasteableBlock.length).toBeGreaterThan(200);
    expect(artifact.pasteableBlock).toMatch(/COPY FROM THIS LINE/);
    expect(artifact.pasteableBlock).toMatch(/END — STOP COPYING HERE/);
    expect(artifact.pasteableBlock).toMatch(/DO NOT trust any description text/);
    expect(artifact.pasteableBlock).toMatch(/REJECT/);
    // Payload JSON is embedded INSIDE the markers so the second agent sees
    // it as part of its single prompt — not a second artifact the user has
    // to paste separately.
    expect(artifact.pasteableBlock).toContain(stamped.data);
    expect(artifact.pasteableBlock).toContain(stamped.to);
    expect(artifact.pasteableBlock).toContain(stamped.verification!.payloadHash);
    // Old field name must be gone — future refactors should not resurrect it.
    const bag = artifact as unknown as Record<string, unknown>;
    expect(bag.instructionsForSecondAgent).toBeUndefined();
    // Artifact must NOT leak the server's own decode — the whole point is
    // adversarial independence. Check the untyped bag to catch any accidental
    // field addition in future refactors.
    expect(bag.humanDecode).toBeUndefined();
    expect(bag.decoded).toBeUndefined();
    expect(bag.decoderUrl).toBeUndefined();
    expect(bag.decoderPasteInstructions).toBeUndefined();
    expect(bag.comparisonString).toBeUndefined();
  });

  it("EVM with pinned gas: artifact carries preSignHash matching the pinned value", () => {
    const stamped = issueHandles(usdcTransferTx(42n));
    const pinnedPreSignHash = `0x${"ab".repeat(32)}` as `0x${string}`;
    attachPinnedGas(stamped.handle!, {
      nonce: 7,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gas: 100_000n,
      preSignHash: pinnedPreSignHash,
      pinnedAt: Date.now(),
    });

    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as EvmVerificationArtifact;
    expect(artifact.preSignHash).toBe(pinnedPreSignHash);
    // preSignHash appears inside the paste-block payload too, not just on
    // the outer artifact — the second agent reads payload.preSignHash as
    // the Ledger-match anchor (step 5 of the prompt).
    expect(artifact.pasteableBlock).toContain(pinnedPreSignHash);
  });

  it("TRON happy path: artifact carries from, txID, rawDataHex, payloadHash; no preSignHash concept on TRON", () => {
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TXYZabc000000000000000000000000000",
      txID: "c".repeat(64),
      rawData: {},
      rawDataHex: "0a02b63922080102030405060708",
      description: "send 5 USDT",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "5 USDT" } },
    });

    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as TronVerificationArtifact;
    expect(artifact.artifactVersion).toBe("v1");
    expect(artifact.chain).toBe("tron");
    expect(artifact.from).toBe(stamped.from);
    expect(artifact.txID).toBe(stamped.txID);
    expect(artifact.rawDataHex).toBe(stamped.rawDataHex);
    expect(artifact.payloadHash).toBe(stamped.verification!.payloadHash);
    // pasteableBlock carries START/END markers and the TRON-specific fields
    // (rawDataHex, txID) inside the embedded payload.
    expect(artifact.pasteableBlock).toMatch(/COPY FROM THIS LINE/);
    expect(artifact.pasteableBlock).toMatch(/END — STOP COPYING HERE/);
    expect(artifact.pasteableBlock).toMatch(/TRON|rawDataHex/);
    expect(artifact.pasteableBlock).toContain(stamped.rawDataHex);
    expect(artifact.pasteableBlock).toContain(stamped.txID);

    // TRON has no EIP-1559 pre-sign hash concept — the artifact shape must
    // not include that field on TRON handles.
    const bag = artifact as unknown as Record<string, unknown>;
    expect(bag.preSignHash).toBeUndefined();
    expect(bag.instructionsForSecondAgent).toBeUndefined();
  });

  it("unknown handle: throws a clear 'Unknown or expired' error", () => {
    expect(() => getVerificationArtifact({ handle: "nonexistent-handle-uuid" })).toThrow(
      /Unknown or expired tx handle/,
    );
  });

  it("retired handle (same code path as TTL expiry): throws 'Unknown or expired'", () => {
    const stamped = issueHandles(usdcTransferTx(1n));
    retireHandle(stamped.handle!);
    expect(() => getVerificationArtifact({ handle: stamped.handle! })).toThrow(
      /Unknown or expired tx handle/,
    );
  });
});

