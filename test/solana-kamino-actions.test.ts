import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Kamino write-builder tests. The builders themselves orchestrate:
 *   1. Loading the Kamino main market (via `loadKaminoMainMarket` —
 *      already covered by `solana-kamino-loader.test.ts`).
 *   2. Calling SDK helpers (`getUserLutAddressAndSetupIxs`, `initObligation`,
 *      `KaminoAction.buildDepositTxns`, `KaminoAction.actionToIxs`).
 *   3. Bridging kit `Instruction[]` → web3.js v1 via `kitInstructionsToLegacy`.
 *   4. Wrapping in our durable-nonce v0 tx pipeline.
 *
 * Tests mock the SDK + market at module boundary so we can pin call shape
 * and the resulting `UnsignedSolanaTx` contents without touching mainnet.
 */

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const FAKE_BLOCKHASH = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";
const WALLET_KP = Keypair.generate();
const WALLET = WALLET_KP.publicKey.toBase58();
const FAKE_MARKET_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"; // Kamino mainnet program
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FAKE_RESERVE_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_USER_METADATA_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_USER_LUT_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_OBLIGATION_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_KAMINO_PROGRAM = Keypair.generate().publicKey;

const connectionStub = {
  getAccountInfo: vi.fn(),
};

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

const fakeMarket = {
  programId: FAKE_PROGRAM_ID,
  getAddress: () => FAKE_MARKET_ADDR,
  getUserMetadata: vi.fn(),
  getReserveByMint: vi.fn(),
};

vi.mock("../src/modules/solana/kamino.js", () => ({
  loadKaminoMainMarket: async () => fakeMarket,
  KAMINO_MAIN_MARKET: FAKE_MARKET_ADDR,
  RECENT_SLOT_DURATION_MS: 410,
  createKaminoRpc: () => ({}),
}));

const getUserLutAddressAndSetupIxsMock = vi.fn();
const initObligationMock = vi.fn();
const KaminoActionBuildDepositTxnsMock = vi.fn();
const KaminoActionActionToIxsMock = vi.fn();
const KaminoObligationLoadMock = vi.fn();
const VanillaObligationToPdaMock = vi.fn();

vi.mock("@kamino-finance/klend-sdk", () => {
  class VanillaObligation {
    constructor(public programId: unknown) {}
    toArgs() {
      return {
        tag: 0,
        id: 0,
        seed1: "11111111111111111111111111111111",
        seed2: "11111111111111111111111111111111",
      };
    }
    toPda(market: unknown, user: unknown) {
      return VanillaObligationToPdaMock(market, user);
    }
  }
  class KaminoObligation {
    static load(...args: unknown[]) {
      return KaminoObligationLoadMock(...args);
    }
  }
  class KaminoAction {
    static buildDepositTxns(...args: unknown[]) {
      return KaminoActionBuildDepositTxnsMock(...args);
    }
    static actionToIxs(...args: unknown[]) {
      return KaminoActionActionToIxsMock(...args);
    }
  }
  return {
    KaminoMarket: class {},
    KaminoAction,
    KaminoObligation,
    VanillaObligation,
    initObligation: (...args: unknown[]) => initObligationMock(...args),
    getUserLutAddressAndSetupIxs: (...args: unknown[]) =>
      getUserLutAddressAndSetupIxsMock(...args),
  };
});

// AccountRole used by kit-bridge — mock just enough for the tests.
vi.mock("@solana/kit", () => ({
  createNoopSigner: (addr: unknown) => ({ address: addr }),
  address: (s: unknown) => s,
  none: () => ({ __option: "none" }),
  some: (v: unknown) => ({ __option: "some", value: v }),
  isSome: (v: { __option?: string }) => v.__option === "some",
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
}));

vi.mock("@solana/sysvars", () => ({
  SYSVAR_RENT_ADDRESS: "SysvarRent111111111111111111111111111111111",
}));

vi.mock("@solana-program/system", () => ({
  SYSTEM_PROGRAM_ADDRESS: "11111111111111111111111111111111",
}));

async function setNoncePresent(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: FAKE_BLOCKHASH,
    authority: WALLET_KP.publicKey,
  });
}

