import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress, parseEther } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import {
  buildTronVerification,
  buildVerification,
  payloadFingerprint,
  swissKnifeDecoderUrl,
  tronPayloadFingerprint,
} from "../src/signing/verification.js";
import { decodeCalldata } from "../src/signing/decode-calldata.js";
import {
  renderTronVerificationBlock,
  renderVerificationBlock,
  shouldRenderVerificationBlock,
} from "../src/signing/render-verification.js";
import { issueHandles } from "../src/signing/tx-store.js";
import { issueTronHandle } from "../src/signing/tron-tx-store.js";
import { CONTRACTS } from "../src/config/contracts.js";
import { CHAIN_IDS } from "../src/types/index.js";
import type { UnsignedTronTx, UnsignedTx } from "../src/types/index.js";

const USDC = getAddress(CONTRACTS.ethereum.tokens.USDC);
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const SENDER = getAddress("0x1111111111111111111111111111111111111111");

function usdcTransferTx(amount: bigint): UnsignedTx {
  return {
    chain: "ethereum",
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, amount] }),
    value: "0",
    from: SENDER,
    description: "Send USDC",
  };
}

describe("payloadFingerprint", () => {
  it("is deterministic over (chain, to, value, data)", () => {
    const tx = usdcTransferTx(1_000_000n);
    const a = payloadFingerprint(tx);
    const b = payloadFingerprint(tx);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when any field flips a single byte", () => {
    const tx = usdcTransferTx(1_000_000n);
    const base = payloadFingerprint(tx);
    expect(payloadFingerprint({ ...tx, value: "1" })).not.toBe(base);
    expect(payloadFingerprint({ ...tx, to: getAddress("0x0000000000000000000000000000000000000001") })).not.toBe(base);
    // Flip the amount arg.
    const mutated = usdcTransferTx(1_000_001n);
    expect(payloadFingerprint(mutated)).not.toBe(base);
  });

  it("is domain-separated between EVM and TRON", () => {
    const evm = payloadFingerprint(usdcTransferTx(1n));
    const tron = tronPayloadFingerprint("0x00");
    expect(evm).not.toBe(tron);
  });
});

describe("swissKnifeDecoderUrl", () => {
  it("produces ?calldata=&address=&chainId= — all three params", () => {
    const { decoderUrl, decoderPasteInstructions } = swissKnifeDecoderUrl(1, USDC, "0xa9059cbb0000");
    expect(decoderPasteInstructions).toBeUndefined();
    expect(decoderUrl).toBeDefined();
    expect(decoderUrl).toMatch(/^https:\/\/calldata\.swiss-knife\.xyz\/decoder\?/);
    expect(decoderUrl).toContain(`calldata=0xa9059cbb0000`);
    expect(decoderUrl).toContain(`address=${USDC}`);
    expect(decoderUrl).toContain(`chainId=1`);
  });

  it("falls back to paste-instructions when calldata is too large to fit", () => {
    // 7 000 bytes = 14 000 hex chars, comfortably past the 12 000-char URL budget.
    const bigCalldata = `0x${"aa".repeat(7000)}` as `0x${string}`;
    const out = swissKnifeDecoderUrl(1, USDC, bigCalldata);
    expect(out.decoderUrl).toBeUndefined();
    expect(out.decoderPasteInstructions).toBeDefined();
    expect(out.decoderPasteInstructions).toContain("calldata");
  });

  it("fits typical LiFi intra-chain swap calldata (~2 kB) into a preloaded URL", () => {
    // Regression: under the old 3 500-char budget, 2 kB calldata fell back
    // to paste-only. A 12 000-char budget comfortably covers it.
    const realisticLifiSwap = `0x${"bc".repeat(2200)}` as `0x${string}`;
    const out = swissKnifeDecoderUrl(1, USDC, realisticLifiSwap);
    expect(out.decoderUrl).toBeDefined();
    expect(out.decoderPasteInstructions).toBeUndefined();
  });
});

describe("buildVerification (EVM)", () => {
  it("always populates payloadHash, payloadHashShort, humanDecode, comparisonString", () => {
    const tx = usdcTransferTx(1_000_000n);
    const v = buildVerification(tx);
    expect(v.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.payloadHashShort).toMatch(/^[0-9a-f]{8}$/);
    expect(v.payloadHashShort).toBe(v.payloadHash.slice(2, 10));
    expect(v.decoderUrl).toBeDefined();
    expect(v.humanDecode.source).toBe("local-abi");
    expect(v.humanDecode.functionName).toBe("transfer");
    expect(v.humanDecode.signature).toBe("transfer(address,uint256)");
    expect(v.comparisonString).toBe(`${CHAIN_IDS.ethereum}:${USDC.toLowerCase()}:0:${tx.data}`);
  });

  it("renders valueHuman with decimals + symbol for known ERC-20 amount args", () => {
    const v = buildVerification(usdcTransferTx(1_000_000n));
    const amountArg = v.humanDecode.args.find((a) => a.name === "amount");
    expect(amountArg).toBeDefined();
    expect(amountArg?.valueHuman).toBe("1 USDC");
  });

  it("native-send (data = 0x) decodes as nativeTransfer with ETH formatting", () => {
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: RECIPIENT,
      data: "0x",
      value: parseEther("0.5").toString(),
      from: SENDER,
      description: "Send 0.5 ETH",
    };
    const v = buildVerification(tx);
    expect(v.humanDecode.source).toBe("native");
    expect(v.humanDecode.functionName).toBe("nativeTransfer");
    expect(v.humanDecode.args[0].valueHuman).toContain("ETH");
  });

  it("unknown destination returns source:none (no decode, user relies on swiss-knife)", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const v = buildVerification(tx);
    expect(v.humanDecode.source).toBe("none");
    expect(v.humanDecode.args).toEqual([]);
  });
});

