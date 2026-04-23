import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * Dynamic priority-fee logic for Solana txs. We read
 * `getRecentPrioritizationFees` (Solana RPC returns a sample of the priority
 * fees paid by recent successful txs that locked the same writable
 * accounts) and decide:
 *
 *   - If the p50 of the sample is >= CONGESTION_THRESHOLD → inject
 *     `ComputeBudget.setComputeUnitPrice(p50 μLamports/CU)` + a 200k CU
 *     limit. This buys priority-based inclusion under the current
 *     conditions without overpaying.
 *   - Otherwise → return `null`. The builder skips ComputeBudget
 *     instructions entirely. Clean 1-instruction tx; base fee only.
 *
 * Why p50, not p95: p95 inflates cost when a few extreme-priority
 * bots are willing to pay hundreds of thousands of μlamports/CU for
 * MEV-adjacent txs. Retail transfers don't compete with them; the
 * median sample is what the network actually needs to include a
 * non-MEV tx promptly.
 *
 * 200k CU is ample for a transfer (a System transfer uses ~450 CU;
 * a Token.TransferChecked + ATA creation sits around 30k). Overshooting
 * doesn't cost extra — the user pays for USED CU, not LIMIT CU, so
 * there's no downside to leaving headroom. Undershooting would cause
 * the tx to fail with "compute budget exceeded".
 */
const CONGESTION_THRESHOLD_MICRO_LAMPORTS_PER_CU = 5_000n;
const COMPUTE_UNIT_LIMIT = 200_000;

export interface PriorityFeeDecision {
  microLamportsPerCu: number;
  computeUnitLimit: number;
}

/**
 * Decide whether to attach priority-fee instructions to the tx. Returns
 * null under normal conditions (skip ComputeBudget); returns a concrete
 * decision under congestion.
 *
 * `writableAccounts` — the PublicKeys the tx will write to. Solana's
 * `getRecentPrioritizationFees` returns per-slot fee samples scoped to
 * txs that touched any of the supplied accounts, so passing the actual
 * writable accounts gives a fee estimate relevant to the specific
 * contention this tx will face (e.g. a popular SPL mint's ATA is much
 * more congested than a random user's SOL account).
 */
export async function computePriorityFee(
  connection: Connection,
  writableAccounts: PublicKey[],
): Promise<PriorityFeeDecision | null> {
  let samples: Array<{ slot: number; prioritizationFee: number }>;
  try {
    samples = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: writableAccounts,
    });
  } catch {
    // RPC that doesn't support `getRecentPrioritizationFees` (older nodes)
    // — fall through to "no priority fee". The tx still lands under normal
    // conditions; users on a congested mainnet with a bad RPC will see
    // occasional drops and can retry. Not a fatal error for prepare.
    return null;
  }
  if (samples.length === 0) return null;
  // Median of the returned samples. Solana RPC typically returns ~150 slots
  // of history; taking p50 smooths out spikes.
  const sorted = samples
    .map((s) => BigInt(s.prioritizationFee))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p50 = sorted[Math.floor(sorted.length / 2)];
  if (p50 < CONGESTION_THRESHOLD_MICRO_LAMPORTS_PER_CU) return null;
  // Clamp to a safe upper bound so a temporary spike doesn't cause a
  // 0.1-SOL fee on a 0.001-SOL transfer. 1M μLamports/CU × 200k CU =
  // 0.0002 SOL max priority fee, which is generous for mainnet normal-to-
  // high congestion. If the network is paying more than that per tx, it's
  // a full-blown MEV event and retail transfers will land regardless of
  // priority.
  const CAP_MICRO_LAMPORTS_PER_CU = 1_000_000n;
  const chosen = p50 > CAP_MICRO_LAMPORTS_PER_CU ? CAP_MICRO_LAMPORTS_PER_CU : p50;
  return {
    microLamportsPerCu: Number(chosen),
    computeUnitLimit: COMPUTE_UNIT_LIMIT,
  };
}
