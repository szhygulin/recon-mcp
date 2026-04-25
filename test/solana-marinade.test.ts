import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { makeConnectionStub } from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
} from "./fixtures/solana-nonce-mock.js";

/**
 * Marinade write-builder tests. Mocks the Marinade SDK so we never touch
 * Marinade's heavy transitive deps (Anchor + a Borsh codec for the on-chain
 * state) and never hit a real Solana RPC. Asserts:
 *   - ix[0] is SystemProgram.nonceAdvance (durable-nonce protection mirror
 *     of marginfi/jupiter); the SDK's deposit/liquidUnstake instructions
 *     are appended after.
 *   - The stored draft is v0 (carries empty addressLookupTableAccounts) and
 *     has the right meta (action, decoded.args, nonce metadata).
 *   - Pre-flight: missing nonce account → throwNonceRequired error.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MARINADE_PROGRAM_ID = new PublicKey(
  "MarBmsSgKXdrN1egZf5sqe1TMThczhMLJhJtoesFiF1",
);
const FAKE_MSOL_ATA = new PublicKey(
  "8JUjWjAyXTMB4ZXcV7nk3p6Gg1fWAAoSCHEPugYzj22h",
);

const connectionStub = makeConnectionStub();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

// SDK fake — we drive the result shape from each test (deposit + liquidUnstake
// both return `{ associatedMSolTokenAccountAddress, transaction }`).
const depositMock = vi.fn();
const liquidUnstakeMock = vi.fn();
vi.mock("@marinade.finance/marinade-ts-sdk", () => {
  class MarinadeConfig {
    constructor(public opts: unknown) {}
  }
  class Marinade {
    constructor(public config: unknown) {}
    deposit(...args: unknown[]) {
      return depositMock(...args);
    }
    liquidUnstake(...args: unknown[]) {
      return liquidUnstakeMock(...args);
    }
  }
  return { MarinadeConfig, Marinade };
});

// Anchor BN — we don't need a real BN, just a `toString` method since
// the builder only converts the bigint via `new BN(lamports.toString())`
// and hands it to the SDK (which we've mocked).
vi.mock("@coral-xyz/anchor", () => ({
  BN: class {
    constructor(public value: string) {}
    toString(): string {
      return this.value;
    }
  },
}));

async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(WALLET_KEYPAIR.publicKey);
}

function fakeMarinadeIx(label: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARINADE_PROGRAM_ID,
    keys: [],
    data: Buffer.from(label, "utf-8"),
  });
}

function fakeMarinadeResult(actionLabel: string) {
  const tx = new Transaction();
  tx.add(fakeMarinadeIx(`${actionLabel}-1`));
  tx.add(fakeMarinadeIx(`${actionLabel}-2`));
  return {
    associatedMSolTokenAccountAddress: FAKE_MSOL_ATA,
    transaction: tx,
  };
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getLatestBlockhash.mockReset();
  depositMock.mockReset();
  liquidUnstakeMock.mockReset();

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMarinadeStake", () => {
  it("wraps marinade.deposit with nonceAdvance at ix[0] and stamps decoded args", async () => {
    await setNoncePresent();
    depositMock.mockResolvedValue(fakeMarinadeResult("deposit"));

    const { buildMarinadeStake } = await import(
      "../src/modules/solana/marinade.js"
    );
    const prepared = await buildMarinadeStake({
      wallet: WALLET,
      amountSol: "1.5",
    });

    expect(prepared.action).toBe("marinade_stake");
    expect(prepared.chain).toBe("solana");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("1.5 SOL");
    expect(prepared.decoded.functionName).toBe("marinade.deposit");
    expect(prepared.decoded.args.wallet).toBe(WALLET);
    expect(prepared.decoded.args.amountSol).toBe("1.5");
    expect(prepared.decoded.args.mSolAta).toBe(FAKE_MSOL_ATA.toBase58());
    expect(prepared.nonceAccount).toBeDefined();

    // SDK got the lamport-quantized amount (1.5 SOL = 1_500_000_000).
    expect(depositMock).toHaveBeenCalledTimes(1);
    const bnArg = depositMock.mock.calls[0][0] as { toString(): string };
    expect(bnArg.toString()).toBe("1500000000");

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    expect(draft.kind).toBe("v0");
    if (draft.kind !== "v0") throw new Error("unreachable");

    // ix[0] = SystemProgram.nonceAdvance, tag 04000000.
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");

    // ix[1..] = the SDK's deposit instructions, in order.
    expect(draft.instructions.length).toBe(3);
    expect(draft.instructions[1].programId.toBase58()).toBe(
      MARINADE_PROGRAM_ID.toBase58(),
    );
    expect(draft.instructions[1].data.toString("utf-8")).toBe("deposit-1");
    expect(draft.instructions[2].data.toString("utf-8")).toBe("deposit-2");

    // Empty ALTs (this PR doesn't ship any Marinade-specific lookup tables).
    expect(draft.addressLookupTableAccounts).toEqual([]);

    // Nonce meta survives for the pin step's consistency guard.
    expect(draft.meta.nonce?.account).toBe(prepared.nonceAccount);
    expect(draft.meta.nonce?.authority).toBe(WALLET);
    expect(draft.meta.action).toBe("marinade_stake");
  });

  it("rejects non-positive / non-finite SOL amounts with a clear error", async () => {
    await setNoncePresent();
    const { buildMarinadeStake } = await import(
      "../src/modules/solana/marinade.js"
    );
    await expect(
      buildMarinadeStake({ wallet: WALLET, amountSol: "0" }),
    ).rejects.toThrow(/Invalid SOL amount/);
    await expect(
      buildMarinadeStake({ wallet: WALLET, amountSol: "-1" }),
    ).rejects.toThrow(/Invalid SOL amount/);
    await expect(
      buildMarinadeStake({ wallet: WALLET, amountSol: "abc" }),
    ).rejects.toThrow(/Invalid SOL amount/);
  });

  it("throws nonce-required when the wallet has no durable-nonce account", async () => {
    await setNonceMissing();
    const { buildMarinadeStake } = await import(
      "../src/modules/solana/marinade.js"
    );
    await expect(
      buildMarinadeStake({ wallet: WALLET, amountSol: "1" }),
    ).rejects.toThrow(/nonce account not initialized/i);
  });
});

describe("buildMarinadeUnstakeImmediate", () => {
  it("wraps marinade.liquidUnstake with nonceAdvance at ix[0] and stamps decoded args", async () => {
    await setNoncePresent();
    liquidUnstakeMock.mockResolvedValue(fakeMarinadeResult("liquidUnstake"));

    const { buildMarinadeUnstakeImmediate } = await import(
      "../src/modules/solana/marinade.js"
    );
    const prepared = await buildMarinadeUnstakeImmediate({
      wallet: WALLET,
      amountMSol: "0.25",
    });

    expect(prepared.action).toBe("marinade_unstake_immediate");
    expect(prepared.description).toContain("0.25 mSOL");
    expect(prepared.description).toContain("via liquidity pool");
    expect(prepared.decoded.functionName).toBe("marinade.liquidUnstake");
    expect(prepared.decoded.args.amountMSol).toBe("0.25");
    expect(prepared.decoded.args.mSolAta).toBe(FAKE_MSOL_ATA.toBase58());

    // mSOL has 9 decimals; 0.25 → 250_000_000 base units.
    const bnArg = liquidUnstakeMock.mock.calls[0][0] as {
      toString(): string;
    };
    expect(bnArg.toString()).toBe("250000000");

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    expect(draft.instructions[1].data.toString("utf-8")).toBe("liquidUnstake-1");
    expect(draft.meta.action).toBe("marinade_unstake_immediate");
  });

  it("rejects bad mSOL amounts with a clear error", async () => {
    await setNoncePresent();
    const { buildMarinadeUnstakeImmediate } = await import(
      "../src/modules/solana/marinade.js"
    );
    await expect(
      buildMarinadeUnstakeImmediate({ wallet: WALLET, amountMSol: "0" }),
    ).rejects.toThrow(/Invalid mSOL amount/);
  });
});

describe("renderSolanaAgentTaskBlock — marinade actions", () => {
  it("treats marinade_stake as blind-sign (Message Hash on-device, CHECK 2 runs)", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "marinade_stake" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description: "Marinade stake: deposit 1.5 SOL → mSOL",
      decoded: {
        functionName: "marinade.deposit",
        args: {
          wallet: WALLET,
          amountSol: "1.5",
          mSolAta: FAKE_MSOL_ATA.toBase58(),
        },
      },
      nonce: {
        account: "NonceAcct1",
        authority: WALLET,
        value: "Gfnhk",
      },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);

    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain(expectedHash);
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    // Stake-flavored summary lines.
    expect(block).toContain("SOL → mSOL");
    expect(block).toContain("Marinade stake");
    // Durable-nonce mode reaffirmed.
    expect(block).toContain("durable-nonce-protected");
  });

  it("treats marinade_unstake_immediate as blind-sign with the unstake-flavored summary", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "marinade_unstake_immediate" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description:
        "Marinade liquid unstake: 0.25 mSOL → SOL (via liquidity pool, with fee)",
      decoded: {
        functionName: "marinade.liquidUnstake",
        args: {
          wallet: WALLET,
          amountMSol: "0.25",
          mSolAta: FAKE_MSOL_ATA.toBase58(),
        },
      },
      nonce: {
        account: "NonceAcct1",
        authority: WALLET,
        value: "Gfnhk",
      },
    };
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("Marinade liquid unstake");
    expect(block).toContain("mSOL → SOL");
  });
});

describe("solanaActionLabel + verification artifact wiring", () => {
  it("renderSolanaPrepareSummaryBlock surfaces the human label for marinade_stake", async () => {
    const { renderSolanaPrepareSummaryBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderSolanaPrepareSummaryBlock({
      handle: "h",
      action: "marinade_stake",
      from: WALLET,
      description: "Marinade stake: deposit 1 SOL → mSOL",
      decoded: {
        functionName: "marinade.deposit",
        args: { wallet: WALLET, amountSol: "1" },
      },
    });
    expect(block).toContain("Marinade stake (SOL → mSOL)");
  });

  it("includes ledgerMessageHash in the Solana verification artifact for marinade actions", async () => {
    await setNoncePresent();
    depositMock.mockResolvedValue(fakeMarinadeResult("deposit"));

    const { buildMarinadeStake } = await import(
      "../src/modules/solana/marinade.js"
    );
    const prepared = await buildMarinadeStake({
      wallet: WALLET,
      amountSol: "1",
    });

    // Pin a fresh blockhash so the artifact path has a `messageBase64` to hash.
    const { pinSolanaHandle } = await import(
      "../src/signing/solana-tx-store.js"
    );
    pinSolanaHandle(
      prepared.handle,
      "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
    );

    const { getVerificationArtifact } = await import(
      "../src/modules/execution/index.js"
    );
    const artifact = getVerificationArtifact({ handle: prepared.handle });
    expect(artifact.chain).toBe("solana");
    if (artifact.chain !== "solana") throw new Error("unreachable");
    expect(artifact.action).toBe("marinade_stake");
    expect(artifact.ledgerMessageHash).toBeDefined();
  });
});
