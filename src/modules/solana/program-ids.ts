/**
 * Known Solana program IDs + well-known stake pool accounts.
 *
 * Every program address below was verified live against Solana mainnet RPC
 * (`getAccountInfo` → `executable: true`, `owner: BPFLoaderUpgradeable`) on
 * 2026-04-23. The native programs (System, Token, Stake, etc.) are
 * canonical and don't move; third-party programs (Jupiter, Marinade, etc.)
 * could in theory redeploy, so the "Live program ID spot-check" step in
 * the PR verifies each address again at commit time.
 */

export type ProgramKind =
  | "system"
  | "token"
  | "token-2022"
  | "ata"
  | "stake"
  | "stake-pool"
  | "lst"
  | "aggregator"
  | "amm"
  | "compute-budget";

export interface KnownProgram {
  name: string;
  kind: ProgramKind;
}

/** Map from program ID to human-readable metadata. */
export const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
  // Native programs — canonical.
  "11111111111111111111111111111111": { name: "System", kind: "system" },
  Stake11111111111111111111111111111111111111: { name: "Stake", kind: "stake" },
  ComputeBudget111111111111111111111111111111: {
    name: "ComputeBudget",
    kind: "compute-budget",
  },

  // SPL programs.
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: { name: "SPL Token", kind: "token" },
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: {
    name: "Token-2022",
    kind: "token-2022",
  },
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: {
    name: "Associated Token Account",
    kind: "ata",
  },
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: {
    name: "SPL Stake Pool",
    kind: "stake-pool",
  },

  // DeFi — verified via getAccountInfo live (executable + BPFLoaderUpgradeable).
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: { name: "Jupiter V6", kind: "aggregator" },
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: { name: "Marinade", kind: "lst" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    name: "Raydium AMM V4",
    kind: "amm",
  },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    name: "Orca Whirlpools",
    kind: "amm",
  },
};

/**
 * Well-known stake pool ACCOUNTS (not programs). Jito doesn't operate its
 * own program — it deploys an instance of the generic SPL Stake Pool
 * program (`SPoo1Ku8...`) at a specific pool account. When we see an
 * instruction to `SPoo1Ku8...` in history, we check the first account in
 * its accounts list against this map to identify which stake pool it's
 * interacting with.
 *
 * `tokenMint` is the LST mint minted by the pool (jitoSOL, stSOL, etc.).
 * Matching the mint in the tx's token balance deltas confirms the pool.
 */
export const KNOWN_STAKE_POOLS: Record<
  string,
  { name: string; tokenMint: string }
> = {
  Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb: {
    name: "Jito",
    tokenMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  },
};

/**
 * Reverse map from LST mint to stake pool name. Used when the decoder
 * spots a balance delta in a known LST mint but the stake pool account
 * wasn't directly exposed in the instruction's accounts (e.g., when
 * interacting via an aggregator).
 */
export const LST_MINT_TO_POOL: Record<string, string> = Object.fromEntries(
  Object.values(KNOWN_STAKE_POOLS).map((p) => [p.tokenMint, p.name]),
);

export function lookupProgram(programId: string): KnownProgram | undefined {
  return KNOWN_PROGRAMS[programId];
}
