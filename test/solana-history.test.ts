import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { cache } from "../src/data/cache.js";

const WALLET = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const JUP_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Arbitrary valid base58 pubkeys used as stand-ins for "some ATA" or "unknown
// program" in fixture data. Real Solana mainnet addresses so the base58
// decode passes; their on-chain role is irrelevant to these unit tests.
const SOME_ATA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_ATA = "7XuPQ9e6e3GvZK3m6Cb3Kjan5v2V3HRv4e8D7F2iHUuX";
const UNKNOWN_PROGRAM = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";

const connectionStub = {
  getSignaturesForAddress: vi.fn(),
  getParsedTransaction: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  cache.clear();
  connectionStub.getSignaturesForAddress.mockReset();
  connectionStub.getParsedTransaction.mockReset();

  // Default fetch returns no historical prices — price coverage will be "none".
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ coins: {} }),
      json: async () => ({ coins: {} }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal parsed-transaction builder for tests. */
interface BuildTxInput {
  signature: string;
  blockTime: number;
  accountKeys: string[];
  instructions: Array<
    | {
        programId: string;
        parsed: {
          type: string;
          info: Record<string, unknown>;
        };
      }
    | {
        programId: string;
        accounts: string[];
        data: string;
      }
  >;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: Array<{
    accountIndex: number;
    mint: string;
    owner: string;
    uiTokenAmount: { amount: string; decimals: number };
  }>;
  postTokenBalances?: Array<{
    accountIndex: number;
    mint: string;
    owner: string;
    uiTokenAmount: { amount: string; decimals: number };
  }>;
  err?: unknown;
}

function buildTx(input: BuildTxInput) {
  return {
    transaction: {
      signatures: [input.signature],
      message: {
        accountKeys: input.accountKeys.map((k) => ({ pubkey: new PublicKey(k) })),
        instructions: input.instructions.map((ix) => {
          if ("parsed" in ix) {
            return { programId: new PublicKey(ix.programId), parsed: ix.parsed };
          }
          return {
            programId: new PublicKey(ix.programId),
            accounts: ix.accounts.map((a) => new PublicKey(a)),
            data: ix.data,
          };
        }),
      },
    },
    meta: {
      err: input.err ?? null,
      preBalances: input.preBalances ?? [],
      postBalances: input.postBalances ?? [],
      preTokenBalances: input.preTokenBalances ?? [],
      postTokenBalances: input.postTokenBalances ?? [],
      fee: 5000,
    },
    blockTime: input.blockTime,
  };
}

describe("fetchSolanaHistory — pure System transfer", () => {
  it("produces an `external` item for a user-to-user SOL send", async () => {
    const DEST = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    connectionStub.getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sig_system", blockTime: 1_750_000_000 },
    ]);
    connectionStub.getParsedTransaction.mockResolvedValueOnce(
      buildTx({
        signature: "sig_system",
        blockTime: 1_750_000_000,
        accountKeys: [WALLET, DEST, SYSTEM_PROGRAM],
        instructions: [
          {
            programId: SYSTEM_PROGRAM,
            parsed: {
              type: "transfer",
              info: { source: WALLET, destination: DEST, lamports: 1_000_000_000 },
            },
          },
        ],
      }),
    );

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    expect(item.type).toBe("external");
    if (item.type === "external") {
      expect(item.valueNativeFormatted).toBe("1");
      expect(item.from).toBe(WALLET);
      expect(item.to).toBe(DEST);
    }
  });
});

describe("fetchSolanaHistory — SPL token transfer", () => {
  it("produces a `token_transfer` item for a USDC send", async () => {
    const SRC_ATA = SOME_ATA;
    const DST_ATA = OTHER_ATA;
    const OTHER_OWNER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

    connectionStub.getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sig_spl", blockTime: 1_750_000_100 },
    ]);
    connectionStub.getParsedTransaction.mockResolvedValueOnce(
      buildTx({
        signature: "sig_spl",
        blockTime: 1_750_000_100,
        accountKeys: [WALLET, SRC_ATA, DST_ATA, SPL_TOKEN_PROGRAM],
        instructions: [
          {
            programId: SPL_TOKEN_PROGRAM,
            parsed: {
              type: "transferChecked",
              info: {
                source: SRC_ATA,
                destination: DST_ATA,
                mint: USDC_MINT,
                tokenAmount: { amount: "50000000", decimals: 6 }, // 50 USDC
              },
            },
          },
        ],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "100000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: OTHER_OWNER,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "50000000", decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: OTHER_OWNER,
            uiTokenAmount: { amount: "50000000", decimals: 6 },
          },
        ],
      }),
    );

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    expect(item.type).toBe("token_transfer");
    if (item.type === "token_transfer") {
      expect(item.tokenSymbol).toBe("USDC");
      expect(item.tokenAddress).toBe(USDC_MINT);
      expect(item.amountFormatted).toBe("50");
      expect(item.from).toBe(WALLET);
    }
  });
});

