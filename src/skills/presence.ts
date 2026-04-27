/**
 * Skill-presence checks. Extracted from `src/index.ts` so other
 * modules (e.g. `src/modules/incident-report/`) can read whether a
 * skill is installed without pulling in the entire MCP entry point's
 * tool-registration graph (issue #425).
 *
 * Per-call existsSync (vs cached at startup) so installing the skill
 * mid-session takes effect without a server restart — the original
 * design intent of the function.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PREFLIGHT_SKILL_MARKER = join(
  homedir(),
  ".claude",
  "skills",
  "vaultpilot-preflight",
  "SKILL.md",
);

const DEFAULT_SETUP_SKILL_MARKER = join(
  homedir(),
  ".claude",
  "skills",
  "vaultpilot-setup",
  "SKILL.md",
);

export function preflightSkillMarkerPath(): string {
  return (
    process.env.VAULTPILOT_SKILL_MARKER_PATH ?? DEFAULT_PREFLIGHT_SKILL_MARKER
  );
}

export function setupSkillMarkerPath(): string {
  return (
    process.env.VAULTPILOT_SETUP_SKILL_MARKER_PATH ?? DEFAULT_SETUP_SKILL_MARKER
  );
}

export function isPreflightSkillInstalled(): boolean {
  return existsSync(preflightSkillMarkerPath());
}

export function isSetupSkillInstalled(): boolean {
  return existsSync(setupSkillMarkerPath());
}
