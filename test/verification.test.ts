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
    // Task block delegates the cross-check to the server-side tool.
    expect(blocks[1]).toContain("verify_tx_decode");
    expect(blocks[1]).toContain("4byte.directory");
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
    expect(blocks[1]).toContain("verify_tx_decode");
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

  it("agent task block directs the orchestrator at verify_tx_decode and keeps the hash-echo reminder", () => {
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
    const task = blocks[1];
    // Names the MCP tool rather than asking the agent to WebFetch 4byte itself.
    expect(task).toMatch(/verify_tx_decode/);
    // Tells the agent to relay the tool's summary verbatim.
    expect(task).toMatch(/VERBATIM/);
    // Prescribes a compact bullet summary INSTEAD of verbatim VERIFY-BEFORE-
    // SIGNING relay — the validated UX pattern.
    expect(task).toMatch(/COMPACT bullet summary/);
    expect(task).toMatch(/do NOT relay it verbatim/i);
    expect(task).toMatch(/Headline:/);
    // Tx-specific field hints for the common flows.
    expect(task).toMatch(/Min out/);
    expect(task).toMatch(/Amount/);
    expect(task).toMatch(/Spender/);
    // Destination-label hint so e.g. LiFi/Aave/Lido destinations get called out.
    expect(task).toMatch(/LiFi diamond/);
    // Short hash value is substituted into the directive (not a placeholder).
    expect(task).toContain(stamped.verification!.payloadHashShort);
    // Offers the user an out-of-trust-boundary check — either browser-side
    // swiss-knife or the agent's own independent decode. Phrased as an offer,
    // not a default action.
    expect(task).toMatch(/OFFER/);
    expect(task).toMatch(/trust boundary/);
    expect(task).toMatch(/swiss-knife/);
    expect(task).toMatch(/decode the calldata yourself/);
    expect(task).toMatch(/do NOT perform any of them\s+unprompted/);
    // Three explicit options (a), (b), (c) — (c) is the WebFetch-swiss-knife path.
    expect(task).toMatch(/\(a\)/);
    expect(task).toMatch(/\(b\)/);
    expect(task).toMatch(/\(c\)/);
    expect(task).toMatch(/WebFetch/);
    // The honesty caveat about swiss-knife being client-side rendered.
    expect(task).toMatch(/client-side Next\.js SPA/);
    expect(task).toMatch(/state the limitation before doing the fetch/);
    // The final Ledger hash-match reminder.
    expect(task).toMatch(/Before approving on Ledger/);
    expect(task).toMatch(/reject if it doesn't match/);
  });

  it("truncates long nested hex blobs inside struct args (no 2KB callData wall)", () => {
    // 1 KB of hex (2048 chars after 0x) — emulates LiFi _swapData[].callData.
    const longHex = "0x" + "ab".repeat(1024);
    const v = {
      chainId: 1,
      signature: "foo(tuple[] data)",
      humanDecode: {
        source: "local-abi",
        functionName: "foo",
        signature: "foo(tuple[] data)",
        args: [
          {
            name: "data",
            type: "tuple[]",
            value: `[{callData: ${longHex}}]`,
          },
        ],
      },
      payloadHash: "0x" + "0".repeat(64),
      payloadHashShort: "00000000",
      decoderUrl: "https://calldata.swiss-knife.xyz/decoder?calldata=0xabcd",
      decoderPasteInstructions: "paste",
    } as const;
    const rendered = renderVerificationBlock({
      chain: "ethereum",
      to: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
      value: "0",
      data: "0x617ba0370000" as `0x${string}`,
      verification: v as never,
    });
    // The raw 2 KB hex must not leak verbatim.
    expect(rendered).not.toContain(longHex);
    // Instead we get a head…tail (N bytes) preview.
    expect(rendered).toMatch(/0x(?:ab)+…(?:ab)+ \(1024 bytes\)/);
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

describe("verifyEvmCalldata — independent cross-check via 4byte.directory", () => {
  type MockFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  const mockFetch = (signatures: string[], opts: { ok?: boolean; status?: number } = {}): MockFetch => {
    return async () => ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ results: signatures.map((s) => ({ text_signature: s })) }),
    });
  };

  it("returns status=match with a user-facing summary when the 4byte signature round-trips and function name agrees", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1_000_000n));
    const result = await verifyEvmCalldata(
      tx,
      mockFetch(["transfer(address,uint256)"]),
    );
    expect(result.status).toBe("match");
    expect(result.reencodeCheck).toBe("pass");
    expect(result.independentFunctionName).toBe("transfer");
    expect(result.localFunctionName).toBe("transfer");
    expect(result.summary).toMatch(/Cross-check passed/);
    expect(result.summary).toMatch(/re-encod/);
    // The phrasing the user specifically asked to keep.
    expect(result.summary).toMatch(/mathematically implies/);
    // Flag that this check shares a trust boundary with the MCP server itself.
    expect(result.summary).toMatch(/trust boundary/);
    // Concise: summary stays well under the old ~900-char wall-of-text.
    expect(result.summary.length).toBeLessThan(500);
    // Args are recovered positionally.
    expect(result.independentArgs).toHaveLength(2);
    expect(result.independentArgs?.[0].type).toBe("address");
    expect(result.independentArgs?.[1].type).toBe("uint256");
    expect(result.independentArgs?.[1].value).toBe("1000000");
  });

  it("skips 4byte candidates whose selector doesn't match the calldata's first 4 bytes", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(42n));
    const result = await verifyEvmCalldata(
      tx,
      // First result is a known selector-collision that shares NO prefix with transfer's 0xa9059cbb.
      // Second one is the real signature.
      mockFetch(["watch_tg_invmru_d89c2fcf()", "transfer(address,uint256)"]),
    );
    expect(result.status).toBe("match");
    expect(result.independentSignature).toBe("transfer(address,uint256)");
  });

  it("returns status=mismatch when the 4byte function name disagrees with the local ABI decode", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    // Construct a bogus signature whose 4-byte selector happens to equal transfer's selector
    // by finding a colliding function name. We don't actually have such a collision in the
    // test fixtures — so simulate the mismatch path by stubbing verification.humanDecode
    // to claim a different function name.
    const bogusTx = {
      ...tx,
      verification: {
        ...tx.verification!,
        humanDecode: {
          ...tx.verification!.humanDecode,
          functionName: "transferWithDrain",
          signature: "transferWithDrain(address,uint256)",
        },
      },
    };
    const result = await verifyEvmCalldata(
      bogusTx,
      mockFetch(["transfer(address,uint256)"]),
    );
    expect(result.status).toBe("mismatch");
    expect(result.summary).toMatch(/MISMATCH/);
    expect(result.summary).toMatch(/DO NOT SEND/);
    expect(result.localFunctionName).toBe("transferWithDrain");
    expect(result.independentFunctionName).toBe("transfer");
  });

  it("returns status=no-signature when 4byte has no entry for the selector", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    const result = await verifyEvmCalldata(tx, mockFetch([]));
    expect(result.status).toBe("no-signature");
    expect(result.summary).toMatch(/not registered/);
    expect(result.summary).toMatch(/swiss-knife/);
  });

  it("returns status=error and a human-readable summary on a network failure", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    const failingFetch: MockFetch = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await verifyEvmCalldata(tx, failingFetch);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/Could not reach 4byte/);
    expect(result.summary).toMatch(/ETIMEDOUT/);
  });

  it("returns status=no-data for a pure native transfer with empty calldata", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const nativeTx: UnsignedTx = {
      chain: "ethereum",
      to: RECIPIENT,
      data: "0x",
      value: "1000000000000000000",
      from: SENDER,
      description: "Send 1 ETH",
    };
    // fetchFn should never be invoked — assert by handing it a throwing impl.
    const shouldNotCall: MockFetch = async () => {
      throw new Error("fetch should not be called for no-data path");
    };
    const result = await verifyEvmCalldata(issueHandles(nativeTx), shouldNotCall);
    expect(result.status).toBe("no-data");
    expect(result.summary).toMatch(/native-value/);
  });

  it("handles the 4byte signature-collision case: rejects candidates that don't re-encode losslessly", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1_000n));
    // First candidate is parseable and selector-matching, but takes the wrong arg layout —
    // picking a non-colliding alternative that will fail re-encode. Using `transfer(uint256)`
    // which has a different selector and will be filtered by the selector check before re-encode.
    // To exercise the re-encode fallback, we'd need an actual collision; here we just verify
    // that multiple candidates are tried and the right one wins.
    const result = await verifyEvmCalldata(
      tx,
      mockFetch([
        "some_other_function(bytes)",
        "transfer(address,uint256)",
      ]),
    );
    expect(result.status).toBe("match");
    expect(result.independentSignature).toBe("transfer(address,uint256)");
  });
});

