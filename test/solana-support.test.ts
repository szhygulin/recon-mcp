import { describe, it, expect } from "vitest";
import {
  ALL_CHAINS,
  SUPPORTED_CHAINS,
  SUPPORTED_NON_EVM_CHAINS,
  isEvmChain,
} from "../src/types/index.js";
import { isSolanaAddress, SOLANA_TOKENS, SOL_DECIMALS } from "../src/config/solana.js";
import { KNOWN_PROGRAMS, KNOWN_STAKE_POOLS } from "../src/modules/solana/program-ids.js";
import { assertSolanaAddress } from "../src/modules/solana/address.js";

/**
 * Chain-registration invariants for Solana — parallel to
 * optimism-chain-support.test.ts. Locks the registration down so a refactor
 * that drops Solana from one of the constants fails loud.
 */
describe("Solana chain registration", () => {
  it("is listed in SUPPORTED_NON_EVM_CHAINS", () => {
    expect(SUPPORTED_NON_EVM_CHAINS).toContain("solana");
  });

  it("is in ALL_CHAINS but NOT in SUPPORTED_CHAINS (non-EVM)", () => {
    expect(ALL_CHAINS).toContain("solana");
    expect(SUPPORTED_CHAINS as readonly string[]).not.toContain("solana");
  });

  it("isEvmChain returns false for solana", () => {
    expect(isEvmChain("solana")).toBe(false);
  });

  it("SOL native decimals are 9 (lamports per SOL = 10^9)", () => {
    expect(SOL_DECIMALS).toBe(9);
  });
});

describe("isSolanaAddress shape check", () => {
  it("accepts canonical Solana mainnet addresses", () => {
    // Jupiter V6 program — 43 chars, base58.
    expect(isSolanaAddress("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toBe(true);
    // USDC mint — 44 chars.
    expect(isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    // All 1's = System Program (43 chars, edge case with leading 1's).
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(false); // 32 chars — too short
  });

  it("rejects EVM and TRON addresses", () => {
    expect(isSolanaAddress("0x1234567890123456789012345678901234567890")).toBe(false);
    expect(isSolanaAddress("TXYZabcdefghijkmnopqrstuvwxyz23456")).toBe(false);
  });

  it("rejects garbage and empty strings", () => {
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress("too-short")).toBe(false);
    // Wrong alphabet (0, O, I, l not in base58).
    expect(isSolanaAddress("0".repeat(44))).toBe(false);
    expect(isSolanaAddress("O".repeat(44))).toBe(false);
  });

  it("rejects strings outside 43-44 char range", () => {
    expect(isSolanaAddress("1".repeat(42))).toBe(false);
    expect(isSolanaAddress("1".repeat(45))).toBe(false);
  });
});

describe("assertSolanaAddress strict validator", () => {
  it("returns a PublicKey for a valid address", () => {
    const pk = assertSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(pk.toBase58()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("throws on EVM address", () => {
    expect(() => assertSolanaAddress("0x1234567890123456789012345678901234567890")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => assertSolanaAddress("")).toThrow();
  });
});

describe("Known program + token registries", () => {
  it("includes the six essential programs (System, SPL Token, Token-2022, ATA, Stake, Compute Budget)", () => {
    expect(KNOWN_PROGRAMS["11111111111111111111111111111111"]?.kind).toBe("system");
    expect(KNOWN_PROGRAMS.TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA?.kind).toBe("token");
    expect(KNOWN_PROGRAMS.TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb?.kind).toBe("token-2022");
    expect(KNOWN_PROGRAMS.ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL?.kind).toBe("ata");
    expect(KNOWN_PROGRAMS.Stake11111111111111111111111111111111111111?.kind).toBe("stake");
  });

  it("includes Jupiter V6, Marinade, Raydium, Orca, and SPL Stake Pool programs", () => {
    expect(KNOWN_PROGRAMS.JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4?.kind).toBe("aggregator");
    expect(KNOWN_PROGRAMS.MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD?.kind).toBe("lst");
    expect(KNOWN_PROGRAMS["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"]?.kind).toBe("amm");
    expect(KNOWN_PROGRAMS.whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc?.kind).toBe("amm");
    expect(KNOWN_PROGRAMS.SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy?.kind).toBe("stake-pool");
  });

  it("maps Jito stake pool account to the jitoSOL mint", () => {
    const jito = KNOWN_STAKE_POOLS.Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb;
    expect(jito?.name).toBe("Jito");
    expect(jito?.tokenMint).toBe("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
  });

  it("SOLANA_TOKENS contains the expected canonical mints", () => {
    expect(SOLANA_TOKENS.USDC).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(SOLANA_TOKENS.USDT).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(SOLANA_TOKENS.jitoSOL).toBe("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
    expect(SOLANA_TOKENS.mSOL).toBe("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
  });
});
