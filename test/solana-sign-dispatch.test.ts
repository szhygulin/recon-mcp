import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * sendTransaction dispatch test for Solana handles. Covers:
 *   - Solana handle routes to the Solana signer (not TRON / EVM).
 *   - Pre-sign payload fingerprint check fires before the USB signer is
 *     invoked.
 *   - Retire happens after successful broadcast.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();

const getAddressMock = vi.fn();
const getAppConfigurationMock = vi.fn();
const signTransactionMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/solana-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getAddress: getAddressMock,
      getAppConfiguration: getAppConfigurationMock,
      signTransaction: signTransactionMock,
    },
    transport: { close: transportCloseMock },
  }),
}));

const connectionStub = {
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
  getLatestBlockhash: vi.fn(),
  getRecentPrioritizationFees: vi.fn(),
  sendRawTransaction: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  getAddressMock.mockReset();
  getAppConfigurationMock.mockReset();
  signTransactionMock.mockReset();
  transportCloseMock.mockClear();
  for (const fn of Object.values(connectionStub)) fn.mockReset();

  connectionStub.getLatestBlockhash.mockResolvedValue({
    blockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
    lastValidBlockHeight: 123_456_789,
  });
  connectionStub.getRecentPrioritizationFees.mockResolvedValue([]);
  getAppConfigurationMock.mockResolvedValue({ version: "1.10.0" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendTransaction dispatch — Solana", () => {
  it("routes a Solana handle through the Solana USB signer + broadcast, after preview pins blockhash", async () => {
    // 1. Prepare + preview to get a PINNED handle.
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    expect(draft.handle).toBeDefined();

    // preview pins a fresh blockhash and stores messageBase64 on the handle.
    const { previewSolanaSend } = await import("../src/modules/execution/index.js");
    await previewSolanaSend({ handle: draft.handle });

    // 2. Wire up the Ledger mock to return the expected wallet address + a
    //    well-formed 64-byte signature.
    getAddressMock.mockResolvedValue({
      address: WALLET_KEYPAIR.publicKey.toBuffer(),
    });
    const fakeSignature = Buffer.alloc(64, 7);
    signTransactionMock.mockResolvedValue({ signature: fakeSignature });

    // 3. Mock broadcast — return a fake Solana signature base58 string.
    const fakeTxSig = "5J7sCLXMksr5Ki8DGHxsEaKx1c3xXVUfd6gK3D4u4TjtMsm4zQW7n3SK6PX5N6C5wRV5U6XF5Q2YK3r7fHgM1R9t";
    connectionStub.sendRawTransaction.mockResolvedValue(fakeTxSig);

    // 4. Send.
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const result = await sendTransaction({
      handle: draft.handle,
      confirmed: true,
    });

    expect(result.chain).toBe("solana");
    expect(result.txHash).toBe(fakeTxSig);

    // USB signer was actually invoked.
    expect(signTransactionMock).toHaveBeenCalledOnce();
    const [pathArg, msgArg] = signTransactionMock.mock.calls[0]!;
    expect(pathArg).toBe("44'/501'/0'");
    expect(Buffer.isBuffer(msgArg)).toBe(true);

    // Handle is retired after success — a retry should fail.
    const { hasSolanaHandle } = await import("../src/signing/solana-tx-store.js");
    expect(hasSolanaHandle(draft.handle)).toBe(false);
  });

  it("refuses with a clear error if send_transaction is called before preview_solana_send pins the handle", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });

    const { sendTransaction } = await import("../src/modules/execution/index.js");
    await expect(
      sendTransaction({ handle: draft.handle, confirmed: true }),
    ).rejects.toThrow(/has not been pinned yet.*preview_solana_send/);

    // USB was not touched.
    expect(signTransactionMock).not.toHaveBeenCalled();
    expect(connectionStub.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses with the address-mismatch SECURITY error when Ledger returns a different pubkey", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const { previewSolanaSend } = await import("../src/modules/execution/index.js");
    await previewSolanaSend({ handle: draft.handle });

    // Ledger returns a DIFFERENT address — simulates wrong device connected
    // or a tampered `from` field.
    const wrongKeypair = Keypair.generate();
    getAddressMock.mockResolvedValue({
      address: wrongKeypair.publicKey.toBuffer(),
    });

    const { sendTransaction } = await import("../src/modules/execution/index.js");
    await expect(
      sendTransaction({ handle: draft.handle, confirmed: true }),
    ).rejects.toThrow(/SECURITY.*does not match/);

    // Broadcast was NOT called.
    expect(connectionStub.sendRawTransaction).not.toHaveBeenCalled();
    // Handle is NOT retired — caller can retry with the right device.
    const { hasSolanaHandle } = await import("../src/signing/solana-tx-store.js");
    expect(hasSolanaHandle(draft.handle)).toBe(true);
  });

  it("surfaces lastValidBlockHeight on the send_transaction result so the status poller can detect dropped txs", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    connectionStub.getLatestBlockhash.mockResolvedValueOnce({
      blockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
      lastValidBlockHeight: 1_234_567,
    });

    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const { previewSolanaSend } = await import("../src/modules/execution/index.js");
    const pinned = await previewSolanaSend({ handle: draft.handle });
    expect(pinned.lastValidBlockHeight).toBe(1_234_567);

    getAddressMock.mockResolvedValue({
      address: WALLET_KEYPAIR.publicKey.toBuffer(),
    });
    signTransactionMock.mockResolvedValue({ signature: Buffer.alloc(64, 9) });
    connectionStub.sendRawTransaction.mockResolvedValue("sig-xyz");

    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const result = await sendTransaction({
      handle: draft.handle,
      confirmed: true,
    });
    expect(result.chain).toBe("solana");
    expect(result.lastValidBlockHeight).toBe(1_234_567);
  });

  it("re-calling preview_solana_send on the same handle re-pins with a newer blockhash", async () => {
    connectionStub.getBalance.mockResolvedValue(5_000_000_000);
    const { buildSolanaNativeSend } = await import("../src/modules/solana/actions.js");
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });

    const { previewSolanaSend } = await import("../src/modules/execution/index.js");
    const firstPinBlockhash = "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh";
    connectionStub.getLatestBlockhash.mockResolvedValueOnce({
      blockhash: firstPinBlockhash,
      lastValidBlockHeight: 1_000,
    });
    const first = await previewSolanaSend({ handle: draft.handle });
    expect(first.recentBlockhash).toBe(firstPinBlockhash);

    // User pauses; caller re-previews. Returns a different blockhash + hash.
    const secondPinBlockhash = "5a7PR3n1eTKCTgLkbkjNWTBvFu8kv1RYD9QgEQD8CAzB";
    connectionStub.getLatestBlockhash.mockResolvedValueOnce({
      blockhash: secondPinBlockhash,
      lastValidBlockHeight: 1_200,
    });
    const second = await previewSolanaSend({ handle: draft.handle });
    expect(second.recentBlockhash).toBe(secondPinBlockhash);
    expect(second.messageBase64).not.toBe(first.messageBase64);
    expect(second.verification!.payloadHash).not.toBe(first.verification!.payloadHash);
  });
});
