/**
 * Demo / try-before-install mode. Switches read tools to fixture mode and
 * gates every signing tool with a structured refusal — `VAULTPILOT_DEMO=true`
 * is the single env-var gate. Goal: a prospective user can `npx vaultpilot-mcp`
 * with the env var set and get a coherent multi-chain portfolio walkthrough
 * in 30 seconds, no Ledger required.
 *
 * Determinism: fixtures are static — no random variation, no time-of-day
 * drift. Demo screenshots / videos / tutorials reproduce identically across
 * runs.
 */

import { DEMO_FIXTURES } from "./fixtures.js";

/**
 * True when `VAULTPILOT_DEMO=true` is set in the environment. Read at
 * tool-call time (not module load) so a single process can be flipped via
 * env mutation in tests without re-imports.
 */
export function isDemoMode(): boolean {
  return process.env.VAULTPILOT_DEMO === "true";
}

/**
 * Tools that produce or forward signable transactions. In demo mode every
 * one of these refuses with a structured error rather than fabricating a
 * fake signature — fake-sign would be misleading and fake-broadcast would
 * be impossible (no chain to receive). Pattern-matched so newly added
 * `prepare_*` / `pair_ledger_*` tools are gated automatically.
 */
export function isSigningTool(toolName: string): boolean {
  if (toolName.startsWith("prepare_")) return true;
  if (toolName.startsWith("pair_ledger_")) return true;
  if (toolName.startsWith("sign_message_")) return true;
  return EXPLICIT_SIGNING_TOOLS.has(toolName);
}

const EXPLICIT_SIGNING_TOOLS = new Set([
  "send_transaction",
  "preview_send",
  "preview_solana_send",
  "verify_tx_decode",
  "get_verification_artifact",
  "request_capability", // network write to GH; not a chain tx but disruptive in demo
]);

/**
 * Structured refusal for signing tools in demo mode. Single source of
 * truth so the message is consistent across every blocked tool — agents
 * pattern-matching the prefix can branch on it cleanly.
 */
export function demoSigningRefusalMessage(toolName: string): string {
  return (
    `[VAULTPILOT_DEMO] '${toolName}' is a signing / device-pairing tool and is disabled in demo mode. ` +
    `Demo mode ships fixture data for read tools so you can try the read-only UX without a Ledger. ` +
    `To sign real transactions: unset VAULTPILOT_DEMO (or restart with it absent), run \`vaultpilot-mcp-setup\`, plug in your Ledger, and pair Ledger Live.`
  );
}

/**
 * Lookup-or-default for read tools. Returns the deterministic fixture
 * registered for `toolName` if one exists; otherwise returns a structured
 * "fixture not yet implemented" payload so the agent can tell the user
 * which tools have demo coverage and which don't (instead of either
 * silently falling through to the real tool — which would 404 / time
 * out without a Ledger paired — or crashing).
 *
 * The fixture function receives the parsed args so per-(chain, wallet,
 * token) lookups can vary the response without losing determinism: same
 * args → same fixture.
 */
export function getDemoFixture(toolName: string, args: unknown): unknown {
  const fixture = DEMO_FIXTURES[toolName];
  if (fixture === undefined) {
    return {
      _demoFixture: "not-implemented",
      _toolName: toolName,
      _message:
        `Demo mode is active and a fixture for '${toolName}' has not been added yet. ` +
        `Implemented fixtures: ${Object.keys(DEMO_FIXTURES).sort().join(", ")}. ` +
        `Tool arguments received (echoed for inspection): ${JSON.stringify(args)}.`,
    };
  }
  return fixture(args);
}

/**
 * Used by the setup wizard to refuse writing real config in demo mode —
 * a user who runs `vaultpilot-mcp-setup` while VAULTPILOT_DEMO=true is
 * almost certainly experimenting and shouldn't be silently writing
 * Ledger pairing state to disk. Throws with an actionable error.
 */
export function assertNotDemoForSetup(): void {
  if (isDemoMode()) {
    throw new Error(
      "[VAULTPILOT_DEMO] Setup is disabled in demo mode — running `vaultpilot-mcp-setup` " +
        "would write a real config (pairing state, indexer URLs) to disk while the server " +
        "is operating against fake fixture data. Unset VAULTPILOT_DEMO and re-run setup.",
    );
  }
}
