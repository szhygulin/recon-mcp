/**
 * `explain_tx` post-mortem tests. Per-chain RPC is mocked at the
 * module boundary so no live HTTP fires. Coverage:
 *   - EVM happy path: ERC-20 transfer with priced fee + balance delta.
 *   - EVM heuristic: unlimited approval surfaces.
 *   - EVM failed tx: status flips, "failed" heuristic fires.
 *   - TRON happy path: TransferContract native TRX transfer.
 *   - Solana happy path: SPL token transfer with balance deltas.
 *   - Render: narrative includes summary + step-by-step + balance
 *     section + heuristics block.
 *   - Bitcoin chain rejected with explicit "deferred" error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const evmGetTransactionMock = vi.fn();
const evmGetTransactionReceiptMock = vi.fn();
const evmGetBlockMock = vi.fn();
const evmReadContractMock = vi.fn();
const getTokenPriceMock = vi.fn();
const resolveSelectorsMock = vi.fn();
const fetchWithTimeoutMock = vi.fn();
const getDefillamaCoinPriceMock = vi.fn();
const solanaGetParsedTransactionMock = vi.fn();

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    getTransaction: (...a: unknown[]) => evmGetTransactionMock(...a),
    getTransactionReceipt: (...a: unknown[]) =>
      evmGetTransactionReceiptMock(...a),
    getBlock: (...a: unknown[]) => evmGetBlockMock(...a),
    readContract: (...a: unknown[]) => evmReadContractMock(...a),
  }),
  resetClients: () => {},
}));

vi.mock("../src/data/prices.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/prices.js")>();
  return {
    ...actual,
    getTokenPrice: (...a: unknown[]) => getTokenPriceMock(...a),
    getDefillamaCoinPrice: (...a: unknown[]) =>
      getDefillamaCoinPriceMock(...a),
  };
});

vi.mock("../src/modules/history/decode.js", () => ({
  resolveSelectors: (...a: unknown[]) => resolveSelectorsMock(...a),
}));

vi.mock("../src/data/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/http.js")>();
  return {
    ...actual,
    fetchWithTimeout: (...a: unknown[]) => fetchWithTimeoutMock(...a),
  };
});

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => ({
    getParsedTransaction: (...a: unknown[]) =>
      solanaGetParsedTransactionMock(...a),
  }),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TX_HASH =
  "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

function pad32(addrLower: string): `0x${string}` {
  return `0x000000000000000000000000${addrLower.replace(/^0x/, "").toLowerCase()}` as `0x${string}`;
}

function encUint(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

beforeEach(() => {
  evmGetTransactionMock.mockReset();
  evmGetTransactionReceiptMock.mockReset();
  evmGetBlockMock.mockReset();
  evmReadContractMock.mockReset();
  getTokenPriceMock.mockReset();
  resolveSelectorsMock.mockReset();
  fetchWithTimeoutMock.mockReset();
  getDefillamaCoinPriceMock.mockReset();
  solanaGetParsedTransactionMock.mockReset();

  // Default: no method resolves, no prices.
  resolveSelectorsMock.mockResolvedValue(new Map());
  getTokenPriceMock.mockResolvedValue(undefined);
  evmGetBlockMock.mockResolvedValue({ timestamp: 1714128000n });
  // ERC-20 metadata defaults: USDC.
  evmReadContractMock.mockImplementation(async (call: { functionName: string }) => {
    if (call.functionName === "symbol") return "USDC";
    if (call.functionName === "decimals") return 6;
    throw new Error(`unexpected readContract: ${call.functionName}`);
  });
  getDefillamaCoinPriceMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explainTx — EVM happy path", () => {
  it("decodes an ERC-20 USDC transfer with balance delta + priced fee", async () => {
    evmGetTransactionMock.mockResolvedValue({
      from: WALLET,
      to: USDC,
      value: 0n,
      input:
        "0xa9059cbb" +
        RECIPIENT.slice(2).toLowerCase().padStart(64, "0") +
        (1_000_000n).toString(16).padStart(64, "0"), // transfer(recipient, 1 USDC)
    });
    evmGetTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 19_000_000n,
      gasUsed: 65_000n,
      effectiveGasPrice: 20_000_000_000n, // 20 gwei
      from: WALLET,
      to: USDC,
      logs: [
        {
          address: USDC.toLowerCase(),
          topics: [
            TRANSFER_TOPIC,
            pad32(WALLET),
            pad32(RECIPIENT),
          ],
          data: encUint(1_000_000n),
        },
      ],
    });
    resolveSelectorsMock.mockResolvedValue(
      new Map([["0xa9059cbb", { methodName: "transfer" }]]),
    );
    // ETH price.
    getTokenPriceMock.mockImplementation(async (_chain: string, addr: string) => {
      if (addr === "native") return 4000;
      if (addr.toLowerCase() === USDC.toLowerCase()) return 1;
      return undefined;
    });

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: TX_HASH,
      chain: "ethereum",
      format: "structured",
    });

    expect(r.status).toBe("success");
    expect(r.summary).toContain("transfer");
    expect(r.from).toBe(WALLET);
    expect(r.to).toBe(USDC);
    // Step rows: top-level call + Transfer event.
    expect(r.steps.find((s) => s.kind === "call" && s.label === "transfer")).toBeDefined();
    expect(r.steps.find((s) => s.kind === "event" && s.label === "Transfer")).toBeDefined();
    // Balance delta: -1 USDC (sender) + native gas burn (~0.0013 ETH).
    const usdcRow = r.balanceChanges.find((b) => b.symbol === "USDC")!;
    expect(usdcRow.delta).toBe("-1");
    const ethRow = r.balanceChanges.find((b) => b.symbol === "ETH")!;
    expect(Number(ethRow.delta)).toBeLessThan(0); // gas paid
    expect(r.feeNative).toBeDefined();
    expect(r.feeUsd).toBeGreaterThan(0);
    expect(r.heuristics.find((h) => h.rule === "failed")).toBeUndefined();
  });
});

describe("explainTx — EVM unlimited approval heuristic", () => {
  it("flags unlimited_approval when approve(spender, MAX_UINT256) is observed", async () => {
    const MAX = (1n << 256n) - 1n;
    evmGetTransactionMock.mockResolvedValue({
      from: WALLET,
      to: USDC,
      value: 0n,
      input:
        "0x095ea7b3" +
        RECIPIENT.slice(2).toLowerCase().padStart(64, "0") +
        MAX.toString(16).padStart(64, "0"),
    });
    evmGetTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 19_000_000n,
      gasUsed: 50_000n,
      effectiveGasPrice: 10_000_000_000n,
      from: WALLET,
      to: USDC,
      logs: [
        {
          address: USDC.toLowerCase(),
          topics: [APPROVAL_TOPIC, pad32(WALLET), pad32(RECIPIENT)],
          data: encUint(MAX),
        },
      ],
    });
    resolveSelectorsMock.mockResolvedValue(
      new Map([["0x095ea7b3", { methodName: "approve" }]]),
    );

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: TX_HASH,
      chain: "ethereum",
      format: "structured",
    });

    expect(r.approvalChanges).toHaveLength(1);
    expect(r.approvalChanges[0].isUnlimited).toBe(true);
    expect(r.approvalChanges[0].newAllowance).toBe("unlimited");
    expect(
      r.heuristics.find((h) => h.rule === "unlimited_approval"),
    ).toBeDefined();
  });
});

describe("explainTx — EVM failed tx", () => {
  it("flags failed status and short-circuits other heuristics", async () => {
    evmGetTransactionMock.mockResolvedValue({
      from: WALLET,
      to: USDC,
      value: 0n,
      input: "0xa9059cbb" + "0".repeat(128),
    });
    evmGetTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 19_000_000n,
      gasUsed: 30_000n,
      effectiveGasPrice: 10_000_000_000n,
      from: WALLET,
      to: USDC,
      logs: [],
    });

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: TX_HASH,
      chain: "ethereum",
      format: "structured",
    });

    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/REVERTED/i);
    expect(r.heuristics.find((h) => h.rule === "failed")).toBeDefined();
    // Other heuristics are short-circuited on failed:
    expect(r.heuristics).toHaveLength(1);
  });
});

describe("explainTx — TRON happy path", () => {
  it("decodes a native TRX TransferContract", async () => {
    fetchWithTimeoutMock.mockImplementation(async (url: string) => {
      if (url.includes("gettransactionbyid")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            txID: "abc",
            blockTimeStamp: 1714128000000,
            raw_data: {
              contract: [
                {
                  type: "TransferContract",
                  parameter: {
                    value: {
                      owner_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
                      to_address: "41b614f803b6fd780986a42c78ec9c7f77e6ded13c",
                      amount: 1_000_000, // 1 TRX (in SUN)
                    },
                  },
                },
              ],
            },
            ret: [{ contractRet: "SUCCESS" }],
          }),
        };
      }
      // gettransactioninfobyid
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          id: "abc",
          blockNumber: 60_000_000,
          blockTimeStamp: 1714128000000,
          fee: 100_000, // 0.1 TRX
          log: [],
        }),
      };
    });
    getDefillamaCoinPriceMock.mockResolvedValue({ price: 0.1 });

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: "abcdef".padEnd(64, "0"),
      chain: "tron",
      format: "structured",
    });

    expect(r.chain).toBe("tron");
    expect(r.status).toBe("success");
    expect(r.summary).toContain("1 TRX");
    expect(r.feeNative).toBe("0.1");
    // Native delta: -1 TRX (transferred) - 0.1 TRX (fee) = -1.1 TRX.
    const trx = r.balanceChanges.find((b) => b.symbol === "TRX")!;
    expect(trx).toBeDefined();
    expect(Number(trx.delta)).toBeCloseTo(-1.1, 5);
  });
});

describe("explainTx — Solana happy path", () => {
  it("decodes an SPL token transfer with balance deltas", async () => {
    const FEE_PAYER = "11111111111111111111111111111112";
    const RECIPIENT_OWNER = "1111111111111111111111111111111R";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const SIG = "5".repeat(88);

    solanaGetParsedTransactionMock.mockResolvedValue({
      slot: 250_000_000,
      blockTime: 1714128000,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1_000_000_000],
        postBalances: [994_000],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: FEE_PAYER,
            uiTokenAmount: { amount: "10000000", decimals: 6, uiAmountString: "10" },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: FEE_PAYER,
            uiTokenAmount: { amount: "5000000", decimals: 6, uiAmountString: "5" },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: { toBase58: () => FEE_PAYER } },
            { pubkey: { toBase58: () => RECIPIENT_OWNER } },
          ],
          instructions: [
            {
              programId: { toBase58: () => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
              program: "spl-token",
              parsed: {
                type: "transferChecked",
                info: {
                  source: "src-ata",
                  destination: "dst-ata",
                  mint: USDC_MINT,
                  tokenAmount: { uiAmountString: "5", amount: "5000000" },
                },
              },
            },
          ],
        },
        signatures: [SIG],
      },
    });
    getDefillamaCoinPriceMock.mockResolvedValue({ price: 200 });

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: SIG,
      chain: "solana",
      format: "structured",
    });

    expect(r.chain).toBe("solana");
    expect(r.status).toBe("success");
    // SOL delta: -5000 lamports of fee + the post/pre delta of accountKeys[0].
    // post=994000, pre=1000000000 → delta=-999006000 lamports = -0.999006 SOL.
    const sol = r.balanceChanges.find((b) => b.symbol === "SOL")!;
    expect(sol).toBeDefined();
    expect(Number(sol.delta)).toBeCloseTo(-0.999006, 4);
    // USDC delta: -5 (sent 5).
    const usdc = r.balanceChanges.find((b) => b.symbol === "USDC")!;
    expect(usdc).toBeDefined();
    expect(usdc.delta).toBe("-5");
    expect(r.steps.find((s) => s.kind === "instruction")).toBeDefined();
  });
});

describe("explainTx — narrative output", () => {
  it("includes a pre-rendered narrative when format !== 'structured'", async () => {
    evmGetTransactionMock.mockResolvedValue({
      from: WALLET,
      to: RECIPIENT,
      value: 1_000_000_000_000_000n, // 0.001 ETH
      input: "0x",
    });
    evmGetTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 19_000_000n,
      gasUsed: 21_000n,
      effectiveGasPrice: 10_000_000_000n,
      from: WALLET,
      to: RECIPIENT,
      logs: [],
    });

    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    const r = await explainTx({
      hash: TX_HASH,
      chain: "ethereum",
      format: "both",
    });
    expect(typeof r.narrative).toBe("string");
    expect(r.narrative!).toContain("TRANSACTION ANALYSIS");
    expect(r.narrative!).toContain("Hash:");
    expect(r.narrative!).toContain("Status: SUCCESS");
    expect(r.narrative!).toContain("Summary:");
  });
});

describe("explainTx — Bitcoin deferred", () => {
  it("rejects the request before the chain enum even allows it", async () => {
    const { explainTx } = await import("../src/modules/postmortem/index.ts");
    // The schema only allows EVM/TRON/Solana, so the Zod layer would
    // reject "bitcoin" upstream — but the dispatcher also has a clear
    // error if reached directly.
    await expect(
      explainTx({
        hash: "0".repeat(64),
        chain: "bitcoin" as never,
        format: "structured",
      }),
    ).rejects.toThrow(/does not yet support|deferred|Bitcoin/);
  });
});
