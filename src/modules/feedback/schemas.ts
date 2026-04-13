import { z } from "zod";

export const requestCapabilityInput = z.object({
  summary: z
    .string()
    .trim()
    .min(10)
    .max(120)
    .describe(
      "One-line title of the missing capability (used as the GitHub issue title). E.g. 'Support Aerodrome LP positions on Base' or 'Add Pendle PT/YT position reader'."
    ),
  description: z
    .string()
    .trim()
    .min(20)
    .max(4000)
    .describe(
      "What the user asked for, what the agent tried, what's missing, and why the existing tools don't cover it. Include protocol name, chain, contract addresses, and a concrete example if relevant."
    ),
  category: z
    .enum(["new_protocol", "new_chain", "tool_gap", "bug_report", "other"])
    .optional()
    .describe("Rough bucket to help triage."),
  context: z
    .object({
      toolAttempted: z
        .string()
        .max(100)
        .optional()
        .describe("Name of the recon-mcp tool the agent tried first, if any."),
      chain: z.string().max(50).optional().describe("Chain involved, if relevant."),
      errorObserved: z
        .string()
        .max(800)
        .optional()
        .describe("Error message or unexpected output from an existing tool."),
    })
    .optional(),
  agentName: z
    .string()
    .max(80)
    .optional()
    .describe("MCP client identifier (e.g. 'Claude Code', 'Cursor'). Helps triage."),
});

export type RequestCapabilityArgs = z.infer<typeof requestCapabilityInput>;
