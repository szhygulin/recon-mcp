import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, StakeProgram } from "@solana/web3.js";
import { makeConnectionStub } from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
} from "./fixtures/solana-nonce-mock.js";

/**
 * Native stake-program write builders. Mocks the RPC at the Connection
 * boundary (getAccountInfo + getMinimumBalanceForRentExemption + nonce). The
 * builders themselves call into `@solana/web3.js`'s `StakeProgram` static
 * helpers, which are pure ix factories — no network, no signing — so we
 * leave them un-mocked and let the real ix bytes flow through.
 *
 * Asserts:
 *   - ix[0] is SystemProgram.nonceAdvance (durable-nonce protection).
 *   - delegate path: createAccountWithSeed + StakeInstruction.Initialize +
 *     StakeInstruction.Delegate, in order, on the same deterministic
 *     stake-account address derived from (wallet, validator).
 *   - deactivate / withdraw operate on user-supplied stake account; correct
 *     authority + amount semantics.
 *   - "max" withdraw path reads on-chain lamports.
 *   - Pre-flight: missing nonce → throwNonceRequired; existing stake →
 *     refuses to overwrite.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const VALIDATOR_KEYPAIR = Keypair.generate();
const VALIDATOR = VALIDATOR_KEYPAIR.publicKey.toBase58();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const STAKE_PROGRAM = StakeProgram.programId.toBase58();

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

async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(WALLET_KEYPAIR.publicKey);
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getMinimumBalanceForRentExemption.mockReset();
  // Live mainnet rent-exempt minimum for the 200-byte stake account.
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(2_282_880);
  connectionStub.getLatestBlockhash.mockReset();

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveStakeAccountAddress", () => {
  it("is deterministic for the same (wallet, validator) pair", async () => {
    const { deriveStakeAccountAddress } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const a = await deriveStakeAccountAddress(
      WALLET_KEYPAIR.publicKey,
      VALIDATOR_KEYPAIR.publicKey,
    );
    const b = await deriveStakeAccountAddress(
      WALLET_KEYPAIR.publicKey,
      VALIDATOR_KEYPAIR.publicKey,
    );
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("yields different addresses for different validators under the same wallet", async () => {
    const { deriveStakeAccountAddress } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const v2 = Keypair.generate();
    const a = await deriveStakeAccountAddress(
      WALLET_KEYPAIR.publicKey,
      VALIDATOR_KEYPAIR.publicKey,
    );
    const b = await deriveStakeAccountAddress(WALLET_KEYPAIR.publicKey, v2.publicKey);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe("buildNativeStakeDelegate", () => {
  it("composes nonceAdvance + createAccountWithSeed + initialize + delegate, in order", async () => {
    await setNoncePresent();
    // Stake account doesn't exist yet (the common path).
    connectionStub.getAccountInfo.mockResolvedValue(null);

    const { buildNativeStakeDelegate, deriveStakeAccountAddress } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const expectedStakePk = await deriveStakeAccountAddress(
      WALLET_KEYPAIR.publicKey,
      VALIDATOR_KEYPAIR.publicKey,
    );

    const prepared = await buildNativeStakeDelegate({
      wallet: WALLET,
      validator: VALIDATOR,
      amountSol: "1.5",
    });

    expect(prepared.action).toBe("native_stake_delegate");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.stakeAccount).toBe(expectedStakePk.toBase58());
    expect(prepared.rentLamports).toBe(2_282_880);
    expect(prepared.decoded.functionName).toBe("stake.createWithSeed+delegate");
    expect(prepared.decoded.args.validator).toBe(VALIDATOR);
    expect(prepared.decoded.args.amountSol).toBe("1.5");
    expect(prepared.decoded.args.stakeAccount).toBe(expectedStakePk.toBase58());

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");

    // ix[0] = SystemProgram.nonceAdvance, tag 0x04.
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");

    // StakeProgram.createAccountWithSeed returns a 2-ix Transaction
    // (system createWithSeed + stake initialize). Plus the delegate ix
    // appended after = 4 total action ixs (1 nonce + 3 stake).
    // Actual breakdown:
    //   ix[1] = SystemProgram.createAccountWithSeed
    //   ix[2] = StakeInstruction.Initialize
    //   ix[3] = StakeInstruction.Delegate
    expect(draft.instructions.length).toBe(4);
    expect(draft.instructions[1].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[2].programId.toBase58()).toBe(STAKE_PROGRAM);
    expect(draft.instructions[3].programId.toBase58()).toBe(STAKE_PROGRAM);

    expect(draft.meta.action).toBe("native_stake_delegate");
    expect(draft.meta.rentLamports).toBe(2_282_880);
    expect(draft.meta.nonce?.account).toBe(prepared.nonceAccount);
  });

  it("refuses when a stake account already exists at the deterministic address", async () => {
    await setNoncePresent();
    // Stake account already exists.
    connectionStub.getAccountInfo.mockResolvedValue({
      lamports: 1_000_000_000,
      owner: StakeProgram.programId,
      data: Buffer.alloc(200),
      executable: false,
      rentEpoch: 0,
    });

    const { buildNativeStakeDelegate } = await import(
      "../src/modules/solana/native-stake.js"
    );
    await expect(
      buildNativeStakeDelegate({
        wallet: WALLET,
        validator: VALIDATOR,
        amountSol: "1.5",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects bad SOL amounts", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue(null);
    const { buildNativeStakeDelegate } = await import(
      "../src/modules/solana/native-stake.js"
    );
    await expect(
      buildNativeStakeDelegate({
        wallet: WALLET,
        validator: VALIDATOR,
        amountSol: "0",
      }),
    ).rejects.toThrow(/Invalid SOL amount/);
  });

  it("throws nonce-required when the wallet has no durable-nonce account", async () => {
    await setNonceMissing();
    const { buildNativeStakeDelegate } = await import(
      "../src/modules/solana/native-stake.js"
    );
    await expect(
      buildNativeStakeDelegate({
        wallet: WALLET,
        validator: VALIDATOR,
        amountSol: "1",
      }),
    ).rejects.toThrow(/nonce account not initialized/i);
  });
});

describe("buildNativeStakeDeactivate", () => {
  it("wraps StakeProgram.deactivate with nonceAdvance at ix[0]", async () => {
    await setNoncePresent();
    const stakeAccount = Keypair.generate().publicKey.toBase58();

    const { buildNativeStakeDeactivate } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const prepared = await buildNativeStakeDeactivate({
      wallet: WALLET,
      stakeAccount,
    });

    expect(prepared.action).toBe("native_stake_deactivate");
    expect(prepared.description).toContain(stakeAccount);
    expect(prepared.decoded.functionName).toBe("stake.deactivate");
    expect(prepared.decoded.args.stakeAccount).toBe(stakeAccount);

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions.length).toBe(2);
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    expect(draft.instructions[1].programId.toBase58()).toBe(STAKE_PROGRAM);
  });
});

describe("buildNativeStakeWithdraw", () => {
  it("withdraws an explicit SOL amount", async () => {
    await setNoncePresent();
    const stakeAccount = Keypair.generate().publicKey.toBase58();

    const { buildNativeStakeWithdraw } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const prepared = await buildNativeStakeWithdraw({
      wallet: WALLET,
      stakeAccount,
      amountSol: "0.5",
    });

    expect(prepared.action).toBe("native_stake_withdraw");
    expect(prepared.decoded.args.amountSol).toBe("0.5");
    expect(prepared.decoded.args.lamports).toBe("500000000");

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions.length).toBe(2);
    expect(draft.instructions[1].programId.toBase58()).toBe(STAKE_PROGRAM);
  });

  it("'max' withdraws the full on-chain lamport balance", async () => {
    await setNoncePresent();
    const stakeAccount = Keypair.generate().publicKey.toBase58();
    connectionStub.getAccountInfo.mockResolvedValue({
      lamports: 7_500_000_000,
      owner: StakeProgram.programId,
      data: Buffer.alloc(200),
      executable: false,
      rentEpoch: 0,
    });

    const { buildNativeStakeWithdraw } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const prepared = await buildNativeStakeWithdraw({
      wallet: WALLET,
      stakeAccount,
      amountSol: "max",
    });

    expect(prepared.decoded.args.amountSol).toBe("max");
    expect(prepared.decoded.args.lamports).toBe("7500000000");
    expect(prepared.description).toContain("MAX");
    expect(prepared.description).toContain("7.500000000 SOL");
  });

  it("'max' errors clearly when the stake account doesn't exist", async () => {
    await setNoncePresent();
    const stakeAccount = Keypair.generate().publicKey.toBase58();
    connectionStub.getAccountInfo.mockResolvedValue(null);

    const { buildNativeStakeWithdraw } = await import(
      "../src/modules/solana/native-stake.js"
    );
    await expect(
      buildNativeStakeWithdraw({
        wallet: WALLET,
        stakeAccount,
        amountSol: "max",
      }),
    ).rejects.toThrow(/not found on-chain/);
  });
});

describe("renderSolanaAgentTaskBlock — native stake actions", () => {
  it("treats native_stake_delegate as blind-sign and surfaces validator + amount", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "native_stake_delegate" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description: "Native stake delegate: 1.5 SOL → validator " + VALIDATOR,
      decoded: {
        functionName: "stake.createWithSeed+delegate",
        args: {
          wallet: WALLET,
          validator: VALIDATOR,
          amountSol: "1.5",
          stakeAccount: "Stake1111111111111111111111111111111111111",
          rentLamports: "2282880",
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
    expect(block).toContain("native stake delegate");
    expect(block).toContain("durable-nonce-protected");
  });

  it("treats native_stake_deactivate / withdraw as blind-sign with action-specific summaries", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const stakeAccount = "Stake1111111111111111111111111111111111111";
    const deactivateBlock = renderSolanaAgentTaskBlock({
      chain: "solana" as const,
      action: "native_stake_deactivate" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description: `Native stake deactivate: ${stakeAccount}`,
      decoded: {
        functionName: "stake.deactivate",
        args: { wallet: WALLET, stakeAccount },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: "Gfnhk" },
    });
    expect(deactivateBlock).toContain("BLIND-SIGN");
    expect(deactivateBlock).toContain("native stake deactivate");
    expect(deactivateBlock).toContain("one epoch");

    const withdrawBlock = renderSolanaAgentTaskBlock({
      chain: "solana" as const,
      action: "native_stake_withdraw" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description: `Native stake withdraw: 1 SOL from ${stakeAccount} → ${WALLET}`,
      decoded: {
        functionName: "stake.withdraw",
        args: {
          wallet: WALLET,
          stakeAccount,
          amountSol: "1",
          lamports: "1000000000",
        },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: "Gfnhk" },
    });
    expect(withdrawBlock).toContain("native stake withdraw");
    expect(withdrawBlock).toContain("inactive");
  });
});

describe("verification artifact wiring", () => {
  it("stamps ledgerMessageHash on the Solana artifact for native stake actions", async () => {
    await setNoncePresent();
    const stakeAccount = Keypair.generate().publicKey.toBase58();

    const { buildNativeStakeDeactivate } = await import(
      "../src/modules/solana/native-stake.js"
    );
    const prepared = await buildNativeStakeDeactivate({
      wallet: WALLET,
      stakeAccount,
    });

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
    expect(artifact.action).toBe("native_stake_deactivate");
    expect(artifact.ledgerMessageHash).toBeDefined();
  });
});
