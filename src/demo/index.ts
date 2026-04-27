/**
 * Demo / try-before-install mode (issue #371). `VAULTPILOT_DEMO=true` is
 * the single env-var gate.
 *
 * Two sub-modes coexist behind that gate:
 *
 *   1. **Default demo mode** (env set, no live wallet): every read tool
 *      runs against real chain RPC, every signing-class tool refuses
 *      with a structured `[VAULTPILOT_DEMO]` error. A prospective user
 *      can browse any address they pass without committing to a Ledger.
 *
 *   2. **Live demo mode** (env set + `set_demo_wallet` called): a
 *      curated persona or custom address bundle is active. Reads still
 *      run real RPC, prepare_* / simulate_* / preview_* still run real,
 *      but `send_transaction` is intercepted and returns a simulation
 *      envelope (no signing, no broadcast). The handful of tools that
 *      write disk / GH / hardware state stay refused even in live mode.
 *
 * Activation transitions are runtime, not boot-time: an agent in default
 * mode can call `set_demo_wallet({ persona: "..." })` to upgrade to live
 * mode for the remainder of the process lifetime; calling
 * `set_demo_wallet({})` returns to default. State is process-local and
 * resets on restart — demo state is ephemeral by design.
 */

import {
  getLiveWallet,
  isLiveMode,
  setLivePersona,
  setLiveCustomAddresses,
  clearLiveWallet,
  type LiveWalletState,
} from "./live-mode.js";

/**
 * True when `VAULTPILOT_DEMO=true` is set in the environment. Read at
 * tool-call time (not module load) so a single process can be flipped
 * via env mutation in tests without re-imports.
 */
export function isDemoMode(): boolean {
  return process.env.VAULTPILOT_DEMO === "true";
}

/**
 * Tools that are refused REGARDLESS of demo sub-mode. These either write
 * persistent state outside this process (Ledger pairing config, GitHub
 * issues) or require a real Ledger device (sign_message_*) — both
 * categories have no on-chain simulation equivalent. Keeps the contract
 * crisp: no Ledger? these never work in demo, ever.
 */
export function isAlwaysGatedTool(toolName: string): boolean {
  if (toolName.startsWith("pair_ledger_")) return true;
  if (toolName.startsWith("sign_message_")) return true;
  return ALWAYS_GATED_EXPLICIT.has(toolName);
}

const ALWAYS_GATED_EXPLICIT = new Set([
  "request_capability", // network write to GitHub via the proxy
]);

/**
 * Tools whose gating depends on the demo sub-mode. In default demo mode
 * (no live wallet set) these refuse with a structured error directing
 * the user to call `set_demo_wallet`. In live mode, prepare_* / preview_*
 * / simulate_* / verify_tx_decode run for real (read-only on-chain
 * simulation); only `send_transaction` is intercepted with a simulation
 * envelope.
 *
 * Pattern-matched so newly added prepare_* tools opt in automatically.
 */
export function isConditionallyGatedTool(toolName: string): boolean {
  if (toolName.startsWith("prepare_")) return true;
  return CONDITIONALLY_GATED_EXPLICIT.has(toolName);
}

const CONDITIONALLY_GATED_EXPLICIT = new Set([
  "send_transaction",
  "preview_send",
  "preview_solana_send",
  "verify_tx_decode",
  "get_verification_artifact",
]);

/**
 * The single tool whose live-mode behavior is "intercept + return a
 * simulation envelope" rather than "run the real handler". Every other
 * conditionally-gated tool runs real in live mode; broadcast is the
 * one thing we can never let through (would actually send funds).
 */
export function isBroadcastTool(toolName: string): boolean {
  return toolName === "send_transaction";
}

/**
 * Structured refusal for the always-gated set. Single source of truth so
 * the message is consistent across every blocked tool.
 */
