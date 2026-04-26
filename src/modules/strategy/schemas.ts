import { z } from "zod";
import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * Public-strategy JSON schema (v1).
 *
 * The shareable artifact is a structural description of a portfolio —
 * protocol + asset + percentage — with NO addresses, NO absolute USD
 * values, NO transaction hashes. The recipient pastes the JSON into
 * their own VaultPilot instance via `import_strategy` and gets a
 * read-only inspection of the structure (potential starting point for
 * their own setup).
 *
 * Privacy invariants enforced at emit time by the redaction scan in
 * `redact.ts`:
 *   - zero EVM 0x-prefix addresses
 *   - zero TRON T-prefix base58 addresses
 *   - zero Solana base58 pubkeys (43-44 char shape)
 *   - zero 64-hex tx hashes (with or without 0x prefix)
 *
 * Anything that fails the scan throws `RedactionError` BEFORE the JSON
 * is returned to the agent. Symmetric — `import_strategy` runs the
 * same scan on input, so a malicious sender can't sneak addresses in
 * via fields the recipient might not eyeball.
 */

export const SHARED_STRATEGY_VERSION = 1 as const;

const POSITION_KIND = ["balance", "supply", "borrow", "lp", "stake"] as const;

const RISK_PROFILE = ["conservative", "moderate", "aggressive"] as const;

/**
 * Per-position row in a shared strategy. One row per (protocol, chain,
 * asset, side) tuple. For LPs, `asset` is the pair like "ETH/USDC". For
 * staking, `asset` is the staked symbol (e.g. "ETH" for Lido stETH —
 * the LST shape isn't surfaced because that would semi-fingerprint).
 */
export interface SharedStrategyPosition {
  /**
   * Protocol slug — e.g. "aave-v3", "compound-v3", "morpho-blue",
   * "uniswap-v3", "lido", "eigenlayer", "marginfi", "kamino",
   * "marinade", "jito", "tron-staking", "wallet" (for plain holdings).
   */
  protocol: string;
  /**
   * Chain slug — "ethereum" / "arbitrum" / "polygon" / "base" /
   * "optimism" / "tron" / "solana" / "bitcoin" / "litecoin".
   */
  chain: string;
  kind: (typeof POSITION_KIND)[number];
  /**
   * Token symbol (e.g. "USDC", "ETH"). For LPs: "TOKEN0/TOKEN1". For
   * Solana SPL tokens we surface the symbol the on-chain metadata gave
   * us; the mint address is intentionally never included.
   */
  asset: string;
  /**
   * Percentage of the user's TOTAL portfolio USD value that this
   * position represents (0-100, rounded to 1 decimal). Borrows are
   * surfaced with a positive percentage and `kind: "borrow"` rather
   * than negative numbers — readability wins.
   */
  pctOfTotal: number;
  /**
   * Lending health factor (>1 safe, <1 liquidatable). Rounded to 2
   * decimals to avoid acting as a wallet fingerprint. Present only on
   * lending positions with debt.
   */
  healthFactor?: number;
  /** Uniswap V3 fee tier in basis-point hundredths (e.g. 3000 = 0.30%). */
  feeTier?: number;
  /** APR as a decimal (0.035 = 3.5%) when the staking reader surfaces one. */
  apr?: number;
  /** Whether an LP position is currently in-range. */
  inRange?: boolean;
}

export interface SharedStrategy {
  version: typeof SHARED_STRATEGY_VERSION;
  meta: {
    name: string;
    description?: string;
    /** Author handle. Absent → strategy is anonymous. */
    authorLabel?: string;
    riskProfile?: (typeof RISK_PROFILE)[number];
    /** ISO-8601 UTC timestamp when the strategy was generated. */
    createdIso: string;
    /**
     * Distinct chain slugs that contributed positions. Useful for
     * recipients who want to filter (e.g. "show me Solana-only
     * strategies"). Derived from positions[].chain — never includes a
     * chain with no positions.
     */
    chains: string[];
  };
  positions: SharedStrategyPosition[];
  notes: string[];
}

// ---- Tool input schemas -------------------------------------------

const evmWalletSchema = z.string().regex(EVM_ADDRESS);
const tronAddressSchema = z.string().regex(TRON_ADDRESS);
const solanaAddressSchema = z.string().regex(SOLANA_ADDRESS);
const bitcoinAddressSchema = z.string().min(26).max(64);
const litecoinAddressSchema = z.string().min(26).max(64);

/**
 * Note: kept as a plain `ZodObject` (not `.refine()`-wrapped) because
 * the MCP server registration consumes `.shape` directly, which
 * `ZodEffects` doesn't expose. The "at least one address" invariant is
 * enforced in the handler instead.
 */
export const shareStrategyInput = z.object({
  wallet: evmWalletSchema
    .optional()
    .describe(
      "EVM wallet whose positions feed the strategy structure. At least one " +
        "of `wallet` / `tronAddress` / `solanaAddress` / `bitcoinAddress` / " +
        "`litecoinAddress` is required."
    ),
  tronAddress: tronAddressSchema
    .optional()
    .describe("TRON mainnet base58 address (T-prefix)."),
  solanaAddress: solanaAddressSchema
    .optional()
    .describe("Solana mainnet base58 pubkey."),
  bitcoinAddress: bitcoinAddressSchema
    .optional()
    .describe(
      "Bitcoin mainnet address (any of legacy/p2sh-segwit/bech32/bech32m)."
    ),
  litecoinAddress: litecoinAddressSchema
    .optional()
    .describe(
      "Litecoin mainnet address (any of legacy/p2sh/p2sh-segwit/bech32)."
    ),
  name: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Short human-readable strategy name. e.g. 'stable yield with mild leverage'."
    ),
  description: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional longer description. Free-form; redaction scan applies."
    ),
  authorLabel: z
    .string()
    .max(50)
    .optional()
    .describe(
      "Optional author handle / label. Omit for an anonymous strategy " +
        "(no identifier emitted)."
    ),
  riskProfile: z
    .enum(RISK_PROFILE as unknown as [string, ...string[]])
    .optional()
    .describe(
      "Self-declared risk profile. Free-form metadata for the recipient — " +
        "we don't compute or validate it."
    ),
});

export type ShareStrategyArgs = z.infer<typeof shareStrategyInput>;

export const importStrategyInput = z
  .object({
    json: z
      .union([z.string(), z.record(z.unknown())])
      .describe(
        "The strategy JSON. Pass either the stringified form (what " +
          "`share_strategy` returns in `jsonString`) or the parsed " +
          "object (what it returns in `strategy`). The same redaction " +
          "scan that runs on emit also runs on import — addresses or " +
          "tx hashes anywhere in the imported JSON cause a structured " +
          "RedactionError."
      ),
  });

export type ImportStrategyArgs = z.infer<typeof importStrategyInput>;

export function assertAtLeastOneAddress(args: ShareStrategyArgs): void {
  if (
    !args.wallet &&
    !args.tronAddress &&
    !args.solanaAddress &&
    !args.bitcoinAddress &&
    !args.litecoinAddress
  ) {
    throw new Error(
      "At least one of `wallet` / `tronAddress` / `solanaAddress` / " +
        "`bitcoinAddress` / `litecoinAddress` is required.",
    );
  }
}