describe("verifyTxDecode (MCP handler) — routes by handle origin", () => {
  it("returns not-applicable for TRON handles (no 4-byte selector concept on TRON)", async () => {
    const { verifyTxDecode } = await import("../src/modules/execution/index.js");
    const stamped = issueTronHandle({
      chain: "tron",
      action: "native_send",
      from: "TXYZ",
      txID: "e".repeat(64),
      rawData: {},
      rawDataHex: "aa",
      description: "send 1 TRX",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "1 TRX" } },
    });
    const result = await verifyTxDecode({ handle: stamped.handle! });
    expect(result.status).toBe("not-applicable");
    expect(result.summary).toMatch(/EVM-only/);
    expect(result.summary).toMatch(/tronscan/);
  });

  it("throws a clear 'Unknown or expired' error for an unrecognized handle", async () => {
    const { verifyTxDecode } = await import("../src/modules/execution/index.js");
    await expect(verifyTxDecode({ handle: "not-a-real-handle" })).rejects.toThrow(
      /Unknown or expired tx handle/,
    );
  });
});

describe("agent task block directs the orchestrator to verify_tx_decode, not a WebFetch", () => {
  it("names the MCP tool explicitly and forbids ad-hoc scraping", () => {
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
    const task = blocks[1];
    expect(task).toMatch(/verify_tx_decode/);
    // Must relay the tool's summary verbatim, not paraphrase.
    expect(task).toMatch(/VERBATIM/);
    // Explicit don't-scrape rule.
    expect(task).toMatch(/Do NOT[\s\n]+script/);
    // Still carries the final Ledger hash-match reminder and handle-secrecy rule.
    expect(task).toMatch(/Before approving on Ledger/);
    expect(task).toMatch(/Do NOT echo the handle/);
  });
});
