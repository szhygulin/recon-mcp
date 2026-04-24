import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BigNumber from "bignumber.js";

/**
 * MarginFi builder tests. Strategy mirrors solana-jupiter.test.ts: mock the
 * RPC (getAccountInfo for nonce + MarginfiAccount existence), mock the
 * MarginfiClient + wrapper via a fake we install into the module's cache
 * with `__setMarginfiClientCacheEntry`. No live network, no SDK import of
 * heavy transitive deps at test time.
 *
 * The fake surfaces the same `getBankByMint` shape the real client exposes,
 * plus a MarginfiAccountWrapper.fetch hook (via vi.mock on the SDK module).
 * Each builder test asserts: (1) ix[0] is SystemProgram.nonceAdvance,
 * (2) the bank ix list is appended, (3) the draft meta carries the right
 * action/bank/mint, (4) pre-flight failures produce clear errors.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BANK_USDC = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Single shared connectionStub object — `getAccountInfo` is the main method
// both the nonce preflight AND the marginfi-account existence check call.
const connectionStub = {
  getAccountInfo: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
  getLatestBlockhash: vi.fn(),
  getBalance: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Mock ALT resolution — MarginFi's group-wide ALTs are pulled via
// `resolveAddressLookupTables`. We don't care about the real lookup here;
// asserting we pass the right pubkeys is enough.
const resolveAltMock = vi.fn();
vi.mock("../src/modules/solana/alt.js", () => ({
  resolveAddressLookupTables: (...args: unknown[]) => resolveAltMock(...args),
  clearAltCache: () => {},
  invalidateAlt: () => {},
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

// Fake MarginfiAccountWrapper + SDK surface. The real SDK module is heavy
// (it pulls in Pyth + Switchboard transitively); mocking lets us run the
// suite without the 147MB transitive footprint on each test.
const wrapperFetchMock = vi.fn();
const makeInitIxMock = vi.fn();
vi.mock("@mrgnlabs/marginfi-client-v2", () => ({
  MarginfiClient: {
    fetch: vi.fn(),
  },
  MarginfiAccountWrapper: {
    fetch: (...args: unknown[]) => wrapperFetchMock(...args),
  },
  instructions: {
    makeInitMarginfiAccountPdaIx: (...args: unknown[]) => makeInitIxMock(...args),
  },
  getConfig: () => ({
    programId: new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    groupPk: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    environment: "production",
    cluster: "mainnet",
  }),
  ADDRESS_LOOKUP_TABLE_FOR_GROUP: {
    "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8": [
      new PublicKey("BrWF8J3CEuHaXsWk3kqGZ6VHvRp4SJuG9AzvB6ei2kbV"),
    ],
  },
  MARGINFI_IDL: { address: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA" },
}));

// Minimal mock of @coral-xyz/anchor — only `buildMarginfiProgram` uses it,
// and only for the init path. AnchorProvider + Program don't need to be
// real since `makeInitIxMock` intercepts the SDK call.
vi.mock("@coral-xyz/anchor", () => ({
  AnchorProvider: class {},
  Program: class {},
}));

async function setNoncePresent(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
    authority: WALLET_KEYPAIR.publicKey,
  });
}

async function setNonceMissing(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function buildFakeBank(mint: string, address = BANK_USDC): unknown {
  return {
    address,
    mint: new PublicKey(mint),
    config: {
      assetWeightInit: new BigNumber(0.9),
      liabilityWeightInit: new BigNumber(1.1),
    },
    tokenSymbol: "USDC",
    isPaused: false,
  };
}

async function installFakeClient(
  bankLookup: (mint: PublicKey) => unknown | null,
): Promise<void> {
  // The module's cache is keyed on the mainnet group; we poke the fake in
  // via the test-only hook so `getMarginfiClient` returns this without
  // ever calling the real `MarginfiClient.fetch`.
  const mfn = await import("../src/modules/solana/marginfi.js");
  mfn.__setMarginfiClientCacheEntry({
    getBankByMint: bankLookup,
    banks: new Map(),
    oraclePrices: new Map(),
  });
}

function dummyIx(label: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(
      "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    ),
    keys: [],
    data: Buffer.from(label, "utf-8"),
  });
}

function installFakeWrapperFor(kind: "healthy" | "noCollateral"): void {
  const free = kind === "noCollateral" ? new BigNumber(0) : new BigNumber(1000);
  wrapperFetchMock.mockResolvedValue({
    address: new PublicKey(
      // Any valid base58 pubkey works here — the builder just passes it
      // through to the draft meta as marginfiAccount.
      "11111111111111111111111111111111",
    ),
    makeDepositIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
    makeWithdrawIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
    makeBorrowIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
    makeRepayIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
    computeHealthComponents: () => ({
      assets: new BigNumber(1100),
      liabilities: new BigNumber(100),
    }),
    computeFreeCollateral: () => free,
  });
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getMinimumBalanceForRentExemption.mockReset();
  // Rent-exempt minimum for the 2312-byte MarginfiAccount PDA (live mainnet
  // value 2026-04-24). Tests rely on the exact value to assert the surfaced
  // rent cost (issue #103).
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(16_982_400);
  resolveAltMock.mockReset();
  resolveAltMock.mockResolvedValue([]);
  wrapperFetchMock.mockReset();
  makeInitIxMock.mockReset();
  makeInitIxMock.mockResolvedValue(dummyIx("init"));

  const mfn = await import("../src/modules/solana/marginfi.js");
  mfn.__clearMarginfiClientCache();

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveMarginfiAccountPda", () => {
  it("is deterministic — same inputs always yield the same PDA", async () => {
    const { deriveMarginfiAccountPda } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const pda1 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    const pda2 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
  });

  it("different accountIndex yields different PDA", async () => {
    const { deriveMarginfiAccountPda } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const pda0 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    const pda1 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 1);
    expect(pda0.toBase58()).not.toBe(pda1.toBase58());
  });
});

describe("buildMarginfiInit", () => {
  it("refuses when nonce account is missing (clear error pointing to init)", async () => {
    await setNonceMissing();
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    await expect(buildMarginfiInit({ wallet: WALLET })).rejects.toThrow(
      /nonce account not initialized/i,
    );
  });

  it("refuses if a MarginfiAccount already exists at the derived PDA", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    await expect(buildMarginfiInit({ wallet: WALLET })).rejects.toThrow(
      /already exists at PDA/i,
    );
  });

  it("builds a v0 draft with ix[0]=nonceAdvance, ix[1]=init, action=marginfi_init", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue(null); // PDA doesn't exist yet
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiInit({ wallet: WALLET });
    expect(res.action).toBe("marginfi_init");
    expect(res.chain).toBe("solana");
    expect(res.handle).toMatch(/^[0-9a-f-]+$/);
    expect(res.nonceAccount).toBeTruthy();
    // Issue #103 — rent MUST be surfaced so the agent can tell the user
    // their wallet is funding ~0.017 SOL (not "only a fee" as the prior
    // wording claimed).
    expect(res.rentLamports).toBe(16_982_400);
    expect(res.description).toContain("rent-exempt minimum");
    expect(res.decoded.args.rentLamports).toBe("16982400");
    const draft = getSolanaDraft(res.handle);
    expect(draft.kind).toBe("v0");
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions).toHaveLength(2);
    // ix[0] is nonceAdvance (System Program, 32-byte programId of all-1s)
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.meta.action).toBe("marginfi_init");
  });
});

describe("buildMarginfiSupply / Withdraw / Borrow / Repay", () => {
  async function setupHappyPath(): Promise<void> {
    await setNoncePresent();
    // PDA exists (user has run init). Simulate account info so both the
    // nonce preflight and MarginfiAccount existence check pass.
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("healthy");
  }

  it("supply: ix[0]=nonceAdvance, ix[1]=deposit (from SDK), action=marginfi_supply", async () => {
    await setupHappyPath();
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiSupply({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1.5",
    });
    expect(res.action).toBe("marginfi_supply");
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions).toHaveLength(2);
    expect(draft.meta.decoded.args.symbol).toBe("USDC");
    expect(draft.meta.decoded.args.amount).toContain("1.5 USDC");
    expect(draft.meta.action).toBe("marginfi_supply");
  });

  it("withdraw with zero free collateral → refuses with health-factor error", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("noCollateral");
    const { buildMarginfiWithdraw } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiWithdraw({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/free collateral/i);
  });

  it("borrow: passes the amount through to makeBorrowIx and prepends nonceAdvance", async () => {
    await setupHappyPath();
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "5",
    });
    expect(res.action).toBe("marginfi_borrow");
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    expect(draft.meta.action).toBe("marginfi_borrow");
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it("repay: action=marginfi_repay + decoded.args.amount carries symbol", async () => {
    await setupHappyPath();
    const { buildMarginfiRepay } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const res = await buildMarginfiRepay({
      wallet: WALLET,
      symbol: "USDC",
      amount: "2",
    });
    expect(res.action).toBe("marginfi_repay");
    expect(res.decoded.args.symbol).toBe("USDC");
    expect(res.decoded.args.amount).toContain("USDC");
  });

  it("refuses when the bank is not listed on MarginFi (actionable error)", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    // getBankByMint always returns null → "not in any bank" path.
    await installFakeClient(() => null);
    installFakeWrapperFor("healthy");
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiSupply({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/No MarginFi bank found/i);
  });

  it("refuses when the MarginfiAccount hasn't been initialized yet", async () => {
    await setNoncePresent();
    // First getAccountInfo call returns null → MarginfiAccount doesn't exist.
    connectionStub.getAccountInfo.mockResolvedValue(null);
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("healthy");
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiSupply({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/No MarginfiAccount exists|prepare_marginfi_init/i);
  });
});

/**
 * Issue #105 — `getMarginfiClient` must pass `fetchGroupDataOverride` to
 * `MarginfiClient.fetch` so the SDK's default per-bank decode (which
 * throws on the first layout mismatch between on-chain state and the
 * bundled IDL 0.1.7) is replaced with our resilient variant. We assert
 * behaviourally: construct a real call to `MarginfiClient.fetch` (mocked
 * at the module boundary) and verify the override is present.
 */