export function alwaysGatedRefusalMessage(toolName: string): string {
  return (
    `[VAULTPILOT_DEMO] '${toolName}' is unavailable in demo mode regardless of live-wallet ` +
    `state. This tool either writes persistent off-chain state (Ledger pairing, GitHub) or ` +
    `requires a real Ledger device — neither has an on-chain simulation equivalent. ` +
    `Ready to leave demo and use this for real? Call \`exit_demo_mode\` for a tailored ` +
    `step-by-step setup guide (asks about your Ledger + chain selection). Otherwise: unset ` +
    `VAULTPILOT_DEMO and restart the MCP server with a real Ledger paired.`
  );
}

/**
 * Structured refusal for conditionally-gated tools when no live wallet
 * is set. Points the user at `set_demo_wallet` so the upgrade path is
 * discoverable from the error itself.
 */
export function defaultModeRefusalMessage(toolName: string): string {
  return (
    `[VAULTPILOT_DEMO] '${toolName}' requires an active demo wallet — call ` +
    `\`set_demo_wallet({ persona: "<id>" })\` first to enable the simulated transaction ` +
    `flow. Available personas: defi-power-user, stable-saver, staking-maxi, whale. ` +
    `In default demo mode (no live wallet), only read tools and \`set_demo_wallet\` work — ` +
    `signing-class tools refuse to avoid any chance of fake-signing or fake-broadcasting. ` +
    `If you'd rather leave demo entirely and use this tool against your real wallet, call ` +
    `\`exit_demo_mode\` for a step-by-step setup guide.`
  );
}

/**
 * Build the simulation envelope returned in place of a real broadcast
 * receipt. Visually distinct from a real send_transaction response:
 * `outcome: "simulated"` flag, no `txHash` field (only `simulatedTxHash`),
 * and a verbatim-relayable `message` directing the user that nothing
 * actually went on-chain.
 *
 * Caller is responsible for re-running `simulate_transaction` on the
 * unsigned tx and passing the result in — keeping the envelope construction
 * pure makes it easy to test independently of the simulation surface.
 */
export function buildSimulationEnvelope(args: {
  toolName: string;
  unsignedTxHandle: string;
  simulationResult: unknown;
  pinnedPreview?: unknown;
}): {
  demo: true;
  outcome: "simulated";
  simulatedTxHash: string;
  simulation: unknown;
  preview: unknown;
  message: string;
} {
  const simulatedTxHash = makeSimulatedTxHash(args.unsignedTxHandle);
  return {
    demo: true,
    outcome: "simulated",
    simulatedTxHash,
    simulation: args.simulationResult,
    preview: args.pinnedPreview ?? null,
    message:
      `[VAULTPILOT_DEMO] This transaction was NOT broadcast. The simulation field above ` +
      `shows the on-chain effect that would have occurred against the live demo wallet. ` +
      `simulatedTxHash is a deterministic placeholder derived from the unsigned-tx handle ` +
      `(prefix: 0xdemo) — it is not a real transaction hash and will return 'unknown' from ` +
      `any block explorer. To execute for real: unset VAULTPILOT_DEMO, restart the MCP ` +
      `server with a real Ledger paired, then re-run the prepare → preview → send flow.`,
  };
}

/**
 * Deterministic placeholder hash for the simulated-broadcast envelope.
 * Prefixed `0xdemo` so an agent or downstream tool can pattern-match
 * "this is not a real tx hash" before pasting it into Etherscan.
 */
function makeSimulatedTxHash(handle: string): string {
  const seed = String(handle).slice(0, 32).padEnd(32, "0").replace(/[^a-zA-Z0-9]/g, "0");
  // 64-hex-char body after the 0xdemo prefix would be 64 chars; we use
  // `0xdemo` (6 chars) + 58 chars derived from the handle to stay
  // visually-recognizable while keeping a fixed length.
  return `0xdemo${seed}${"0".repeat(58 - seed.length)}`;
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
        "is operating in evaluation mode. Unset VAULTPILOT_DEMO and re-run setup.",
    );
  }
}

// Re-export live-mode primitives so consumers can `import { ... } from
// "./demo/index.js"` for everything demo-related (one entry point).
export {
  getLiveWallet,
  isLiveMode,
  setLivePersona,
  setLiveCustomAddresses,
  clearLiveWallet,
  type LiveWalletState,
};
