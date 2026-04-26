import type { ClientPatchResult } from "./register-clients.js";
import type { SkillInstallResult } from "./install-skills.js";

/**
 * Structured-output helper for `vaultpilot-mcp-setup --json`. Emitted
 * to stdout by the non-interactive install path so an agent (or
 * `install.sh`) can parse the result without scraping prose.
 *
 * Envelope shape per plan
 * `claude-work/HIGH-plan-agent-driven-install.md`:
 *
 * ```json
 * {
 *   "status": "installed" | "already_installed",
 *   "version": "0.8.2",
 *   "binaries": { "server": "...", "setup": "..." },
 *   "clients_registered": ["Claude Desktop", "Claude Code"],
 *   "clients_not_detected": ["Cursor"],
 *   "skills_installed": ["vaultpilot-preflight"],
 *   "skills_already_present": ["vaultpilot-setup"],
 *   "errors": [],
 *   "next_steps": ["Restart Claude Desktop ..."]
 * }
 * ```
 *
 * `status` is `"already_installed"` when EVERY client patch and EVERY
 * skill install reported `already-present` (i.e. the run did no new
 * work). Anything else — at least one new entry added or one error —
 * surfaces as `"installed"` so the agent knows to ask the user to
 * restart their MCP client.
 *
 * Errors are non-fatal in the install flow (we want partial-success
 * reporting; a write-permission failure on Cursor's config shouldn't
 * stop the Claude Desktop registration). They land in `errors[]` so
 * the agent can surface them to the user without dropping the
 * partial install on the floor.
 */

export interface InstallEnvelope {
  status: "installed" | "already_installed";
  version: string;
  binaries: { server: string; setup: string };
  clients_registered: string[];
  clients_already_present: string[];
  clients_not_detected: string[];
  skills_installed: string[];
  skills_already_present: string[];
  errors: Array<{ source: string; message: string }>;
  next_steps: string[];
}

export interface BuildEnvelopeArgs {
  version: string;
  binaries: { server: string; setup: string };
  patches: ClientPatchResult[];
  skills: SkillInstallResult[];
}

export function buildInstallEnvelope(args: BuildEnvelopeArgs): InstallEnvelope {
  const clients_registered: string[] = [];
  const clients_already_present: string[] = [];
  const clients_not_detected: string[] = [];
  const errors: InstallEnvelope["errors"] = [];

  for (const p of args.patches) {
    switch (p.status) {
      case "added":
        clients_registered.push(p.client);
        break;
      case "already-present":
        clients_already_present.push(p.client);
        break;
      case "not-detected":
        clients_not_detected.push(p.client);
        break;
      case "error":
        errors.push({
          source: `client:${p.client}`,
          message: p.detail ?? "unknown error",
        });
        break;
    }
  }

  const skills_installed: string[] = [];
  const skills_already_present: string[] = [];
  for (const s of args.skills) {
    switch (s.status) {
      case "installed":
        skills_installed.push(s.name);
        break;
      case "already-present":
        skills_already_present.push(s.name);
        break;
      case "error":
        errors.push({
          source: `skill:${s.name}`,
          message: s.detail ?? "unknown error",
        });
        break;
    }
  }

  // "already_installed" iff every client patch is already-present (no
  // adds) AND every skill is already-present AND no errors. The
  // not-detected clients don't count as work — they're a pre-existing
  // environment fact, not something this run could change.
  const noNewClients = clients_registered.length === 0;
  const noNewSkills = skills_installed.length === 0;
  const noErrors = errors.length === 0;
  const someInstalledClients = clients_already_present.length > 0;
  const someInstalledSkills = skills_already_present.length > 0;
  // Require at least one already-present client OR skill to call it
  // "already_installed" — otherwise a run on a fresh box with no MCP
  // clients detected would falsely report "already_installed".
  const status: InstallEnvelope["status"] =
    noNewClients &&
    noNewSkills &&
    noErrors &&
    (someInstalledClients || someInstalledSkills)
      ? "already_installed"
      : "installed";

  const next_steps: string[] = [];
  if (status === "already_installed") {
    next_steps.push(
      "Already installed. If vaultpilot-mcp tools aren't visible in your MCP client, restart it.",
      "To pair a Ledger or set provider API keys, run `vaultpilot-mcp-setup` interactively.",
    );
  } else {
    if (clients_registered.length > 0) {
      next_steps.push(
        `Restart ${clients_registered.join(", ")} to load vaultpilot-mcp.`,
      );
    } else if (clients_not_detected.length > 0 && clients_already_present.length === 0) {
      next_steps.push(
        "No MCP clients were detected — install Claude Desktop / Claude Code / Cursor, then re-run this installer.",
      );
    }
    next_steps.push(
      "After restart, ask the agent to 'show your portfolio' to verify install.",
      "To sign transactions, run `vaultpilot-mcp-setup` interactively when you're ready to pair your Ledger and add provider API keys.",
    );
  }

  return {
    status,
    version: args.version,
    binaries: args.binaries,
    clients_registered,
    clients_already_present,
    clients_not_detected,
    skills_installed,
    skills_already_present,
    errors,
    next_steps,
  };
}
