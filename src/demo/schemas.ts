/**
 * Zod input schemas for the demo-mode tool surface (set_demo_wallet,
 * get_demo_wallet). Kept in a sibling file rather than inline at the
 * registerTool call sites so src/index.ts stays free of zod imports
 * (matches the convention every other module follows).
 */

import { z } from "zod";

export const setDemoWalletInput = z.object({
  // Per-cell loader (preferred): "let me load btc whale" → one
  // address activates a single chain slot, leaving other chains
  // unchanged. Multiple per-cell calls accumulate.
  chain: z
    .enum(["evm", "solana", "tron", "bitcoin"])
    .optional()
    .describe(
      "Chain dimension of the demo-wallet matrix. Pair with `type` to load a single (chain, type) cell. Replaces any previous slot for this chain; other chains stay as they are.",
    ),
  type: z
    .enum(["defi-degen", "stable-saver", "staking-maxi", "whale"])
    .optional()
    .describe(
      "Type / archetype dimension of the demo-wallet matrix. Pair with `chain` to load a single (chain, type) cell.",
    ),

  // Persona batch loader (back-compat + convenience): "load whale" →
  // populates all 4 chains for the type at once. Equivalent to four
  // per-cell calls.
  persona: z
    .enum([
      "defi-degen",
      "stable-saver",
      "staking-maxi",
      "whale",
      // Legacy alias — pre-rename, "defi-degen" was "defi-power-user".
      // Accepted silently so old call sites keep working.
      "defi-power-user",
    ])
    .optional()
    .describe(
      "Persona / type ID to batch-activate across every chain that has a curated cell. Convenience over four `{ chain, type }` calls. Mutually exclusive with `chain`+`type` and with `custom`. Omit all three to clear the live wallet.",
    ),

  // Custom address bundle (escape hatch): user wants to demo against
  // their own addresses without leaving demo mode entirely.
  custom: z
    .object({
      evm: z.array(z.string()).optional(),
      solana: z.array(z.string()).optional(),
      tron: z.array(z.string()).optional(),
      bitcoin: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "Custom address bundle. Mutually exclusive with `chain`+`type` and `persona`. At least one chain field must be non-empty.",
    ),
});

export type SetDemoWalletArgs = z.infer<typeof setDemoWalletInput>;

export const getDemoWalletInput = z.object({});

export type GetDemoWalletArgs = z.infer<typeof getDemoWalletInput>;

export const exitDemoModeInput = z.object({
  hasLedger: z
    .boolean()
    .optional()
    .describe(
      "Whether the user confirmed they have a Ledger device. Pass `false` to get a deferral message recommending they stay in demo until they have hardware. Omit if unknown — the response includes a 'verify Ledger first' caution.",
    ),
  hasRunSetup: z
    .boolean()
    .optional()
    .describe(
      "Whether the user has previously run `vaultpilot-mcp-setup`. When true, the response skips the setup-wizard walkthrough.",
    ),
  chains: z
    .array(
      z.enum([
        "ethereum",
        "arbitrum",
        "polygon",
        "base",
        "optimism",
        "solana",
        "tron",
        "bitcoin",
        "litecoin",
      ]),
    )
    .optional()
    .describe(
      "Chains the user intends to use. Drives which RPC / API keys to recommend. Defaults to ['ethereum'] when omitted.",
    ),
  acquireKeys: z
    .boolean()
    .optional()
    .describe(
      "Whether the user wants help acquiring API keys. Affects recommendation tone — true expands signup links, false keeps the response short.",
    ),
});

export type ExitDemoModeArgs = z.infer<typeof exitDemoModeInput>;
