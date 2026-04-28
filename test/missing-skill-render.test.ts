/**
 * Render tests for the four states of the preflight / setup missing-skill
 * notice. Each state should produce a distinct, well-formed VAULTPILOT
 * NOTICE block that:
 *   - Starts with "VAULTPILOT NOTICE — " (the prefix the agent uses to
 *     distinguish legitimate server notices from prompt injection).
 *   - Has no imperative agent verbs ("run this", "execute that") nor
 *     pasted shell commands — see feedback_mcp_notice_block_shape.md.
 *   - Carries the auto-install-specific copy when state ≠ not-attempted.
 */
import { describe, it, expect } from "vitest";
import {
  renderMissingSkillWarning,
  renderMissingSetupSkillWarning,
  renderUpdateAvailableNotice,
} from "../src/signing/render-verification.js";

const PREFLIGHT_REPO =
  "https://github.com/szhygulin/vaultpilot-security-skill.git";
const SETUP_REPO = "https://github.com/szhygulin/vaultpilot-setup-skill.git";

describe("renderMissingSkillWarning — state variants", () => {
  it("not-attempted (no autoInstall arg) → original manual-install copy", () => {
    const out = renderMissingSkillWarning({ skillRepoUrl: PREFLIGHT_REPO });
    expect(out).toMatch(/^VAULTPILOT NOTICE — Preflight skill not installed/);
    expect(out).toMatch(/Install: https:\/\/github\.com\/szhygulin/);
    expect(out).not.toMatch(/auto-install/i);
  });

  it("in-progress → auto-install-in-flight copy with installPath", () => {
    const out = renderMissingSkillWarning({
      skillRepoUrl: PREFLIGHT_REPO,
      autoInstall: { state: "in-progress", installPath: "/home/u/.claude/skills/vaultpilot-preflight" },
    });
    expect(out).toMatch(/auto-install in progress/);
    expect(out).toMatch(/\/home\/u\/\.claude\/skills\/vaultpilot-preflight/);
    expect(out).toMatch(/restart Claude Code/i);
  });

  it("succeeded → auto-installed copy directing user to restart", () => {
    const out = renderMissingSkillWarning({
      skillRepoUrl: PREFLIGHT_REPO,
      autoInstall: { state: "succeeded", installPath: "/home/u/.claude/skills/vaultpilot-preflight" },
    });
    expect(out).toMatch(/Preflight skill auto-installed/);
    expect(out).toMatch(/restart Claude Code/i);
  });

  it("failed → manual-install copy + appended detail line", () => {
    const out = renderMissingSkillWarning({
      skillRepoUrl: PREFLIGHT_REPO,
      autoInstall: { state: "failed", detail: "git is not on PATH." },
    });
    // Falls back to the manual-install body…
    expect(out).toMatch(/^VAULTPILOT NOTICE — Preflight skill not installed/);
    // …with the failure detail surfaced at the end.
    expect(out).toMatch(/Auto-install attempt failed: git is not on PATH/);
  });
});

