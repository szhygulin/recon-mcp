import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

/**
 * Multi-mode incident-status rollup. EVM lending modes (compound-v3,
 * aave-v3) keep their existing behavior — `chain` selects the EVM
 * deployment. Base-layer chain modes (bitcoin, litecoin, solana, tron)
 * scan the named chain regardless of the `chain` arg (which is ignored
 * for these). The Solana program-layer mode (solana-protocols) accepts
 * an optional `wallet` to scope the scan to programs the user actually
 * has exposure to.
 *
 * Each mode produces a top-level `incident: boolean` rollup so an agent
 * can answer "is anything on fire" with one call regardless of what
 * the user is asking about. Issues #236, #238, #242 v1.
 */
export const getMarketIncidentStatusInput = z.object({
  protocol: z
    .enum([
      // EVM lending (existing)
      "compound-v3",
      "aave-v3",
      // Base-layer chain modes (#236 + #238)
      "bitcoin",
      "litecoin",
      "solana",
      "tron",
      // Solana program-layer (#242)
      "solana-protocols",
    ])
    .describe(
      "What to scan. EVM lending: compound-v3 flags per-Comet pause + utilization, aave-v3 flags per-reserve isPaused/isFrozen/!isActive + utilization. Base-layer chains: bitcoin/litecoin compute tip_staleness + hash_cliff + empty_block_streak + miner_concentration; solana computes slot_progression + skip_rate + validator_concentration + cluster_halt + epoch_progression + priority_fee_anomaly; tron computes block_progression + missed_blocks_rate + sr_concentration + sr_rotation_anomaly + tronGrid_divergence + network_resource_exhaustion (and usdt_blacklist_event when `wallet` is supplied). solana-protocols scans for recent_program_upgrade + token_freeze_event + Pyth oracle_staleness against the user's exposure when `wallet` is supplied."
    ),
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain (used by compound-v3 / aave-v3 only; ignored otherwise)."),
  wallet: z
    .string()
    .optional()
    .describe(
      "Wallet address — used by `solana-protocols` (SPL exposure scope) and `tron` (TRC-20 USDT counterparty blacklist scope, issue #249). Solana base58 (43-44 chars) for `solana-protocols`; TRON base58 (T-prefix, 34 chars) for `tron`. Ignored on other protocols."
    ),
});

export type GetMarketIncidentStatusArgs = z.infer<typeof getMarketIncidentStatusInput>;