describe("issueHandles stamps verification on every node of approve→action chains", () => {
  it("stamps both the approve and the action", () => {
    const action: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CONTRACTS.ethereum.aave.pool as `0x${string}`, 1_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to Aave",
      next: action,
    };
    const stamped = issueHandles(approve);
    expect(stamped.verification).toBeDefined();
    expect(stamped.next?.verification).toBeDefined();
    expect(stamped.verification!.payloadHash).not.toBe(stamped.next!.verification!.payloadHash);
  });
});

describe("issueTronHandle stamps verification on TRON tx", () => {
  const baseTron: UnsignedTronTx = {
    chain: "tron",
    action: "native_send",
    from: "TXYZabc000000000000000000000000000",
    txID: "a".repeat(64),
    rawData: {},
    rawDataHex: "0a02b63922080102030405060708",
    description: "send 1 TRX",
    decoded: { functionName: "transfer", args: { to: "Tabc", amount: "1 TRX" } },
  };

  it("produces a fingerprint and paste instructions (no swiss-knife URL on TRON)", () => {
    const stamped = issueTronHandle(baseTron);
    expect(stamped.verification).toBeDefined();
    expect(stamped.verification!.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stamped.verification!.decoderUrl).toBeUndefined();
    expect(stamped.verification!.decoderPasteInstructions).toBeDefined();
  });

  it("buildTronVerification hash is reproducible from rawDataHex alone", () => {
    const v = buildTronVerification(baseTron);
    expect(v.payloadHash).toBe(tronPayloadFingerprint(baseTron.rawDataHex));
  });
});

describe("renderVerificationBlock includes URL, hash, and the encouragement nudge", () => {
  it("EVM block contains all required elements", () => {
    const tx = usdcTransferTx(1_000_000n);
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toContain("VERIFY BEFORE SIGNING");
    expect(rendered).toContain(stamped.verification!.decoderUrl);
    expect(rendered).toContain(stamped.verification!.payloadHash);
    expect(rendered).toContain(stamped.verification!.payloadHashShort);
    expect(rendered).toContain("REJECT");
    expect(rendered).toContain("transfer(address,uint256)");
    // Short template: no more agent-facing preamble bleeding into user text.
    expect(rendered).not.toContain("SHOW THIS ENTIRE BLOCK TO THE USER VERBATIM");
    // Eight-ish lines, keeps the chat uncluttered.
    expect(rendered.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("TRON block tells the user there's no browser decoder URL and points at Tronscan", () => {
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TXYZ",
      txID: "b".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "send 5 USDT",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "5 USDT" } },
    });
    const rendered = renderTronVerificationBlock(
      stamped as UnsignedTronTx & { verification: NonNullable<UnsignedTronTx["verification"]> },
    );
    expect(rendered).toContain("TRON");
    expect(rendered).toContain("no browser decoder URL");
    expect(rendered).toContain("tronscan");
    expect(rendered).toContain(stamped.verification!.payloadHash);
    expect(rendered).not.toContain("SHOW THIS ENTIRE BLOCK TO THE USER VERBATIM");
  });
});

describe("shouldRenderVerificationBlock — approvals are suppressed (Ledger clear-signs them)", () => {
  it("returns false for ERC-20 approve(address,uint256) calldata", () => {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [RECIPIENT, 1_000_000n],
    });
    expect(shouldRenderVerificationBlock({ data: approveData })).toBe(false);
  });

  it("returns true for ERC-20 transfer (not approve)", () => {
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 1_000_000n],
    });
    expect(shouldRenderVerificationBlock({ data: transferData })).toBe(true);
  });

  it("is case-insensitive on the selector", () => {
    expect(shouldRenderVerificationBlock({ data: "0x095EA7B3deadbeef" as `0x${string}` })).toBe(false);
  });
});

describe("decodeCalldata", () => {
  it("extracts a checksummed `to` arg on ERC-20 transfer", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 123n],
    });
    const d = decodeCalldata("ethereum", USDC, data, "0");
    const toArg = d.args.find((a) => a.name === "to");
    expect(toArg?.value).toBe(RECIPIENT);
  });
});
