/**
 * Zod input schemas for the runtime API-key tools. Lives in a sibling
 * file so src/index.ts stays free of inline zod definitions (matches
 * the convention every other module follows).
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

export const setEtherscanApiKeyInput = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      "Etherscan V2 API key (34-char alphanumeric, e.g. ZQTKPM98R5N4YT8GMTBI3XR2P4HFZNTAYG). " +
        "Get one for free at https://etherscan.io/myapikey. One key works across all 5 " +
        "supported EVM chains via the V2 unified API. Stored in process memory only — " +
        "survives until the MCP server restarts.",
    ),
});

export type SetEtherscanApiKeyArgs = z.infer<typeof setEtherscanApiKeyInput>;
