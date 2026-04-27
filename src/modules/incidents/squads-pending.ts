/**
 * Squads V4 multisig pending-upgrade scanner. Issue #251 / #242 v2.
 *
 * For each entry in `KNOWN_SQUADS_GOVERNED_PROGRAMS`, fetches all
 * Proposals for the multisig and checks whether any are pre-execution
 * (`Active` or `Approved`) AND target `BPFLoaderUpgradeab1e1...` via at
 * least one instruction in the linked `VaultTransaction.message`.
 *
 * Conservative-default (rule 3 of the `rnd` skill): we flag ANY pending
 * vault tx whose `programIdIndex` resolves to the BPF Loader
 * Upgradeable program — regardless of which discriminator (Upgrade /
 * SetAuthority / Close / ExtendProgram). Wrong direction is "we flag a
 * pending SetAuthority alongside an Upgrade" which is operationally
 * safe — still alerts the user that something programmatic is queued
 * against a program they're exposed to. The reverse (narrow filter on
 * Upgrade discriminator only) silently misses if our discriminator
 * assumption is wrong.
 *
 * Empirical references (see issue #251 comment for the full probe):
 *   - Squads V4 program ID:  @sqds/multisig v2.1.4
 *     lib/generated/index.d.ts  PROGRAM_ADDRESS export
 *   - Proposal account shape: lib/generated/accounts/Proposal.d.ts
 *     (multisig, transactionIndex, status, ...)
 *   - VaultTransaction shape: lib/generated/accounts/VaultTransaction.d.ts
 *     (multisig, message: VaultTransactionMessage)
 *   - VaultTransactionMessage: lib/generated/types/VaultTransactionMessage.d.ts
 *     (accountKeys: PublicKey[], instructions: MultisigCompiledInstruction[])
 *   - MultisigCompiledInstruction: lib/generated/types/MultisigCompiledInstruction.d.ts
 *     (programIdIndex: number, accountIndexes, data)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  KNOWN_SQUADS_GOVERNED_PROGRAMS,
  SQUADS_V4_PROGRAM_ID,
  type SquadsGovernedProgram,
} from "./solana-known.js";

// `@sqds/multisig`'s package.json exports map only exposes the top-level
// entry, so we hop through the namespace re-exports. Proposal /
// VaultTransaction have private constructors — we use them as VALUES only
// (their static factories) and rely on `ReturnType<...>` for the shape.
const { Proposal, VaultTransaction } = squads.accounts;
const { getTransactionPda } = squads;

export interface PendingUpgradeFinding {
  programId: string;
  protocol: string;
  multisigPda: string;
  proposalPda: string;
  vaultTransactionPda: string;
  proposalStatus: "Active" | "Approved";
  transactionIndex: string;
  approvedSigners: number;
  /**
   * Always-flagged pretext: ANY pending vault tx targeting the BPF Loader
   * Upgradeable program is surfaced, regardless of which loader ix variant.
   * If the user wants to differentiate "Upgrade" vs "SetAuthority" they
   * can read the raw `data` byte from the on-chain proposal — we
   * deliberately don't decode the discriminator here to keep the scope
   * conservative.
   */
  loaderTargetCount: number;
}

export interface SquadsPendingScanResult {
  scannedMultisigs: number;
  scannedPrograms: ReadonlyArray<SquadsGovernedProgram>;
  pendingUpgrades: PendingUpgradeFinding[];
  /** Per-protocol error during scan; one entry per failure. */
  errors: Array<{ programId: string; protocol: string; error: string }>;
}

const SQUADS_PROGRAM_ID_PUBKEY = new PublicKey(SQUADS_V4_PROGRAM_ID);
const BPF_LOADER_UPGRADEABLE_PUBKEY = new PublicKey(BPF_LOADER_UPGRADEABLE_PROGRAM_ID);

type ProposalDecoded = ReturnType<typeof Proposal.fromAccountInfo>[0];

/**
 * Fetch all `Proposal` accounts for a given multisig that are in a
 * pre-execution state (Active or Approved). Uses the SDK's `gpaBuilder`
 * + `multisig` field filter for an efficient indexer-side scan.
 */
