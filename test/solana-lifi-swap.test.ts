import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { makeConnectionStub } from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
} from "./fixtures/solana-nonce-mock.js";

/**
 * LiFi-on-Solana write-builder tests. Mocks the LiFi SDK's `getQuote` to
 * return a synthetic v0 transaction we control, plus the connection /
 * nonce / ALT-resolver. The builder's load-bearing piece is the
 * decompile-then-prepend-nonceAdvance dance — these tests pin its
 * invariants:
 *   - ix[0] is SystemProgram.nonceAdvance
 *   - ix[1+] preserves the LiFi-returned ixs in order
 *   - draft has the wallet as feePayer, the resolved ALTs, and the right
 *     action / decoded.args / nonce meta
 *   - multi-tx, multi-signer, and fee-payer-mismatch routes raise clear
 *     errors
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const FAKE_BRIDGE_PROGRAM = Keypair.generate().publicKey;
const FAKE_BLOCKHASH = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";

const connectionStub = makeConnectionStub();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
  getSolanaRpcUrl: () => "https://test",
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

const resolveAltMock = vi.fn();
vi.mock("../src/modules/solana/alt.js", () => ({
  resolveAddressLookupTables: (...args: unknown[]) => resolveAltMock(...args),
  clearAltCache: () => {},
  invalidateAlt: () => {},
}));

const fetchSolanaQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchSolanaQuote: (...args: unknown[]) => fetchSolanaQuoteMock(...args),
  SOLANA_WSOL_MINT: "So11111111111111111111111111111111111111112",
  SOLANA_NATIVE_SENTINEL: "11111111111111111111111111111111",
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
}));

async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(WALLET_KEYPAIR.publicKey, FAKE_BLOCKHASH);
}

/**
 * Build a fake LiFi-shaped VersionedTransaction: single-signer (wallet
 * as fee payer), one bridge-program ix carrying recognizable bytes, no
 * ALTs. base64-encoded so it matches LiFi's wire shape.
 */
function makeFakeLifiTxBase64(opts?: {
  feePayer?: PublicKey;
  extraSignerKey?: PublicKey;
  ixData?: Buffer;
}): string {
  const feePayer = opts?.feePayer ?? WALLET_KEYPAIR.publicKey;
  const ixData = opts?.ixData ?? Buffer.from([0xab, 0xcd]);
  const keys = [
    { pubkey: feePayer, isSigner: true, isWritable: true },
  ];
  if (opts?.extraSignerKey) {
    keys.push({
      pubkey: opts.extraSignerKey,
      isSigner: true,
      isWritable: false,
    });
  }
  const ix = new TransactionInstruction({
    programId: FAKE_BRIDGE_PROGRAM,
    keys,
    data: ixData,
  });
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: FAKE_BLOCKHASH,
    instructions: [ix],
  }).compileToV0Message();
  const vt = new VersionedTransaction(message);
  return Buffer.from(vt.serialize()).toString("base64");
}