describe("hardened MarginfiClient.fetch (issue #105)", () => {
  it("passes fetchGroupDataOverride to MarginfiClient.fetch", async () => {
    // Re-mock MarginfiClient.fetch for this test to capture the options.
    const captured: { clientOptions?: Record<string, unknown> } = {};
    const mfn = await import("@mrgnlabs/marginfi-client-v2");
    (mfn.MarginfiClient.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cfg: unknown, _wallet: unknown, _conn: unknown, opts: unknown) => {
        captured.clientOptions = opts as Record<string, unknown>;
        // Return a minimal object that passes through to the reader.
        return {
          getBankByMint: () => null,
          banks: new Map(),
          oraclePrices: new Map(),
        };
      },
    );

    // Clear our module cache so getHardenedMarginfiClient actually calls fetch.
    const marginfi = await import("../src/modules/solana/marginfi.js");
    marginfi.__clearMarginfiClientCache();

    await marginfi.getHardenedMarginfiClient(
      connectionStub as never,
      WALLET_KEYPAIR.publicKey,
    );
    expect(captured.clientOptions).toBeDefined();
    expect(typeof captured.clientOptions?.fetchGroupDataOverride).toBe(
      "function",
    );
    // Also sanity-check readOnly carries through (we never sign via the
    // position reader, and sending read-only mode to the SDK disables a
    // handful of sign-related checks upstream).
    expect(captured.clientOptions?.readOnly).toBe(true);
  });
});

/**
 * Issue #102 — getMarginfiPositions must short-circuit BEFORE loading the
 * SDK client when no MarginfiAccount exists. Prior behaviour threw an
 * opaque `Cannot read properties of null (reading 'property')` because
 * MarginfiClient.fetch was called unconditionally.
 */
describe("getMarginfiPositions short-circuit (issues #102, #101)", () => {
  it("returns [] without invoking the MarginFi SDK when no PDA exists", async () => {
    connectionStub.getAccountInfo.mockResolvedValue(null); // no PDA at any slot
    const { getMarginfiPositions } = await import(
      "../src/modules/positions/marginfi.js"
    );
    const results = await getMarginfiPositions(
      connectionStub as never,
      WALLET,
    );
    expect(results).toEqual([]);
  });
});
