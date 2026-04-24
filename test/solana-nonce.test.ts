import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
} from "@solana/web3.js";

/**
 * Tests for the durable-nonce helpers in `src/modules/solana/nonce.ts` and
 * the two new action builders (`buildSolanaNonceInit` / `buildSolanaNonceClose`)
 * in `src/modules/solana/actions.ts`. Mocks the Solana Connection so we
 * never touch the network.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const WALLET_PUBKEY = WALLET_KEYPAIR.publicKey;

const connectionStub = {
  getAccountInfo: vi.fn(),
  getBalance: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

beforeEach(() => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getBalance.mockReset();
  connectionStub.getMinimumBalanceForRentExemption.mockReset();
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(1_500_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveNonceAccountAddress", () => {
  it("returns a stable, deterministic PDA for a given base pubkey + versioned seed", async () => {
    const { deriveNonceAccountAddress, NONCE_SEED } = await import(
      "../src/modules/solana/nonce.js"
    );
    const a = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const b = await deriveNonceAccountAddress(WALLET_PUBKEY);
    expect(a.toBase58()).toBe(b.toBase58());
    // Same derivation as web3.js's canonical `createWithSeed` — if this test
    // flags on any refactor that changes the derivation, the on-chain
    // account would be stranded (old seed) and users would see "nonce not
    // initialized" after upgrade. That would require a v2 seed migration.
    const canonical = await PublicKey.createWithSeed(
      WALLET_PUBKEY,
      NONCE_SEED,
      SystemProgram.programId,
    );
    expect(a.toBase58()).toBe(canonical.toBase58());
  });

  it("produces different addresses for different base wallets", async () => {
    const { deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const other = Keypair.generate().publicKey;
    const a = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const b = await deriveNonceAccountAddress(other);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

/**
 * Serialize a valid NonceAccount data buffer (80 bytes: version u32 + state
 * u32 + authority 32b + nonce 32b + feeCalculator u64). Lets us exercise
 * the real `getNonceAccountValue` parser end-to-end against the mocked
 * getAccountInfo, instead of mocking getNonceAccountValue itself.
 */
function buildNonceAccountData(
  authority: PublicKey,
  nonceBytes: Uint8Array,
): Buffer {
  const buf = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
  let o = 0;
  buf.writeUInt32LE(0, o); o += 4; // version
  buf.writeUInt32LE(1, o); o += 4; // state = initialized
  authority.toBuffer().copy(buf, o); o += 32;
  Buffer.from(nonceBytes).copy(buf, o); o += 32;
  buf.writeBigUInt64LE(5000n, o); // lamportsPerSignature
  return buf;
}

describe("getNonceAccountValue", () => {
  it("returns null when the account doesn't exist on chain", async () => {
    connectionStub.getAccountInfo.mockResolvedValue(null);
    const { getNonceAccountValue, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const result = await getNonceAccountValue(connectionStub as never, pda);
    expect(result).toBeNull();
  });

  it("parses nonce + authority when the account exists", async () => {
    const nonceBytes = Keypair.generate().publicKey.toBuffer();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: buildNonceAccountData(WALLET_PUBKEY, nonceBytes),
      owner: SystemProgram.programId,
      lamports: 1_500_000,
      executable: false,
      rentEpoch: 0,
    });
    const { getNonceAccountValue, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const result = await getNonceAccountValue(connectionStub as never, pda);
    expect(result).not.toBeNull();
    expect(result!.authority.toBase58()).toBe(WALLET);
    // The parsed nonce is base58(nonceBytes).
    expect(result!.nonce).toBe(new PublicKey(nonceBytes).toBase58());
  });

  it("refuses to treat a non-SystemProgram-owned account as a nonce account", async () => {
    // Defense against confused-deputy: if an attacker places a lookalike
    // account at the nonce PDA owned by a different program, we must NOT
    // treat its bytes as nonce data. The PDA is derived with programId =
    // SystemProgram, so any other owner means "not a nonce".
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(NONCE_ACCOUNT_LENGTH),
      owner: Keypair.generate().publicKey, // random non-SystemProgram owner
      lamports: 1_500_000,
      executable: false,
      rentEpoch: 0,
    });
    const { getNonceAccountValue, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    await expect(
      getNonceAccountValue(connectionStub as never, pda),
    ).rejects.toThrow(/owned by .* not SystemProgram/);
  });
});

