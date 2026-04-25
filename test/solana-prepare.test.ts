import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  makeConnectionStub,
  resetConnectionStub,
} from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
  resetNonceMock,
  DEFAULT_TEST_NONCE_VALUE,
} from "./fixtures/solana-nonce-mock.js";

/**
 * Builder tests for `prepare_solana_native_send` / `prepare_solana_spl_send`.
 * Mocks the Solana Connection so we never touch the network.
 *
 * Note: we generate fresh on-curve keypairs for the wallet + recipient
 * because `getAssociatedTokenAddressSync` rejects off-curve owner addresses
 * by default. Hardcoding random base58 strings would trip that check since
 * only points on the ed25519 curve are valid pubkeys.
 *
 * Nonce account mocking: every send builder now requires a pre-existing
 * nonce account for the wallet (durable-nonce-only mode). We mock
 * `getNonceAccountValue` at the module boundary to avoid having to
 * serialize a valid NonceAccount data buffer into getAccountInfo
 * responses. Individual tests that verify the "nonce missing" error
 * path re-mock with null.
 */

const WALLET = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NONCE_VALUE = DEFAULT_TEST_NONCE_VALUE;

const connectionStub = makeConnectionStub();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// vi.mock body stays inline — vitest hoists this above all imports, so the
// fixture's exported factory can't be referenced here.
vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return { ...actual, getNonceAccountValue: vi.fn() };
});

async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(new PublicKey(WALLET), NONCE_VALUE);
}

beforeEach(async () => {
  resetConnectionStub(connectionStub);
  await resetNonceMock();

  // Default: no congestion — skip priority fee.
  connectionStub.getRecentPrioritizationFees.mockResolvedValue([]);
  // Default blockhash.
  connectionStub.getLatestBlockhash.mockResolvedValue({
    blockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
    lastValidBlockHeight: 123_456_789,
  });
  // Default rent-exempt minimum for nonce-account sizing.
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(1_500_000);
  // Default: nonce account exists (send/close flows).
  await setNoncePresent();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSolanaNativeSend", () => {
  it("builds a SystemProgram.transfer for an explicit amount", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000); // 5 SOL
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "1.5",
    });

    expect(tx.chain).toBe("solana");
    expect(tx.action).toBe("native_send");
    expect(tx.from).toBe(WALLET);
    expect(tx.decoded.functionName).toBe("solana.system.transfer");
    expect(tx.decoded.args.lamports).toBe("1500000000"); // 1.5 SOL
    expect(tx.handle).toBeDefined();
    // Prepare returns a DRAFT — no messageBase64 / recentBlockhash yet.
    // Those get pinned by `preview_solana_send`.
    expect((tx as Record<string, unknown>).messageBase64).toBeUndefined();
    expect((tx as Record<string, unknown>).recentBlockhash).toBeUndefined();
    // No priority fee under default (empty) getRecentPrioritizationFees.
    expect(tx.priorityFeeMicroLamports).toBeUndefined();
  });

  it("resolves `max` to balance minus fee and safety buffer", async () => {
    connectionStub.getBalance.mockResolvedValue(2_000_000_000); // 2 SOL
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "max",
    });
    // Expected: 2_000_000_000 - 5000 (fee) - 10_000 (buffer) = 1_999_985_000 lamports.
    expect(tx.decoded.args.lamports).toBe("1999985000");
  });

  it("refuses when the wallet is short", async () => {
    connectionStub.getBalance.mockResolvedValue(100_000); // 0.0001 SOL
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    await expect(
      buildSolanaNativeSend({ wallet: WALLET, to: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/Insufficient SOL/);
  });

  it("injects priority fee when getRecentPrioritizationFees p50 is above threshold", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    // Return samples with p50 = 10_000 μlamports/CU (above the 5_000 threshold).
    const samples = Array.from({ length: 10 }, (_, i) => ({
      slot: 100 + i,
      prioritizationFee: 10_000,
    }));
    connectionStub.getRecentPrioritizationFees.mockResolvedValue(samples);

    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    expect(tx.priorityFeeMicroLamports).toBe(10_000);
    expect(tx.computeUnitLimit).toBe(200_000);
  });
});

