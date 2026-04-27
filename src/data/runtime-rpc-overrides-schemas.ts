/**
 * Zod input schema for `set_helius_api_key`. Lives in a sibling file so
 * src/index.ts stays free of inline zod definitions (matches the
 * convention every other module follows).
 */

import { z } from "zod";

export const setHeliusApiKeyInput = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      "Helius API key (UUID format: 8-4-4-4-12 hex chars). Get one for free at " +
        "https://dashboard.helius.dev/. Pass the bare key — the server constructs the " +
        "canonical Helius mainnet URL internally. Stored in process memory only — survives " +
        "until the MCP server restarts.",
    ),
});

export type SetHeliusApiKeyArgs = z.infer<typeof setHeliusApiKeyInput>;
