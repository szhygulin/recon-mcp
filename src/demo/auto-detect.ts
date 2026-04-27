/**
 * Auto-demo detection (issue #391/#392 follow-up).
 *
 * The original demo-mode gate (`VAULTPILOT_DEMO=true`) requires editing
 * the MCP client config (e.g. `.claude.json`'s `env` block) and
 * restarting Claude Code — friction that killed the try-before-install
 * path #391/#392 tried to surface. Auto-demo flips that default: a fresh
 * install with no config file is implicitly in demo mode, so an agent
 * can offer personas + simulated signing the moment the user says "let's
 * try it" — no env-var dance.
 *
 * Trigger: `readUserConfig() === null` — i.e. no config file in either
 * the new (`~/.vaultpilot-mcp/`) or legacy (`~/.recon-crypto-mcp/`)
 * location. `readUserConfig` already handles both paths.
 *
 * Pairings are NOT a separate signal because they live INSIDE
 * `config.json` (`pairings.solana`, `pairings.bitcoin`, etc.). Config
 * absence implies no pairings; config presence implies the user has
 * either run `vaultpilot-mcp-setup` or paired hardware — either way,
 * past the "fresh install" state.
 *
 * Boot-time, latched: detection runs once at process start, the result
 * is frozen for the rest of the process. A user who pairs / runs setup
 * mid-session stays in their initial mode until restart. This keeps the
 * security boundary crisp (mode change requires off-process state +
 * restart, mirroring the env-var commitment) and avoids weird
 * mid-session mode flips.
 *
 * Failure mode: `readUserConfig` throws on malformed JSON. We catch and
 * treat malformed-config as "config present" — the user has been here,
 * the auto-demo nudge would be wrong. Fail closed (real mode) when
 * config state is ambiguous; an explicit `VAULTPILOT_DEMO=true` is the
 * way to force demo regardless of disk state.
 */
import { readUserConfig } from "../config/user-config.js";

/**
 * Pure detection function — caller invokes once at boot via
 * `initDemoMode()` in `./index.ts` to populate the latched value.
 * Re-exported for direct unit testing.
 */
export function detectAutoDemoMode(): boolean {
  try {
    return readUserConfig() === null;
  } catch {
    return false;
  }
}