async function fetchPendingProposalsForMultisig(
  conn: Connection,
  multisigPda: PublicKey,
): Promise<Array<{ pubkey: PublicKey; proposal: ProposalDecoded }>> {
  const builder = Proposal.gpaBuilder(SQUADS_PROGRAM_ID_PUBKEY);
  builder.addFilter("multisig", multisigPda);
  const accounts = await builder.run(conn);
  const out: Array<{ pubkey: PublicKey; proposal: ProposalDecoded }> = [];
  for (const { pubkey, account } of accounts) {
    try {
      const [proposal] = Proposal.fromAccountInfo({
        ...account,
        owner: SQUADS_PROGRAM_ID_PUBKEY,
      });
      const kind = proposal.status.__kind;
      if (kind === "Active" || kind === "Approved") {
        out.push({ pubkey, proposal });
      }
    } catch {
      // Skip un-decodable accounts; they may belong to a different SDK
      // version or be malformed. Errors here aren't actionable for the
      // signal — best-effort scan.
    }
  }
  return out;
}

/**
 * For a given pending Proposal, fetch the linked VaultTransaction PDA and
 * count how many of its compiled instructions resolve to the BPF Loader
 * Upgradeable program. Returns 0 if the VaultTransaction account isn't
 * present (proposal targeted a ConfigTransaction, not a VaultTransaction —
 * config-tx changes don't go through the loader).
 */
export async function countLoaderTargetsInProposal(
  conn: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
): Promise<number> {
  const [vaultTxPda] = getTransactionPda({
    multisigPda,
    index: transactionIndex,
    programId: SQUADS_PROGRAM_ID_PUBKEY,
  });
  let vaultTx: Awaited<ReturnType<typeof VaultTransaction.fromAccountAddress>>;
  try {
    vaultTx = await VaultTransaction.fromAccountAddress(conn, vaultTxPda);
  } catch {
    return 0;
  }
  const accountKeys = vaultTx.message.accountKeys;
  let count = 0;
  for (const ix of vaultTx.message.instructions) {
    const programKey = accountKeys[ix.programIdIndex];
    if (programKey && programKey.equals(BPF_LOADER_UPGRADEABLE_PUBKEY)) {
      count++;
    }
  }
  return count;
}

/**
 * Top-level scan: iterate the curated `programId → multisigPda` list and
 * surface every pending vault tx that targets the BPF Loader Upgradeable
 * program. When the curated list is empty, returns `scannedMultisigs: 0`
 * and an empty `pendingUpgrades` — the calling signal must surface this
 * as `available: true` with a `note` explaining the empty-vendor-list
 * scope, NOT silently green.
 */
export async function scanSquadsPendingUpgrades(
  conn: Connection,
  programs: ReadonlyArray<SquadsGovernedProgram> = KNOWN_SQUADS_GOVERNED_PROGRAMS,
): Promise<SquadsPendingScanResult> {
  const pendingUpgrades: PendingUpgradeFinding[] = [];
  const errors: SquadsPendingScanResult["errors"] = [];
  for (const program of programs) {
    try {
      const multisigPda = new PublicKey(program.multisigPda);
      const pending = await fetchPendingProposalsForMultisig(conn, multisigPda);
      for (const { pubkey: proposalPda, proposal } of pending) {
        const txIndexBN = proposal.transactionIndex;
        // beet.bignum is BN-compatible; coerce to bigint via toString to
        // avoid precision loss on large indices (Solana counts are u64).
        const txIndex = BigInt(txIndexBN.toString());
        const loaderTargetCount = await countLoaderTargetsInProposal(
          conn,
          multisigPda,
          txIndex,
        );
        if (loaderTargetCount === 0) continue;
        const [vaultTxPda] = getTransactionPda({
          multisigPda,
          index: txIndex,
          programId: SQUADS_PROGRAM_ID_PUBKEY,
        });
        pendingUpgrades.push({
          programId: program.programId,
          protocol: program.protocol,
          multisigPda: program.multisigPda,
          proposalPda: proposalPda.toBase58(),
          vaultTransactionPda: vaultTxPda.toBase58(),
          proposalStatus: proposal.status.__kind as "Active" | "Approved",
          transactionIndex: txIndex.toString(),
          approvedSigners: proposal.approved.length,
          loaderTargetCount,
        });
      }
    } catch (err) {
      errors.push({
        programId: program.programId,
        protocol: program.protocol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    scannedMultisigs: programs.length,
    scannedPrograms: programs,
    pendingUpgrades,
    errors,
  };
}
