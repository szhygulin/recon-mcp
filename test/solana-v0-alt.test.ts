import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedMessage,
} from "@solana/web3.js";
import {
  issueSolanaDraftHandle,
  pinSolanaHandle,
  retireSolanaHandle,
  type SolanaV0Draft,
  type SolanaDraftMeta,
} from "../src/signing/solana-tx-store.js";
import {
  resolveAddressLookupTables,
  clearAltCache,
} from "../src/modules/solana/alt.js";
import { solanaLedgerMessageHash } from "../src/signing/verification.js";

/**
 * Milestone A: v0 + ALT foundation. Tests that
 *   (1) the draft store's discriminated union round-trips v0 drafts through
 *       `issueSolanaDraftHandle` → `pinSolanaHandle`,
 *   (2) the resulting bytes are a well-formed VersionedMessage (first byte
 *       0x80, VersionedMessage.deserialize accepts),
 *   (3) `meta.nonce.value` still drives the blockhash/nonce field for v0,
 *   (4) the ALT resolver fetches + caches per-process, and throws cleanly
 *       when an ALT is missing,
 *   (5) `solanaLedgerMessageHash` is message-version-agnostic — sha256 over
 *       raw bytes, unchanged by v0.
 */

const WALLET = Keypair.generate().publicKey;

function sampleV0Ix(to: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: WALLET,
    toPubkey: to,
    lamports: 1,
  });
}

function sampleMeta(nonceValue: string): SolanaDraftMeta {
  return {
    action: "native_send",
    from: WALLET.toBase58(),
    description: "v0 draft round-trip",
    decoded: {
      functionName: "solana.system.transfer",
      args: { amount: "1 lamport" },
    },
    nonce: {
      account: Keypair.generate().publicKey.toBase58(),
      authority: WALLET.toBase58(),
      value: nonceValue,
    },
  };
}

describe("v0 draft pin path", () => {
  const nonceValue = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";

  it("pins a v0 draft and produces a VersionedMessage (0x80 prefix) that round-trips via VersionedMessage.deserialize", () => {
    const recipient = Keypair.generate().publicKey;
    const draft: SolanaV0Draft = {
      kind: "v0",
      payerKey: WALLET,
      instructions: [sampleV0Ix(recipient)],
      addressLookupTableAccounts: [],
      meta: sampleMeta(nonceValue),
    };
    const { handle } = issueSolanaDraftHandle(draft);
    const pinned = pinSolanaHandle(handle, nonceValue);
    const bytes = Buffer.from(pinned.messageBase64, "base64");
    // 0x80 = v0 prefix; 0x00 = legacy (unset). The high bit is the marker.
    expect(bytes[0] & 0x80).toBe(0x80);
    // Round-trip via VersionedMessage.deserialize — must succeed and carry
    // the same blockhash we pinned.
    const reparsed = VersionedMessage.deserialize(bytes);
    expect(reparsed.version).toBe(0);
    expect(reparsed.recentBlockhash).toBe(nonceValue);
    // Static account keys include our wallet + recipient + system program.
    const staticKeys = (reparsed as MessageV0).staticAccountKeys.map((k) =>
      k.toBase58(),
    );
    expect(staticKeys).toContain(WALLET.toBase58());
    expect(staticKeys).toContain(recipient.toBase58());
    retireSolanaHandle(handle);
  });

  it("refuses to pin a v0 draft when meta.nonce.value disagrees with freshBlockhash (consistency guard)", () => {
    const draft: SolanaV0Draft = {
      kind: "v0",
      payerKey: WALLET,
      instructions: [sampleV0Ix(Keypair.generate().publicKey)],
      addressLookupTableAccounts: [],
      meta: sampleMeta(nonceValue),
    };
    const { handle } = issueSolanaDraftHandle(draft);
    // Pass a different value — the guard (same logic as legacy) must fire.
    expect(() =>
      pinSolanaHandle(
        handle,
        "7kL9TYNkpYYvECe6pTqFE3B6PGsoRftgC6YJ7Lm1XgYs",
      ),
    ).toThrow(/pinSolanaHandle consistency check failed/);
    retireSolanaHandle(handle);
  });

  it("solanaLedgerMessageHash is message-version-agnostic — sha256(bytes)→base58 is identical for v0 and legacy", () => {
    // The Ledger Solana app hashes exactly what it receives; the version
    // prefix is part of the signed bytes. Sanity-check that our server-side
    // hash function isn't accidentally legacy-specific.
    const v0Bytes = Buffer.from([0x80, 0x01, 0x02, 0x03]);
    const legacyBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const v0Hash = solanaLedgerMessageHash(v0Bytes.toString("base64"));
    const legacyHash = solanaLedgerMessageHash(legacyBytes.toString("base64"));
    // Both are valid base58 pubkey-length strings (32-byte sha256 → base58).
    expect(v0Hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(legacyHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(v0Hash).not.toBe(legacyHash);
  });
});

describe("resolveAddressLookupTables", () => {
  let getAltMock: ReturnType<typeof vi.fn>;
  let connStub: Connection;

  beforeEach(() => {
    getAltMock = vi.fn();
    connStub = { getAddressLookupTable: getAltMock } as unknown as Connection;
    clearAltCache();
  });

  afterEach(() => {
    clearAltCache();
  });

  it("fetches each ALT once, caches by pubkey base58, and returns them in request order", async () => {
    const altA = new PublicKey("3uYn8vWyFNt42zcDiBvUtJEL6dFTAtzRLPMe7jyKmqiA");
    const altB = new PublicKey("4xvR8Yw1HfZVNbBvF1RxtEnQKDLkzqGMcjbxN9j2pmTL");

    // Mock returns — wrapping in RpcResponseAndContext shape with `value` field.
    const altAAccount = new AddressLookupTableAccount({
      key: altA,
      state: { deactivationSlot: BigInt(0), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [] },
    });
    const altBAccount = new AddressLookupTableAccount({
      key: altB,
      state: { deactivationSlot: BigInt(0), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [] },
    });
    getAltMock
      .mockResolvedValueOnce({ value: altAAccount, context: { slot: 1 } })
      .mockResolvedValueOnce({ value: altBAccount, context: { slot: 1 } });

    const result = await resolveAddressLookupTables(connStub, [altA, altB]);
    expect(result).toHaveLength(2);
    expect(result[0].key.toBase58()).toBe(altA.toBase58());
    expect(result[1].key.toBase58()).toBe(altB.toBase58());
    expect(getAltMock).toHaveBeenCalledTimes(2);

    // Second call with the same pubkeys hits the cache — NO additional RPC calls.
    const cached = await resolveAddressLookupTables(connStub, [altA, altB]);
    expect(cached[0]).toBe(result[0]); // Same object reference — cache hit.
    expect(getAltMock).toHaveBeenCalledTimes(2); // Unchanged.
  });

  it("throws a clear error when an ALT doesn't exist on chain (unverifiable tx)", async () => {
    const missing = new PublicKey("3uYn8vWyFNt42zcDiBvUtJEL6dFTAtzRLPMe7jyKmqiA");
    getAltMock.mockResolvedValueOnce({ value: null, context: { slot: 1 } });

    await expect(
      resolveAddressLookupTables(connStub, [missing]),
    ).rejects.toThrow(/does not exist on chain/);
  });

  it("is a no-op for an empty ALT list (skips the RPC round-trip)", async () => {
    const result = await resolveAddressLookupTables(connStub, []);
    expect(result).toEqual([]);
    expect(getAltMock).not.toHaveBeenCalled();
  });
});