describe("fetchSolanaHistory — Jupiter swap → program_interaction", () => {
  it("labels Jupiter V6 calls and attaches balance deltas", async () => {
    connectionStub.getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sig_jup", blockTime: 1_750_000_200 },
    ]);
    connectionStub.getParsedTransaction.mockResolvedValueOnce(
      buildTx({
        signature: "sig_jup",
        blockTime: 1_750_000_200,
        accountKeys: [WALLET, SOME_ATA, JUP_V6_PROGRAM],
        instructions: [
          {
            programId: JUP_V6_PROGRAM,
            accounts: [WALLET],
            data: "2VfUX",
          },
        ],
        preBalances: [2_000_000_000, 2_039_280, 0],
        postBalances: [1_500_000_000, 2_039_280, 0],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "75000000", decimals: 6 }, // 75 USDC out
          },
        ],
      }),
    );

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    expect(item.type).toBe("program_interaction");
    if (item.type === "program_interaction") {
      expect(item.programName).toBe("Jupiter V6");
      expect(item.programKind).toBe("aggregator");
      // SOL delta: -0.5 SOL (went out in the swap).
      const solDelta = item.balanceDeltas.find((d) => d.token === "SOL");
      expect(solDelta?.amountFormatted).toBe("-0.5");
      // USDC delta: +75 (received).
      const usdcDelta = item.balanceDeltas.find((d) => d.token === USDC_MINT);
      expect(usdcDelta?.amountFormatted).toBe("+75");
    }
  });
});

describe("fetchSolanaHistory — unknown program", () => {
  it("falls through to a bare program_interaction with programId only", async () => {
    connectionStub.getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sig_unknown", blockTime: 1_750_000_300 },
    ]);
    connectionStub.getParsedTransaction.mockResolvedValueOnce(
      buildTx({
        signature: "sig_unknown",
        blockTime: 1_750_000_300,
        accountKeys: [WALLET, UNKNOWN_PROGRAM],
        instructions: [
          {
            programId: UNKNOWN_PROGRAM,
            accounts: [WALLET],
            data: "11",
          },
        ],
        preBalances: [1_000_000_000, 0],
        postBalances: [999_999_000, 0],
      }),
    );

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(1);
    const item = res.items[0];
    expect(item.type).toBe("program_interaction");
    if (item.type === "program_interaction") {
      expect(item.programId).toBe(UNKNOWN_PROGRAM);
      expect(item.programName).toBeUndefined();
      expect(item.programKind).toBeUndefined();
    }
  });
});

describe("fetchSolanaHistory — error handling", () => {
  it("records getSignaturesForAddress failures in `errors` and returns empty items", async () => {
    connectionStub.getSignaturesForAddress.mockRejectedValueOnce(
      new Error("429 Too Many Requests"),
    );

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].source).toBe("solana.getSignaturesForAddress");
    expect(res.errors[0].message).toContain("429");
  });

  it("skips null tx returns (RPC pruned old txs) without failing", async () => {
    connectionStub.getSignaturesForAddress.mockResolvedValueOnce([
      { signature: "sig_missing", blockTime: 1_700_000_000 },
    ]);
    connectionStub.getParsedTransaction.mockResolvedValueOnce(null);

    const { fetchSolanaHistory } = await import("../src/modules/history/solana.ts");
    const res = await fetchSolanaHistory({ wallet: WALLET, limit: 10 });
    expect(res.items.length).toBe(0);
    expect(res.errors.length).toBe(0);
  });
});