describe("buildSolanaSplSend", () => {
  it("builds a TransferChecked when recipient ATA exists", async () => {
    // SOL balance (enough for fee)
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    // Sender ATA exists
    connectionStub.getAccountInfo
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) }) // sender ATA
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(RECIPIENT) }); // recipient ATA
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000000", decimals: 6, uiAmount: 100, uiAmountString: "100" },
    });

    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaSplSend({
      wallet: WALLET,
      mint: USDC_MINT,
      to: RECIPIENT,
      amount: "50",
    });

    expect(tx.action).toBe("spl_send");
    expect(tx.decoded.functionName).toBe("solana.spl.transferChecked");
    expect(tx.decoded.args.symbol).toBe("USDC");
    expect(tx.decoded.args.amountBase).toBe("50000000"); // 50 × 10^6
    // No ATA creation needed.
    expect(tx.rentLamports).toBeUndefined();
    expect(tx.decoded.args.createsRecipientAta).toBeUndefined();
  });

  it("auto-creates recipient ATA with rent disclosure when missing", async () => {
    connectionStub.getBalance.mockResolvedValue(100_000_000); // 0.1 SOL
    connectionStub.getAccountInfo
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) }) // sender ATA exists
      .mockResolvedValueOnce(null); // recipient ATA missing
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000000", decimals: 6, uiAmount: 100, uiAmountString: "100" },
    });

    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaSplSend({
      wallet: WALLET,
      mint: USDC_MINT,
      to: RECIPIENT,
      amount: "1",
    });
    expect(tx.rentLamports).toBe(2_039_280);
    expect(tx.decoded.args.createsRecipientAta).toBe("true");
    expect(tx.description).toContain("create recipient USDC account");
  });

  it("refuses if the sender has no ATA for the mint", async () => {
    connectionStub.getBalance.mockResolvedValue(100_000_000);
    connectionStub.getAccountInfo.mockResolvedValueOnce(null); // sender ATA missing

    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    await expect(
      buildSolanaSplSend({ wallet: WALLET, mint: USDC_MINT, to: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/has no associated token account/);
  });

  it("refuses when the sender's token balance is short", async () => {
    connectionStub.getBalance.mockResolvedValue(100_000_000);
    connectionStub.getAccountInfo
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) })
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(RECIPIENT) });
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "500000", decimals: 6, uiAmount: 0.5, uiAmountString: "0.5" },
    });

    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    await expect(
      buildSolanaSplSend({ wallet: WALLET, mint: USDC_MINT, to: RECIPIENT, amount: "10" }),
    ).rejects.toThrow(/Insufficient USDC/);
  });

  it("refuses when SOL balance is short for fee + rent (ATA creation case)", async () => {
    // Only 1_000_000 lamports (0.001 SOL) — not enough for 0.00204 rent + 5k fee.
    connectionStub.getBalance.mockResolvedValue(1_000_000);
    connectionStub.getAccountInfo
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) })
      .mockResolvedValueOnce(null);
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000000", decimals: 6, uiAmount: 100, uiAmountString: "100" },
    });

    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    await expect(
      buildSolanaSplSend({ wallet: WALLET, mint: USDC_MINT, to: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/Insufficient SOL for fees/);
  });
});