async function setNonceMissing(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function fakeKitInstruction(label: string) {
  return {
    programAddress: FAKE_KAMINO_PROGRAM.toBase58(),
    accounts: [
      {
        address: WALLET_KP.publicKey.toBase58(),
        role: 3, // WRITABLE_SIGNER
      },
    ],
    data: new Uint8Array([0xab, 0xcd, label.charCodeAt(0)]),
  };
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  fakeMarket.getUserMetadata.mockReset();
  fakeMarket.getReserveByMint.mockReset();
  getUserLutAddressAndSetupIxsMock.mockReset();
  initObligationMock.mockReset();
  KaminoActionBuildDepositTxnsMock.mockReset();
  KaminoActionActionToIxsMock.mockReset();
  KaminoObligationLoadMock.mockReset();
  VanillaObligationToPdaMock.mockReset();
  VanillaObligationToPdaMock.mockResolvedValue(FAKE_OBLIGATION_ADDR);

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildKaminoInitUser — happy path", () => {
  it("composes nonceAdvance + createLut + initUserMetadata + initObligation, in order", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    getUserLutAddressAndSetupIxsMock.mockResolvedValue([
      FAKE_USER_LUT_ADDR,
      [[fakeKitInstruction("L"), fakeKitInstruction("U")]],
    ]);
    initObligationMock.mockReturnValue(fakeKitInstruction("O"));

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const prepared = await buildKaminoInitUser({ wallet: WALLET });

    expect(prepared.action).toBe("kamino_init_user");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("Kamino setup");
    expect(prepared.decoded.functionName).toBe("kamino.initUser");
    expect(prepared.decoded.args.wallet).toBe(WALLET);
    expect(prepared.decoded.args.userMetadata).toBe(FAKE_USER_METADATA_ADDR);
    expect(prepared.decoded.args.userLookupTable).toBe(FAKE_USER_LUT_ADDR);
    expect(prepared.decoded.args.obligation).toBe(FAKE_OBLIGATION_ADDR);

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");

    // ix[0] = SystemProgram.nonceAdvance, tag 04000000
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");

    // ix[1..3] = the three Kamino kit ixs converted to web3.js v1
    expect(draft.instructions.length).toBe(4);
    expect(draft.instructions[1].programId.toBase58()).toBe(
      FAKE_KAMINO_PROGRAM.toBase58(),
    );
    expect(draft.instructions[1].data.toString("hex")).toBe(
      "abcd" + Buffer.from("L").toString("hex"),
    );
    expect(draft.instructions[2].data.toString("hex")).toBe(
      "abcd" + Buffer.from("U").toString("hex"),
    );
    expect(draft.instructions[3].data.toString("hex")).toBe(
      "abcd" + Buffer.from("O").toString("hex"),
    );

    expect(draft.meta.action).toBe("kamino_init_user");
    expect(draft.meta.nonce?.value).toBe(FAKE_BLOCKHASH);
  });

  it("calls getUserLutAddressAndSetupIxs with withExtendLut=false (no LUT activation lag)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    getUserLutAddressAndSetupIxsMock.mockResolvedValue([
      FAKE_USER_LUT_ADDR,
      [[fakeKitInstruction("L"), fakeKitInstruction("U")]],
    ]);
    initObligationMock.mockReturnValue(fakeKitInstruction("O"));

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await buildKaminoInitUser({ wallet: WALLET });

    expect(getUserLutAddressAndSetupIxsMock).toHaveBeenCalledTimes(1);
    const callArgs = getUserLutAddressAndSetupIxsMock.mock.calls[0];
    // Args: (kaminoMarket, owner, referrer, withExtendLut)
    expect(callArgs[3]).toBe(false);
  });
});

describe("buildKaminoInitUser — rejection paths", () => {
  it("refuses re-init when userMetadata already exists", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR }, // non-null state = already initialized
    ]);

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(buildKaminoInitUser({ wallet: WALLET })).rejects.toThrow(
      /already has Kamino userMetadata/,
    );
  });

  it("throws nonce-required when wallet has no durable-nonce account", async () => {
    await setNonceMissing();
    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(buildKaminoInitUser({ wallet: WALLET })).rejects.toThrow(
      /nonce account not initialized/i,
    );
  });
});

