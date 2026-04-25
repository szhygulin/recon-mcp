/**
 * Tests for `install-skills.ts`. Uses a temp HOME so every run starts from
 * a clean `~/.claude/skills/` and doesn't touch the user's real skills.
 *
 * `git clone` is mocked via a stubbed `execFileSync` so we don't hit the
 * network — the tests exercise the argument shape, the idempotent path, the
 * "git missing" fallback, and the summary formatting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileMock(...args),
  };
});

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-skills-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  execFileMock.mockReset();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("getSkillTargets", () => {
  it("returns preflight first, then setup, both under ~/.claude/skills/", async () => {
    const { getSkillTargets } = await import("../src/setup/install-skills.js");
    const targets = getSkillTargets();
    expect(targets.map((t) => t.name)).toEqual([
      "vaultpilot-preflight",
      "vaultpilot-setup",
    ]);
    for (const t of targets) {
      expect(t.installPath).toContain(join(".claude", "skills"));
      expect(t.repoUrl).toMatch(/^https:\/\/github\.com\/.*\.git$/);
    }
  });
});

describe("installSkill", () => {
  it("invokes git clone with depth=1 when the skill isn't installed", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown) => {
      // Simulate success — normally `git clone` would create the dir + files,
      // so we emulate that too.
      const dest = (_args as string[])[_args.length - 1]!;
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), "mock");
      return "";
    });
    const { installSkill, getSkillTargets } = await import(
      "../src/setup/install-skills.js"
    );
    const target = getSkillTargets()[0]!;
    const result = installSkill(target);

    expect(result.status).toBe("installed");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", target.repoUrl, target.installPath],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("short-circuits to already-present when SKILL.md exists", async () => {
    const { installSkill, getSkillTargets } = await import(
      "../src/setup/install-skills.js"
    );
    const target = getSkillTargets()[0]!;
    mkdirSync(target.installPath, { recursive: true });
    writeFileSync(join(target.installPath, "SKILL.md"), "# user's own clone");

    const result = installSkill(target);
    expect(result.status).toBe("already-present");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses to clone into an existing directory without SKILL.md", async () => {
    const { installSkill, getSkillTargets } = await import(
      "../src/setup/install-skills.js"
    );
    const target = getSkillTargets()[0]!;
    mkdirSync(target.installPath, { recursive: true });
    // No SKILL.md inside — dangling directory.

    const result = installSkill(target);
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/no SKILL\.md/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("surfaces a clear message when git is not on PATH (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const { installSkill, getSkillTargets } = await import(
      "../src/setup/install-skills.js"
    );
    const result = installSkill(getSkillTargets()[0]!);
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/git is not on PATH/);
  });

  it("captures stderr on a regular clone failure", async () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "fatal: unable to access ...: Could not resolve host: github.com\n",
    });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const { installSkill, getSkillTargets } = await import(
      "../src/setup/install-skills.js"
    );
    const result = installSkill(getSkillTargets()[0]!);
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/Could not resolve host/);
  });
});

describe("installAllSkills + summarizeSkillInstalls", () => {
  it("returns one result per target and formats a human summary", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const dest = args[args.length - 1]!;
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), "mock");
      return "";
    });
    const { installAllSkills, summarizeSkillInstalls } = await import(
      "../src/setup/install-skills.js"
    );
    const results = installAllSkills();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "installed")).toBe(true);

    const summary = summarizeSkillInstalls(results);
    expect(summary).toContain("vaultpilot-preflight");
    expect(summary).toContain("vaultpilot-setup");
    expect(summary).toContain("Installed");
  });
});
