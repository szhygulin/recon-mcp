import { describe, it, expect } from "vitest";
import { hashTypedData, getAddress } from "viem";
import {
  buildSafeTxBody,
  computeSafeTxHash,
  encodeApprovedHashSignature,
  signerWord,
  SAFE_OP_CALL,
  SAFE_OP_DELEGATECALL,
} from "../src/modules/safe/safe-tx.js";

describe("SafeTx hashing", () => {
  it("matches viem hashTypedData with the v1.3+ Safe EIP-712 schema", () => {
    // A trivial transfer tx — easy to reproduce by hand if the test ever flips.
    const body = buildSafeTxBody({
      to: "0x0000000000000000000000000000000000000abc",
      value: "1000000000000000000", // 1 ETH
      data: "0x",
      operation: SAFE_OP_CALL,
      nonce: "5",
    });
    const safeAddress = "0x1111111111111111111111111111111111111111" as const;
    const ours = computeSafeTxHash({ chain: "ethereum", safeAddress, body });

    // Reference: re-derive via viem directly with the canonical Safe v1.3+
    // typed-data structure (chainId + verifyingContract domain only).
    const reference = hashTypedData({
      domain: { chainId: 1, verifyingContract: safeAddress },
      types: {
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      message: {
        to: body.to,
        value: BigInt(body.value),
        data: body.data,
        operation: body.operation,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        nonce: 5n,
      },
    });
    expect(ours).toBe(reference);
  });

  it("changes when chainId changes — domain separator carries chainId", () => {
    const body = buildSafeTxBody({
      to: "0x0000000000000000000000000000000000000abc",
      value: "0",
      data: "0x",
      operation: SAFE_OP_CALL,
      nonce: "0",
    });
    const safeAddress = "0x1111111111111111111111111111111111111111" as const;
    const eth = computeSafeTxHash({ chain: "ethereum", safeAddress, body });
    const arb = computeSafeTxHash({ chain: "arbitrum", safeAddress, body });
    expect(eth).not.toBe(arb);
  });

  it("changes when operation flips from CALL to DELEGATECALL", () => {
    const safeAddress = "0x1111111111111111111111111111111111111111" as const;
    const call = computeSafeTxHash({
      chain: "ethereum",
      safeAddress,
      body: buildSafeTxBody({
        to: "0x0000000000000000000000000000000000000abc",
        value: "0",
        data: "0x",
        operation: SAFE_OP_CALL,
        nonce: "0",
      }),
    });
    const delegate = computeSafeTxHash({
      chain: "ethereum",
      safeAddress,
      body: buildSafeTxBody({
        to: "0x0000000000000000000000000000000000000abc",
        value: "0",
        data: "0x",
        operation: SAFE_OP_DELEGATECALL,
        nonce: "0",
      }),
    });
    expect(call).not.toBe(delegate);
  });
});

describe("approved-hash signature encoding", () => {
  it("packs (signer-as-r, 0-as-s, v=1) into 65 bytes", () => {
    const signer = getAddress("0x742d35cc6634c0532925a3b844bc9e7595f8b8b8");
    const sig = encodeApprovedHashSignature(signer);

    // 65 bytes = 130 hex chars + "0x".
    expect(sig.length).toBe(132);
    // r = signer left-padded to 32 bytes
    expect(sig.slice(0, 66)).toBe(signerWord(signer));
    // s = 32 zero bytes
    expect(sig.slice(66, 130)).toBe("0".repeat(64));
    // v = 1
    expect(sig.slice(130)).toBe("01");
  });

  it("preserves the case-canonicalized signer in the r slot", () => {
    const signer = getAddress("0x742d35cc6634c0532925a3b844bc9e7595f8b8b8");
    const sig = encodeApprovedHashSignature(signer);
    expect(sig.toLowerCase()).toContain(signer.toLowerCase().slice(2));
  });
});