describe("buildAdvanceNonceIx", () => {
  it("emits the canonical Agave-compatible AdvanceNonceAccount instruction", async () => {
    const { buildAdvanceNonceIx, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const ix = buildAdvanceNonceIx(pda, WALLET_PUBKEY);
    // ProgramId: SystemProgram.
    expect(ix.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    // Accounts[0] = nonce account, [1] = SysvarRecentBlockhashes, [2] = authority.
    expect(ix.keys[0].pubkey.toBase58()).toBe(pda.toBase58());
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(
      "SysvarRecentB1ockHashes11111111111111111111",
    );
    expect(ix.keys[2].pubkey.toBase58()).toBe(WALLET);
    expect(ix.keys[2].isSigner).toBe(true);
    // Instruction data: 4-byte u32 LE tag 4 = AdvanceNonceAccount.
    expect(ix.data.toString("hex")).toBe("04000000");
  });
});

describe("buildInitNonceIxs", () => {
  it("emits createAccountWithSeed + nonceInitialize in the right order", async () => {
    const { buildInitNonceIxs, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const ixs = buildInitNonceIxs(WALLET_PUBKEY, pda, 1_500_000);
    expect(ixs).toHaveLength(2);
    // ix[0] = createAccountWithSeed — tag 3 in System-Program instruction space.
    expect(ixs[0].programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ixs[0].data.readUInt32LE(0)).toBe(3);
    // ix[1] = nonceInitialize — tag 6.
    expect(ixs[1].programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ixs[1].data.readUInt32LE(0)).toBe(6);
  });
});

describe("buildCloseNonceIxs", () => {
  it("emits nonceAdvance + nonceWithdraw for self-protecting teardown", async () => {
    const { buildCloseNonceIxs, deriveNonceAccountAddress } = await import(
      "../src/modules/solana/nonce.js"
    );
    const pda = await deriveNonceAccountAddress(WALLET_PUBKEY);
    const balance = 1_500_000;
    const ixs = buildCloseNonceIxs(pda, WALLET_PUBKEY, WALLET_PUBKEY, balance);
    expect(ixs).toHaveLength(2);
    // ix[0] = nonceAdvance, same as every send. Protects the close itself.
    expect(ixs[0].data.toString("hex")).toBe("04000000");
    // ix[1] = nonceWithdraw — tag 5.
    expect(ixs[1].programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ixs[1].data.readUInt32LE(0)).toBe(5);
    // The withdraw amount is encoded as u64 LE at offset 4.
    expect(ixs[1].data.readBigUInt64LE(4)).toBe(BigInt(balance));
  });
});

describe("buildSolanaNonceInit", () => {
  it("builds a two-instruction tx and refuses if the account already exists", async () => {
    const { buildSolanaNonceInit } = await import(
      "../src/modules/solana/actions.js"
    );
    // Happy path: account doesn't exist yet.
    connectionStub.getAccountInfo.mockResolvedValueOnce(null);
    connectionStub.getBalance.mockResolvedValue(10_000_000);

    const tx = await buildSolanaNonceInit({ wallet: WALLET });
    expect(tx.action).toBe("nonce_init");
    expect(tx.rentLamports).toBe(1_500_000);
    expect(tx.nonceAccount).toBeDefined();
    expect(tx.decoded.functionName).toBe("solana.system.createNonceAccount");
    expect(tx.decoded.args.authority).toBe(WALLET);

    // Refusal path: account already exists.
    connectionStub.getAccountInfo.mockResolvedValueOnce({
      data: Buffer.alloc(NONCE_ACCOUNT_LENGTH),
      owner: SystemProgram.programId,
      lamports: 1_500_000,
      executable: false,
      rentEpoch: 0,
    });
    await expect(buildSolanaNonceInit({ wallet: WALLET })).rejects.toThrow(
      /already exists/,
    );
  });

  it("refuses when the wallet can't cover rent + fee", async () => {
    const { buildSolanaNonceInit } = await import(
      "../src/modules/solana/actions.js"
    );
    connectionStub.getAccountInfo.mockResolvedValueOnce(null);
    // Balance below rent + fee.
    connectionStub.getBalance.mockResolvedValue(100_000);
    await expect(buildSolanaNonceInit({ wallet: WALLET })).rejects.toThrow(
      /Insufficient SOL to init nonce/,
    );
  });
});

describe("buildSolanaNonceClose", () => {
  it("builds a withdraw tx using the current on-chain balance", async () => {
    // Mock getNonceAccountValue via getAccountInfo returning a nonce.
    const nonceBytes = Keypair.generate().publicKey.toBuffer();
    const onChainBalance = 1_600_000; // more than rent-exempt min
    const infoForNonceCheck = {
      data: buildNonceAccountData(WALLET_PUBKEY, nonceBytes),
      owner: SystemProgram.programId,
      lamports: onChainBalance,
      executable: false,
      rentEpoch: 0,
    };
    // buildSolanaNonceClose calls:
    //   1. getNonceAccountValue → internally getAccountInfo(pda) → nonce info
    //   2. getAccountInfo(pda) directly, to read balance
    connectionStub.getAccountInfo
      .mockResolvedValueOnce(infoForNonceCheck)
      .mockResolvedValueOnce(infoForNonceCheck);

    const { buildSolanaNonceClose } = await import(
      "../src/modules/solana/actions.js"
    );
    const tx = await buildSolanaNonceClose({ wallet: WALLET });
    expect(tx.action).toBe("nonce_close");
    expect(tx.decoded.args.withdrawLamports).toBe(String(onChainBalance));
    expect(tx.decoded.args.destination).toBe(WALLET);
  });

  it("refuses when there's no nonce account to close", async () => {
    connectionStub.getAccountInfo.mockResolvedValue(null);
    const { buildSolanaNonceClose } = await import(
      "../src/modules/solana/actions.js"
    );
    await expect(buildSolanaNonceClose({ wallet: WALLET })).rejects.toThrow(
      /No nonce account to close/,
    );
  });
});

describe("NonceAccount byte-format compatibility", () => {
  it("is round-trip-compatible with web3.js's NonceAccount.fromAccountData", async () => {
    // Sanity-check the test helper. If web3.js ever changes the layout,
    // this fires and tells us to update buildNonceAccountData before we
    // chase ghost failures in other suites that rely on the format.
    const nonceBytes = Keypair.generate().publicKey.toBuffer();
    const buf = buildNonceAccountData(WALLET_PUBKEY, nonceBytes);
    const parsed = NonceAccount.fromAccountData(buf);
    expect(parsed.authorizedPubkey.toBase58()).toBe(WALLET);
    expect(parsed.nonce).toBe(new PublicKey(nonceBytes).toBase58());
  });
});