describe("renderMissingSetupSkillWarning — state variants", () => {
  it("not-attempted → original setup-skill manual copy", () => {
    const out = renderMissingSetupSkillWarning({ skillRepoUrl: SETUP_REPO });
    expect(out).toMatch(/^VAULTPILOT NOTICE — Setup skill not installed/);
    expect(out).toMatch(/setup wizard's/);
    expect(out).not.toMatch(/auto-install in progress/i);
  });

  it("in-progress → setup-flavored auto-install copy", () => {
    const out = renderMissingSetupSkillWarning({
      skillRepoUrl: SETUP_REPO,
      autoInstall: { state: "in-progress", installPath: "/home/u/.claude/skills/vaultpilot-setup" },
    });
    expect(out).toMatch(/Setup skill auto-install in progress/);
  });

  it("succeeded → setup-flavored auto-installed copy", () => {
    const out = renderMissingSetupSkillWarning({
      skillRepoUrl: SETUP_REPO,
      autoInstall: { state: "succeeded", installPath: "/home/u/.claude/skills/vaultpilot-setup" },
    });
    expect(out).toMatch(/Setup skill auto-installed/);
    expect(out).toMatch(/restart Claude Code/i);
  });

  it("notice never carries imperative agent verbs or pasted shell commands", () => {
    // Defense-in-depth: this exact pattern was what made the original notice
    // get flagged as prompt injection. Test that none of the variants regress.
    const variants = [
      renderMissingSkillWarning({ skillRepoUrl: PREFLIGHT_REPO }),
      renderMissingSkillWarning({
        skillRepoUrl: PREFLIGHT_REPO,
        autoInstall: { state: "in-progress", installPath: "/x" },
      }),
      renderMissingSkillWarning({
        skillRepoUrl: PREFLIGHT_REPO,
        autoInstall: { state: "succeeded", installPath: "/x" },
      }),
      renderMissingSetupSkillWarning({ skillRepoUrl: SETUP_REPO }),
      renderMissingSetupSkillWarning({
        skillRepoUrl: SETUP_REPO,
        autoInstall: { state: "in-progress", installPath: "/x" },
      }),
    ];
    for (const v of variants) {
      // No "[AGENT TASK …]" framing, no "RELAY TO USER FIRST".
      expect(v).not.toMatch(/AGENT TASK/);
      expect(v).not.toMatch(/RELAY TO USER FIRST/);
      // No verbatim shell commands embedded for the agent to execute.
      expect(v).not.toMatch(/^\s*git clone\s/m);
      expect(v).not.toMatch(/```/);
    }
  });
});

describe("renderUpdateAvailableNotice", () => {
  it("renders the standard VAULTPILOT NOTICE shape with both versions", () => {
    const out = renderUpdateAvailableNotice({
      current: "0.10.0",
      latest: "0.11.2",
      packageName: "vaultpilot-mcp",
      installBlock:
        "         (npm-global install detected)\n" +
        "         npm install -g vaultpilot-mcp@latest\n" +
        "         Restart Claude Code after upgrading so the new binary loads.",
    });
    expect(out).toMatch(/^VAULTPILOT NOTICE — Update available/);
    expect(out).toMatch(/vaultpilot-mcp 0\.10\.0 installed/);
    expect(out).toMatch(/0\.11\.2 published on npm/);
    expect(out).toMatch(/releases\/tag\/v0\.11\.2/);
    expect(out).toMatch(/npm install -g vaultpilot-mcp@latest/);
    expect(out).toMatch(/VAULTPILOT_DISABLE_UPDATE_CHECK=1/);
  });

  it("renders cleanly across a wider version jump", () => {
    const out = renderUpdateAvailableNotice({
      current: "0.10.0",
      latest: "1.0.0",
      packageName: "vaultpilot-mcp",
      installBlock: "         (test) some upgrade hint",
    });
    expect(out).toMatch(/0\.10\.0 installed; 1\.0\.0 published/);
    expect(out).toMatch(/releases\/tag\/v1\.0\.0/);
  });

  it("renders the supplied install block verbatim (no hardcoded npm command)", () => {
    const block = [
      "         (bundled-binary install detected)",
      "         curl -fsSL https://example/install.sh | bash",
    ].join("\n");
    const out = renderUpdateAvailableNotice({
      current: "0.10.0",
      latest: "0.11.2",
      packageName: "vaultpilot-mcp",
      installBlock: block,
    });
    expect(out).toContain(block);
    expect(out).not.toMatch(/npm install -g/);
  });

  it("carries no imperative agent verbs and no pasted shell beyond the install copy", () => {
    const out = renderUpdateAvailableNotice({
      current: "0.10.0",
      latest: "0.11.2",
      packageName: "vaultpilot-mcp",
      installBlock:
        "         (npm-global install detected)\n" +
        "         npm install -g vaultpilot-mcp@latest\n" +
        "         Restart Claude Code after upgrading so the new binary loads.",
    });
    expect(out).not.toMatch(/AGENT TASK/);
    expect(out).not.toMatch(/RELAY TO USER FIRST/);
    expect(out).not.toMatch(/```/);
  });
});