describe("buildKaminoSupply — happy path", () => {
  function setupSupplyHappyPath() {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    fakeMarket.getReserveByMint.mockReturnValue({
      address: FAKE_RESERVE_ADDR,
      state: { liquidity: { mintDecimals: 6n } },
      getTokenSymbol: () => "USDC",
    });
    KaminoObligationLoadMock.mockResolvedValue({ obligationAddress: FAKE_OBLIGATION_ADDR });
    const fakeAction = { __isFakeKaminoAction: true };
    KaminoActionBuildDepositTxnsMock.mockResolvedValue(fakeAction);
    KaminoActionActionToIxsMock.mockReturnValue([
      fakeKitInstruction("D"), // single deposit ix for simplicity
    ]);
  }

  it("builds the supply tx with nonceAdvance + the SDK's ix list, decoded args populated", async () => {
    await setNoncePresent();
    setupSupplyHappyPath();

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const prepared = await buildKaminoSupply({
      wallet: WALLET,
      mint: USDC_MINT,
      amount: "100",
    });

    expect(prepared.action).toBe("kamino_supply");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("100 USDC");
    expect(prepared.description).toContain("Kamino supply");
    expect(prepared.decoded.functionName).toBe("kamino.deposit");
    expect(prepared.decoded.args.amount).toBe("100");
    expect(prepared.decoded.args.amountBaseUnits).toBe("100000000"); // 100 * 1e6
    expect(prepared.decoded.args.symbol).toBe("USDC");
    expect(prepared.decoded.args.mint).toBe(USDC_MINT);
    expect(prepared.decoded.args.reserve).toBe(FAKE_RESERVE_ADDR);
    expect(prepared.decoded.args.obligation).toBe(FAKE_OBLIGATION_ADDR);

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    expect(draft.instructions.length).toBe(2); // nonceAdvance + deposit
    expect(draft.meta.action).toBe("kamino_supply");
  });

  it("passes skipInitialization=true to buildDepositTxns (we don't auto-init in supply)", async () => {
    await setNoncePresent();
    setupSupplyHappyPath();

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" });

    expect(KaminoActionBuildDepositTxnsMock).toHaveBeenCalledTimes(1);
    const args = KaminoActionBuildDepositTxnsMock.mock.calls[0];
    // signature: (market, amount, mint, owner, obligation, useV2Ixs,
    //             scopeRefreshConfig, extraComputeBudget, includeAtaIxs,
    //             requestElevationGroup, initUserMetadata, referrer, currentSlot)
    expect(args[5]).toBe(true); // useV2Ixs
    expect(args[10]).toEqual({
      skipInitialization: true,
      skipLutCreation: true,
    });
  });
});

describe("buildKaminoSupply — rejection paths", () => {
  it("refuses when userMetadata is missing (user hasn't init'd)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    fakeMarket.getReserveByMint.mockReturnValue({
      address: FAKE_RESERVE_ADDR,
      state: { liquidity: { mintDecimals: 6n } },
      getTokenSymbol: () => "USDC",
    });

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino userMetadata.*prepare_kamino_init_user/);
  });

  it("refuses when obligation is missing (partial init state)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    fakeMarket.getReserveByMint.mockReturnValue({
      address: FAKE_RESERVE_ADDR,
      state: { liquidity: { mintDecimals: 6n } },
      getTokenSymbol: () => "USDC",
    });
    KaminoObligationLoadMock.mockResolvedValue(null);

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino obligation.*prepare_kamino_init_user/);
  });

  it("refuses when the mint isn't listed on Kamino's main market", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    fakeMarket.getReserveByMint.mockReturnValue(undefined);

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/not listed on Kamino's main market/);
  });

  it("rejects bad amounts", async () => {
    await setNoncePresent();
    fakeMarket.getReserveByMint.mockReturnValue({
      address: FAKE_RESERVE_ADDR,
      state: { liquidity: { mintDecimals: 6n } },
      getTokenSymbol: () => "USDC",
    });

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "0" }),
    ).rejects.toThrow(/Invalid amount/);
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "-1" }),
    ).rejects.toThrow(/Invalid amount/);
  });
});

describe("renderSolanaAgentTaskBlock — kamino actions", () => {
  it("treats kamino_init_user as blind-sign with the right summary shape", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "kamino_init_user" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "Kamino setup: init userMetadata + obligation",
      decoded: {
        functionName: "kamino.initUser",
        args: { wallet: WALLET, userMetadata: FAKE_USER_METADATA_ADDR },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain(expectedHash);
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("Kamino account init");
    expect(block).toContain("durable-nonce-protected");
  });

  it("treats kamino_supply as blind-sign with the right summary shape", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "kamino_supply" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "Kamino supply: 100 USDC",
      decoded: {
        functionName: "kamino.deposit",
        args: { wallet: WALLET, amount: "100", symbol: "USDC" },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("Kamino supply");
  });
});
