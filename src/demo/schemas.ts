/**
 * Zod input schemas for the demo-mode tool surface (set_demo_wallet,
 * get_demo_wallet). Kept in a sibling file rather than inline at the
 * registerTool call sites so src/index.ts stays free of zod imports
 * (matches the convention every other module follows).
 */

import { z } from "zod";

export const setDemoWalletInput = z.object({
  persona: z
    .enum(["defi-power-user", "stable-saver", "staking-maxi", "whale"])
    .optional()
    .describe(
      "Persona ID to activate. Mutually exclusive with `custom`. Omit both to clear live wallet.",
    ),
  custom: z
    .object({
      evm: z.array(z.string()).optional(),
      solana: z.array(z.string()).optional(),
      tron: z.array(z.string()).optional(),
      bitcoin: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "Custom address bundle. Mutually exclusive with `persona`. At least one chain field must be non-empty.",
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
