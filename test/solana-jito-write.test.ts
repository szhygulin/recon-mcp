import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Jito stake write-builder tests. Mocks the SPL stake-pool SDK so we
 * never touch the real package's BorshAccountsCoder / web3.js subtree
 * and never hit a real Solana RPC. Asserts:
 *   - ix[0] is SystemProgram.nonceAdvance (mirror of every other Solana
 *     send this server builds — durable-nonce protection is the
 *     ix[0]-detected validity gate).
 *   - The action ix is built from `StakePoolInstruction.depositSol`
 *     with `fundingAccount = user wallet` (NOT an ephemeral keypair —
 *     the whole point of this implementation).
 *   - When the user's jitoSOL ATA doesn't exist, the builder prepends
 *     `createAssociatedTokenAccountIdempotent` before the deposit.
 *   - Pre-flight: missing nonce account → throwNonceRequired error.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const STAKE_POOL_PROGRAM = new PublicKey(
  "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
);
const FAKE_POOL_MINT = new PublicKey(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
);
const FAKE_RESERVE_STAKE = Keypair.generate().publicKey;
const FAKE_MANAGER_FEE = Keypair.generate().publicKey;

const connectionStub = {
  getAccountInfo: vi.fn(),
  getLatestBlockhash: vi.fn(),
};

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

// SDK fake — the only call sites we exercise are getStakePoolAccount +
// StakePoolInstruction.depositSol + STAKE_POOL_PROGRAM_ID.
const depositSolMock = vi.fn();
const getStakePoolAccountMock = vi.fn();

vi.mock("@solana/spl-stake-pool", () => ({
  STAKE_POOL_PROGRAM_ID: STAKE_POOL_PROGRAM,
  getStakePoolAccount: (...args: unknown[]) => getStakePoolAccountMock(...args),
  StakePoolInstruction: {
    depositSol: (...args: unknown[]) => depositSolMock(...args),
  },
}));

beforeEach(() => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getLatestBlockhash.mockReset();
  depositSolMock.mockReset();
  getStakePoolAccountMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setNoncePresent(): Promise<void> {
  const { getNonceAccountValue } = await import("../src/modules/solana/nonce.js");
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
    authority: WALLET_KEYPAIR.publicKey,
  });
}

async function setNonceMissing(): Promise<void> {
  const { getNonceAccountValue } = await import("../src/modules/solana/nonce.js");
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function setStakePoolAccount(): void {
  getStakePoolAccountMock.mockResolvedValue({
    pubkey: new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"),
    account: {
      data: {
        poolMint: FAKE_POOL_MINT,
        reserveStake: FAKE_RESERVE_STAKE,
        managerFeeAccount: FAKE_MANAGER_FEE,
      },
    },
  });
}

function setDepositSolReturn(): void {
  // Synthetic instruction — what matters for the test is identity, not
  // wire-correctness.
  const ix = new TransactionInstruction({
    keys: [],
    programId: STAKE_POOL_PROGRAM,
    data: Buffer.from([]),
  });
  depositSolMock.mockReturnValue(ix);
}

describe("buildJitoStake", () => {
  it("composes nonceAdvance + depositSol when ATA already exists", async () => {
    await setNoncePresent();
    setStakePoolAccount();
    // ATA exists — single getAccountInfo call returns truthy.
    connectionStub.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(165) });
    setDepositSolReturn();

    const { buildJitoStake } = await import("../src/modules/solana/jito.js");
    const result = await buildJitoStake({ wallet: WALLET, amountSol: "1.5" });

    expect(result.action).toBe("jito_stake");
    expect(result.from).toBe(WALLET);
    expect(result.decoded.args.amountSol).toBe("1.5");
    expect(result.decoded.args.amountLamports).toBe("1500000000");
    expect(result.decoded.args.createsAta).toBeUndefined();

    expect(depositSolMock).toHaveBeenCalledTimes(1);
    const callArgs = depositSolMock.mock.calls[0]![0]! as {
      fundingAccount: PublicKey;
      lamports: number;
    };
    // The whole point: fundingAccount IS the user's wallet — no
    // ephemeral keypair.
    expect(callArgs.fundingAccount.toBase58()).toBe(WALLET);
    expect(callArgs.lamports).toBe(1_500_000_000);

    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(result.handle);
    expect(draft.kind).toBe("v0");
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    // ix[0] is SystemProgram.nonceAdvance (tag 0x04 in u32-LE).
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0]!.data.readUInt32LE(0)).toBe(4);
    // ix[1] is the depositSol stub.
    expect(draft.instructions[1]!.programId.toBase58()).toBe(
      STAKE_POOL_PROGRAM.toBase58(),
    );
    expect(draft.instructions.length).toBe(2);
  });

  it("prepends createAssociatedTokenAccountIdempotent when jitoSOL ATA missing", async () => {
    await setNoncePresent();
    setStakePoolAccount();
    // ATA missing.
    connectionStub.getAccountInfo.mockResolvedValue(null);
    setDepositSolReturn();

    const { buildJitoStake } = await import("../src/modules/solana/jito.js");
    const result = await buildJitoStake({ wallet: WALLET, amountSol: "0.1" });

    expect(result.decoded.args.createsAta).toBe("true");
    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(result.handle);
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    // ix[0] = nonceAdvance, ix[1] = createATAIdempotent (ATA program),
    // ix[2] = depositSol.
    expect(draft.instructions.length).toBe(3);
    expect(draft.instructions[1]!.programId.toBase58()).toBe(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    expect(draft.instructions[2]!.programId.toBase58()).toBe(
      STAKE_POOL_PROGRAM.toBase58(),
    );
  });

  it("refuses with structured error when nonce account missing", async () => {
    await setNonceMissing();
    const { buildJitoStake } = await import("../src/modules/solana/jito.js");
    await expect(
      buildJitoStake({ wallet: WALLET, amountSol: "1" }),
    ).rejects.toThrow(/durable-nonce account not initialized/i);
  });

  it("rejects non-positive or malformed amounts", async () => {
    await setNoncePresent();
    const { buildJitoStake } = await import("../src/modules/solana/jito.js");
    await expect(
      buildJitoStake({ wallet: WALLET, amountSol: "0" }),
    ).rejects.toThrow(/Invalid SOL amount/);
    await expect(
      buildJitoStake({ wallet: WALLET, amountSol: "abc" }),
    ).rejects.toThrow(/Invalid SOL amount/);
  });
});
