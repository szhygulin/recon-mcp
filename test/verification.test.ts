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
import { collectVerificationBlocks } from "../src/index.js";
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

describe("collectVerificationBlocks — approve→action chain only renders the action block", () => {
  it("skips the ERC-20 approve node and renders the swap node only", () => {
    const swap: UnsignedTx = {
      chain: "ethereum",
      to: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), // LiFi Diamond
      data: "0x2c57e88400000000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "LiFi swap",
    };
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
      next: swap,
    };
    const stamped = issueHandles(approve);
    const blocks = collectVerificationBlocks(stamped);
    // One verification block + one agent-task directive block for the swap.
    // The approve node is suppressed entirely (both blocks).
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[0]).not.toContain("approve(address,uint256)");
    expect(blocks[0]).toContain("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
    expect(blocks[1]).toContain("[AGENT TASK");
    expect(blocks[1]).toContain("4byte.directory");
    expect(blocks[1]).toContain("0x2c57e884");
  });

  it("renders the single tx with its verification block + agent task block", () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const blocks = collectVerificationBlocks(stamped);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[1]).toContain("[AGENT TASK");
    expect(blocks[1]).toContain("0x617ba037");
  });

  it("suppresses the agent task block for ERC-20 approves (verification block also suppressed)", () => {
    const approveOnly: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
    };
    const stamped = issueHandles(approveOnly);
    const blocks = collectVerificationBlocks(stamped);
    expect(blocks).toHaveLength(0);
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
    // Markdown-linkified so large URLs don't visually bloat chat; raw URL still
    // present inside the parens for clients that don't render markdown.
    expect(rendered).toContain(`[open in swiss-knife](${stamped.verification!.decoderUrl})`);
    expect(rendered).toContain(stamped.verification!.payloadHash);
    expect(rendered).toContain(stamped.verification!.payloadHashShort);
    expect(rendered).toContain("REJECT");
    expect(rendered).toContain("transfer(address,uint256)");
    expect(rendered).not.toContain("SHOW THIS ENTIRE BLOCK TO THE USER VERBATIM");
    expect(rendered.split("\n").length).toBeLessThanOrEqual(10);
    // When local decode succeeds, the calldata's *content* is shown via Args:
    // re-printing a hex preview duplicates the same information and crowds the
    // chat. Show only byte length as sizing context.
    expect(rendered).toContain("calldata bytes)");
    // Negative lookbehind to ignore the URL's `?calldata=0x...` param — only
    // the standalone `data=0x...` on the chainId line should be absent.
    expect(rendered).not.toMatch(/(?<!call)data=0x[0-9a-f]/i);
  });

  it("includes a hex preview when source: 'none' (no local decode = user has no other local signal)", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: ("0x2c57e884" + "ab".repeat(120)) as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toMatch(/data=0x2c57e884/);
    expect(rendered).toMatch(/\(\d+ bytes\)/);
  });

  it("unknown-destination block tells the user swiss-knife is the decode source, not '(unknown)'", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: "0x2c57e88400000000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toContain("decoded by swiss-knife only");
    // We no longer emit the literal scary word "unknown" in the Call line.
    expect(rendered).not.toMatch(/Call:\s+unknown/);
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

describe("decodeCalldata — LiFi Diamond", () => {
  const LIFI_DIAMOND = getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");

  it("decodes swapTokensMultipleV3ERC20ToNative (selector 0x2c57e884)", () => {
    // Round-trip: encode a call, then pass the bytes through the decoder and
    // assert we get the function name + a non-empty args list back. Locks in
    // the 0x2c57e884 selector that previously rendered "Call: unknown".
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "swapTokensMultipleV3ERC20ToNative",
          stateMutability: "payable",
          inputs: [
            { name: "_transactionId", type: "bytes32" },
            { name: "_integrator", type: "string" },
            { name: "_referrer", type: "string" },
            { name: "_receiver", type: "address" },
            { name: "_minAmountOut", type: "uint256" },
            {
              name: "_swapData",
              type: "tuple[]",
              components: [
                { name: "callTo", type: "address" },
                { name: "approveTo", type: "address" },
                { name: "sendingAssetId", type: "address" },
                { name: "receivingAssetId", type: "address" },
                { name: "fromAmount", type: "uint256" },
                { name: "callData", type: "bytes" },
                { name: "requiresDeposit", type: "bool" },
              ],
            },
          ],
          outputs: [],
        },
      ],
      functionName: "swapTokensMultipleV3ERC20ToNative",
      args: [
        `0x${"00".repeat(32)}` as `0x${string}`,
        "vaultpilot-mcp",
        "",
        SENDER,
        42_000_000_000_000_000n,
        [],
      ],
    });
    expect(data.slice(0, 10)).toBe("0x2c57e884");
    const d = decodeCalldata("ethereum", LIFI_DIAMOND, data, "0");
    expect(d.source).toBe("local-abi");
    expect(d.functionName).toBe("swapTokensMultipleV3ERC20ToNative");
    expect(d.signature).toContain("swapTokensMultipleV3ERC20ToNative(");
    expect(d.args.find((a) => a.name === "_receiver")?.value).toBe(SENDER);
  });

  it("unknown LiFi selector on the same address falls through to source:none", () => {
    // Not a real LiFi function — ensures un-whitelisted selectors gracefully
    // fall back to the swiss-knife-only path rather than misdecoding.
    const d = decodeCalldata("ethereum", LIFI_DIAMOND, "0xdeadbeef00000000" as `0x${string}`, "0");
    expect(d.source).toBe("none");
    expect(d.functionName).toBe("unknown");
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

describe("get_tx_verification recovers a verification block by handle", () => {
  it("EVM handle round-trips through the same JSON + rendered block", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(usdcTransferTx(1_000_000n));
    const handle = stamped.handle!;

    const recovered = getTxVerification({ handle }) as UnsignedTx;
    // The store strips the root handle to avoid storing the key in the value;
    // the rest of the tx (and its verification) is the same instance.
    expect(recovered.to).toBe(stamped.to);
    expect(recovered.data).toBe(stamped.data);
    expect(recovered.value).toBe(stamped.value);
    expect(recovered.verification?.payloadHash).toBe(stamped.verification?.payloadHash);

    // The handler() wrapper renders the verification block from the result —
    // proving that get_tx_verification slots into the same render path as prepare_*.
    const blocks = collectVerificationBlocks(recovered);
    // verification block + agent task block (EVM non-approve tx)
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[0]).toContain(stamped.verification!.payloadHash);
    expect(blocks[1]).toContain("[AGENT TASK");
  });

  it("TRON handle returns the TRON-rendered block (separate code path)", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TXYZ",
      txID: "c".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "send 5 USDT",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "5 USDT" } },
    });
    const handle = stamped.handle!;

    const recovered = getTxVerification({ handle }) as UnsignedTronTx;
    expect(recovered.txID).toBe(stamped.txID);
    expect(recovered.verification?.payloadHash).toBe(stamped.verification?.payloadHash);

    const blocks = collectVerificationBlocks(recovered);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING (TRON)");
  });

  it("unknown handle throws with a single clear 'expired or unknown' message", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    expect(() => getTxVerification({ handle: "nonexistent-handle-uuid" })).toThrow(
      /Unknown or expired tx handle/
    );
  });
});