function makeQuoteResponse(txDataBase64: string | string[] | undefined) {
  return {
    transactionRequest: txDataBase64 !== undefined ? { data: txDataBase64 } : undefined,
    action: {
      fromAmount: "1000000000",
      fromToken: { symbol: "SOL", decimals: 9 },
      toToken: { symbol: "USDC", decimals: 6 },
      slippage: 0.005,
    },
    estimate: {
      toAmount: "170000000",
      toAmountMin: "169150000",
    },
    tool: "jupiter",
    toolDetails: { name: "Jupiter" },
  };
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getAddressLookupTable.mockReset();
  fetchSolanaQuoteMock.mockReset();
  resolveAltMock.mockReset();
  resolveAltMock.mockResolvedValue([]); // default: no ALTs

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildLifiSolanaSwap — happy path", () => {
  it("composes nonceAdvance + LiFi ix in order, with wallet as fee payer", async () => {
    await setNoncePresent();
    const lifiTxBase64 = makeFakeLifiTxBase64();
    fetchSolanaQuoteMock.mockResolvedValue(makeQuoteResponse(lifiTxBase64));

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    const prepared = await buildLifiSolanaSwap({
      wallet: WALLET,
      fromMint: "native",
      fromAmount: "1000000000",
      toChain: "solana",
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });

    expect(prepared.action).toBe("lifi_solana_swap");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("LiFi swap");
    expect(prepared.description).toContain("Jupiter");
    expect(prepared.decoded.functionName).toBe("lifi.solana.swap");
    expect(prepared.decoded.args.tool).toBe("Jupiter");
    expect(prepared.decoded.args.toChain).toBe("solana");
    expect(prepared.decoded.args.minOutput).toBe("169150000");

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");

    // ix[0] = SystemProgram.nonceAdvance, tag 0x04
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");

    // ix[1] = the LiFi-returned bridge-program ix, preserved verbatim.
    expect(draft.instructions.length).toBe(2);
    expect(draft.instructions[1].programId.toBase58()).toBe(
      FAKE_BRIDGE_PROGRAM.toBase58(),
    );
    expect(draft.instructions[1].data.toString("hex")).toBe("abcd");

    expect(draft.payerKey.toBase58()).toBe(WALLET);
    expect(draft.addressLookupTableAccounts).toEqual([]);
    expect(draft.meta.action).toBe("lifi_solana_swap");
    expect(draft.meta.nonce?.value).toBe(FAKE_BLOCKHASH);
  });

  it("labels the description as a bridge when toChain is an EVM chain", async () => {
    await setNoncePresent();
    fetchSolanaQuoteMock.mockResolvedValue(
      makeQuoteResponse(makeFakeLifiTxBase64()),
    );

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    const prepared = await buildLifiSolanaSwap({
      wallet: WALLET,
      fromMint: "native",
      fromAmount: "1000000000",
      toChain: "ethereum",
      toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(prepared.description).toContain("LiFi bridge");
    expect(prepared.description).toContain("ethereum");
  });

  it("forwards explicit slippage to the LiFi quote (bps → fraction)", async () => {
    await setNoncePresent();
    fetchSolanaQuoteMock.mockResolvedValue(
      makeQuoteResponse(makeFakeLifiTxBase64()),
    );

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await buildLifiSolanaSwap({
      wallet: WALLET,
      fromMint: "native",
      fromAmount: "1000000000",
      toChain: "solana",
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      slippage: 0.01,
    });
    const quoteCall = fetchSolanaQuoteMock.mock.calls[0][0] as {
      slippage?: number;
    };
    expect(quoteCall.slippage).toBe(0.01);
  });
});

describe("buildLifiSolanaSwap — rejection paths", () => {
  it("throws nonce-required when the wallet has no durable-nonce account", async () => {
    await setNonceMissing();
    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await expect(
      buildLifiSolanaSwap({
        wallet: WALLET,
        fromMint: "native",
        fromAmount: "1000000000",
        toChain: "solana",
        toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ).rejects.toThrow(/nonce account not initialized/i);
  });

  it("rejects multi-tx routes (transactionRequest.data is an array)", async () => {
    await setNoncePresent();
    const tx1 = makeFakeLifiTxBase64();
    const tx2 = makeFakeLifiTxBase64();
    fetchSolanaQuoteMock.mockResolvedValue(makeQuoteResponse([tx1, tx2]));

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await expect(
      buildLifiSolanaSwap({
        wallet: WALLET,
        fromMint: "native",
        fromAmount: "1000000000",
        toChain: "ethereum",
        toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        toAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow(/2 transactions.*single-tx/);
  });

  it("rejects multi-signer routes (numRequiredSignatures > 1)", async () => {
    await setNoncePresent();
    const ephemeralKey = Keypair.generate().publicKey;
    fetchSolanaQuoteMock.mockResolvedValue(
      makeQuoteResponse(makeFakeLifiTxBase64({ extraSignerKey: ephemeralKey })),
    );

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await expect(
      buildLifiSolanaSwap({
        wallet: WALLET,
        fromMint: "native",
        fromAmount: "1000000000",
        toChain: "ethereum",
        toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        toAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow(/2 signers.*Ledger-only/);
  });

  it("rejects routes whose fee payer doesn't match the user wallet", async () => {
    await setNoncePresent();
    const otherWallet = Keypair.generate();
    fetchSolanaQuoteMock.mockResolvedValue(
      makeQuoteResponse(makeFakeLifiTxBase64({ feePayer: otherWallet.publicKey })),
    );

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await expect(
      buildLifiSolanaSwap({
        wallet: WALLET,
        fromMint: "native",
        fromAmount: "1000000000",
        toChain: "solana",
        toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ).rejects.toThrow(/does not match the user wallet/);
  });

  it("rejects an empty quote (transactionRequest missing or no data)", async () => {
    await setNoncePresent();
    fetchSolanaQuoteMock.mockResolvedValue(makeQuoteResponse(undefined));

    const { buildLifiSolanaSwap } = await import(
      "../src/modules/solana/lifi-swap.js"
    );
    await expect(
      buildLifiSolanaSwap({
        wallet: WALLET,
        fromMint: "native",
        fromAmount: "1000000000",
        toChain: "solana",
        toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ).rejects.toThrow(/no transaction data/);
  });
});

describe("renderSolanaAgentTaskBlock — lifi_solana_swap", () => {
  it("treats it as blind-sign (Message Hash on-device, CHECK 2 runs)", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "lifi_solana_swap" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "LiFi bridge — 1 SOL (Solana) → ~170 USDC on ethereum via Mayan",
      decoded: {
        functionName: "lifi.solana.swap",
        args: {
          fromMint: "native",
          toChain: "ethereum",
          tool: "Mayan",
        },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);

    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain(expectedHash);
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("LiFi");
    expect(block).toContain("durable-nonce-protected");
  });
});
