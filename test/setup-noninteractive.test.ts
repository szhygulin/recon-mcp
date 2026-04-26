import { describe, it, expect } from "vitest";
import { parseSetupFlags } from "../src/setup.js";
import { buildInstallEnvelope } from "../src/setup/output-json.js";
import type { ClientPatchResult } from "../src/setup/register-clients.js";
import type { SkillInstallResult } from "../src/setup/install-skills.js";

/**
 * Tests for the non-interactive / JSON-output install path
 * (claude-work/HIGH-plan-agent-driven-install.md, PR1+PR2). The
 * non-interactive runner itself shells out to `git clone` and
 * touches MCP-client config files, so the unit tests here cover the
 * pure pieces:
 *
 *   - flag parser (precedence, implication chain)
 *   - envelope builder (status discrimination, next_steps wording,
 *     error surfacing)
 *
 * The end-to-end integration is exercised by the existing
 * `register-clients.test.ts` + `install-skills.test.ts` which test
 * the helpers the runner composes.
 */

describe("parseSetupFlags", () => {
  it("returns all-false when no flags are passed", () => {
    expect(parseSetupFlags([])).toEqual({
      nonInteractive: false,
      json: false,
      idempotent: false,
    });
  });

  it("--non-interactive promotes idempotent=true", () => {
    expect(parseSetupFlags(["--non-interactive"])).toEqual({
      nonInteractive: true,
      json: false,
      idempotent: true,
    });
  });

  it("--json implies --non-interactive (and therefore idempotent)", () => {
    // Without this implication, `--json` alone would block on the
    // readline prompt loop and emit broken JSON. The flag parser
    // promotes silently so the agent-side caller doesn't have to
    // remember to pass both.
    expect(parseSetupFlags(["--json"])).toEqual({
      nonInteractive: true,
      json: true,
      idempotent: true,
    });
  });

  it("ignores unknown flags rather than throwing", () => {
    // Forward-compat: a future agent may pass --version-pin or similar;
    // unrecognized args are silently dropped so old setup binaries
    // don't fail under newer install scripts.
    expect(parseSetupFlags(["--non-interactive", "--unknown-flag"])).toEqual({
      nonInteractive: true,
      json: false,
      idempotent: true,
    });
  });

  it("explicit --idempotent stays on even without --non-interactive", () => {
    expect(parseSetupFlags(["--idempotent"])).toEqual({
      nonInteractive: false,
      json: false,
      idempotent: true,
    });
  });
});

describe("buildInstallEnvelope — status discrimination", () => {
  const setup = "/path/to/vaultpilot-mcp-setup";
  const server = "/path/to/vaultpilot-mcp";

  function patch(
    client: string,
    status: ClientPatchResult["status"],
    detail?: string,
  ): ClientPatchResult {
    return { client, configPath: `/x/${client}.json`, status, ...(detail ? { detail } : {}) };
  }

  function skill(
    name: string,
    status: SkillInstallResult["status"],
    detail?: string,
  ): SkillInstallResult {
    return {
      name,
      installPath: `/x/${name}`,
      repoUrl: `https://example.com/${name}.git`,
      status,
      ...(detail ? { detail } : {}),
    };
  }

  it("reports 'installed' when a fresh client gets the entry added", () => {
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [patch("Claude Desktop", "added")],
      skills: [skill("vaultpilot-preflight", "installed")],
    });
    expect(env.status).toBe("installed");
    expect(env.clients_registered).toEqual(["Claude Desktop"]);
    expect(env.skills_installed).toEqual(["vaultpilot-preflight"]);
    expect(env.errors).toEqual([]);
    expect(env.next_steps[0]).toContain("Restart Claude Desktop");
  });

  it("reports 'already_installed' when a re-run finds everything already in place", () => {
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [
        patch("Claude Desktop", "already-present"),
        patch("Claude Code", "already-present"),
      ],
      skills: [
        skill("vaultpilot-preflight", "already-present"),
        skill("vaultpilot-setup", "already-present"),
      ],
    });
    expect(env.status).toBe("already_installed");
    expect(env.clients_registered).toEqual([]);
    expect(env.clients_already_present).toEqual(["Claude Desktop", "Claude Code"]);
    expect(env.skills_already_present).toEqual([
      "vaultpilot-preflight",
      "vaultpilot-setup",
    ]);
    expect(env.next_steps[0]).toMatch(/Already installed/i);
  });

  it("reports 'installed' (NOT already_installed) on a fresh box where every client is not-detected", () => {
    // No work was done, but nothing was already there either —
    // treating this as "already_installed" would be a lie. The
    // envelope should surface the not-detected clients so the agent
    // can tell the user to install Claude Desktop / Code.
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [
        patch("Claude Desktop", "not-detected"),
        patch("Claude Code", "not-detected"),
        patch("Cursor", "not-detected"),
      ],
      skills: [],
    });
    expect(env.status).toBe("installed");
    expect(env.clients_not_detected).toEqual([
      "Claude Desktop",
      "Claude Code",
      "Cursor",
    ]);
    expect(env.next_steps.some((s) => /No MCP clients were detected/i.test(s))).toBe(
      true,
    );
  });

  it("captures errors per-step instead of throwing the whole install", () => {
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [
        patch("Claude Desktop", "added"),
        patch("Cursor", "error", "EACCES on config write"),
      ],
      skills: [
        skill("vaultpilot-preflight", "installed"),
        skill("vaultpilot-setup", "error", "git clone timed out after 30s"),
      ],
    });
    expect(env.status).toBe("installed");
    expect(env.errors).toEqual([
      { source: "client:Cursor", message: "EACCES on config write" },
      { source: "skill:vaultpilot-setup", message: "git clone timed out after 30s" },
    ]);
    // Even with errors, the partial successes are still surfaced —
    // partial-progress reporting is the explicit design.
    expect(env.clients_registered).toEqual(["Claude Desktop"]);
    expect(env.skills_installed).toEqual(["vaultpilot-preflight"]);
  });

  it("preserves the package version + binary paths verbatim", () => {
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [],
      skills: [],
    });
    expect(env.version).toBe("0.8.2");
    expect(env.binaries).toEqual({ setup, server });
  });

  it("a mixed run (one already-present, one new) is 'installed', not 'already_installed'", () => {
    // Important: the threshold is "did THIS run change anything". If
    // any single new client / skill was added, we want the user to
    // restart their MCP client — so the envelope must report
    // "installed" (which triggers the restart instruction).
    const env = buildInstallEnvelope({
      version: "0.8.2",
      binaries: { setup, server },
      patches: [
        patch("Claude Desktop", "already-present"),
        patch("Claude Code", "added"),
      ],
      skills: [skill("vaultpilot-preflight", "already-present")],
    });
    expect(env.status).toBe("installed");
    expect(env.clients_registered).toEqual(["Claude Code"]);
    expect(env.next_steps[0]).toContain("Restart Claude Code");
  });
});