describe("durable-nonce preflight", () => {
  it("buildSolanaNativeSend auto-bundles createNonce + initNonce + transfer when nonce account missing", async () => {
    await setNonceMissing();
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "1",
    });
    expect(tx.action).toBe("native_send");
    expect(tx.decoded.args.firstTimeNonceSetup).toBe("true");
    expect(tx.decoded.functionName).toBe(
      "solana.system.transfer+createNonceAccount",
    );
    expect(tx.description).toMatch(/one-time durable-nonce account setup/);
    // Rent surfaced on the result so the agent can show it.
    expect(tx.rentLamports).toBe(1_500_000);

    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    // ix[0] = createAccountWithSeed (SystemInstruction tag 3, u32 LE)
    expect(draft.draftTx.instructions[0].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(draft.draftTx.instructions[0].data.readUInt32LE(0)).toBe(3);
    // ix[1] = nonceInitialize (SystemInstruction tag 6)
    expect(draft.draftTx.instructions[1].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(draft.draftTx.instructions[1].data.readUInt32LE(0)).toBe(6);
    // No durable-nonce meta — preview pins via getLatestBlockhash on this run.
    expect(draft.meta.nonce).toBeUndefined();
  });

  it("buildSolanaSplSend auto-bundles createNonce + initNonce + transferChecked when nonce account missing", async () => {
    await setNonceMissing();
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    connectionStub.getAccountInfo
      // sender ATA exists
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) })
      // recipient ATA exists too
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(RECIPIENT) });
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000000", decimals: 6, uiAmount: 100, uiAmountString: "100" },
    });
    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaSplSend({
      wallet: WALLET,
      mint: USDC_MINT,
      to: RECIPIENT,
      amount: "1",
    });
    expect(tx.decoded.args.firstTimeNonceSetup).toBe("true");
    expect(tx.decoded.functionName).toBe(
      "solana.spl.transferChecked+createNonceAccount",
    );
    expect(tx.description).toMatch(/one-time durable-nonce account setup/);
    expect(tx.rentLamports).toBe(1_500_000);

    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    expect(draft.draftTx.instructions[0].data.readUInt32LE(0)).toBe(3); // createAccountWithSeed
    expect(draft.draftTx.instructions[1].data.readUInt32LE(0)).toBe(6); // nonceInitialize
    expect(draft.meta.nonce).toBeUndefined();
  });

  it("first-time native_send refuses when balance can't cover amount + fee + nonce rent", async () => {
    await setNonceMissing();
    // 1 SOL balance, asking to send 1 SOL — leaves no room for the 0.0015 SOL nonce rent + fee.
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    await expect(
      buildSolanaNativeSend({ wallet: WALLET, to: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/one-time durable-nonce account rent/);
  });

  it("buildSolanaNativeSend prepends AdvanceNonceAccount as ix[0] when nonce is present", async () => {
    // setNoncePresent was called in beforeEach.
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.5",
    });
    // Surface the nonce account in the prepared result.
    expect(tx.nonceAccount).toBeDefined();
    expect(tx.decoded.args.nonceAccount).toBe(tx.nonceAccount);
    // Pull the draft and inspect ix[0] = AdvanceNonceAccount.
    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    expect(draft.draftTx.instructions.length).toBeGreaterThan(0);
    expect(draft.draftTx.instructions[0].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    // AdvanceNonceAccount tag = 4, encoded as u32 LE.
    expect(draft.draftTx.instructions[0].data.readUInt32LE(0)).toBe(4);
    // meta.nonce is populated so pinSolanaHandle knows to use it.
    expect(draft.meta.nonce).toBeDefined();
    expect(draft.meta.nonce!.account).toBe(tx.nonceAccount);
    expect(draft.meta.nonce!.authority).toBe(WALLET);
  });

  it("buildSolanaSplSend prepends AdvanceNonceAccount as ix[0] when nonce is present", async () => {
    connectionStub.getBalance.mockResolvedValue(1_000_000_000);
    connectionStub.getAccountInfo
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(WALLET) })
      .mockResolvedValueOnce({ data: Buffer.alloc(165), owner: new PublicKey(RECIPIENT) });
    connectionStub.getTokenAccountBalance.mockResolvedValue({
      value: { amount: "100000000", decimals: 6, uiAmount: 100, uiAmountString: "100" },
    });
    const { buildSolanaSplSend } = await import("../src/modules/solana/actions.js");
    const tx = await buildSolanaSplSend({
      wallet: WALLET,
      mint: USDC_MINT,
      to: RECIPIENT,
      amount: "10",
    });
    expect(tx.nonceAccount).toBeDefined();
    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    expect(draft.draftTx.instructions[0].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(draft.draftTx.instructions[0].data.readUInt32LE(0)).toBe(4);
    expect(draft.meta.nonce).toBeDefined();
  });
});
