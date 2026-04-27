/**
 * Tests for the lazy first-call skill auto-install machinery.
 *
 * Three things to lock:
 *   - kickoffSkillAutoInstall is idempotent (second call is a no-op).
 *   - State transitions correctly through the success path: not-attempted →
 *     in-progress → succeeded.
 *   - Failure path lands on `failed` with a useful detail; ENOENT (no git on
 *     PATH) gets a distinct, actionable message.
 *   - VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1 short-circuits everything to
 *     `not-attempted` so the existing manual-install notice fires.
 *   - Already-present skills never trigger a clone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execFile so the test never actually touches network or git.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: execFileMock,
  };
});

let tmpRoot = "";
let originalHome: string | undefined;
let originalDisable: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vp-autoinstall-"));
  originalHome = process.env.HOME;
  originalDisable = process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL;
  process.env.HOME = tmpRoot;
  delete process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL;
  execFileMock.mockReset();
  // Default mock: simulate a successful git clone that creates SKILL.md.
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: object, cb: (err: Error | null, out: string) => void) => {
      // git clone <url> <dest> — args[3] is the destination
      const dest = args[3];
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), "# fake skill\n");
      cb(null, "");
    },
  );
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDisable === undefined) delete process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL;
  else process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL = originalDisable;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe("kickoffSkillAutoInstall", () => {
  it("is idempotent — second call does not trigger a second clone", async () => {
    const { kickoffSkillAutoInstall, _resetAutoInstallForTests } = await import(
      "../src/setup/auto-install.js"
    );
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    kickoffSkillAutoInstall();
    kickoffSkillAutoInstall();

    // 2 skills × 1 clone each = 2 calls, never more.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("transitions not-attempted → in-progress → succeeded", async () => {
    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    expect(getAutoInstallState("vaultpilot-preflight").state).toBe("not-attempted");

    kickoffSkillAutoInstall();
    // Synchronously after kickoff, before the awaited execFileAsync resolves,
    // state is in-progress.
    expect(getAutoInstallState("vaultpilot-preflight").state).toBe("in-progress");

    // Drain the microtask queue so the awaited callback runs.
    await new Promise((r) => setImmediate(r));

    expect(getAutoInstallState("vaultpilot-preflight").state).toBe("succeeded");
    expect(getAutoInstallState("vaultpilot-setup").state).toBe("succeeded");
  });

  it("marks state=failed with a 'git is not on PATH' detail when execFile throws ENOENT", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
        cb(err);
      },
    );
    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    await new Promise((r) => setImmediate(r));

    const entry = getAutoInstallState("vaultpilot-preflight");
    expect(entry.state).toBe("failed");
    expect(entry.detail).toMatch(/git is not on PATH/);
  });

  it("marks state=failed with a generic detail when git clone exits non-zero", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error & { stderr?: string }) => void) => {
        const err = Object.assign(new Error("Command failed: git clone ..."), {
          stderr: "fatal: unable to access 'https://github.com/...': Could not resolve host",
        });
        cb(err);
      },
    );
    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    await new Promise((r) => setImmediate(r));

    const entry = getAutoInstallState("vaultpilot-preflight");
    expect(entry.state).toBe("failed");
    expect(entry.detail).toMatch(/git clone failed/);
    expect(entry.detail).toMatch(/Could not resolve host/);
  });

  it("VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1 → state stays not-attempted, no clone fires", async () => {
    process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL = "1";
    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    await new Promise((r) => setImmediate(r));

    expect(execFileMock).not.toHaveBeenCalled();
    expect(getAutoInstallState("vaultpilot-preflight").state).toBe("not-attempted");
    expect(getAutoInstallState("vaultpilot-setup").state).toBe("not-attempted");
  });

  it("skips already-present skill (SKILL.md exists at the install path)", async () => {
    // Pre-create the preflight skill marker so kickoff sees it as already-installed.
    const preflightDir = join(tmpRoot, ".claude", "skills", "vaultpilot-preflight");
    mkdirSync(preflightDir, { recursive: true });
    writeFileSync(join(preflightDir, "SKILL.md"), "# pre-existing\n");

    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    await new Promise((r) => setImmediate(r));

    expect(getAutoInstallState("vaultpilot-preflight").state).toBe("already-present");
    // Setup skill is not pre-created, so it still gets cloned.
    expect(getAutoInstallState("vaultpilot-setup").state).toBe("succeeded");
    // Exactly one clone (for setup), not two.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("treats a dangling skill directory (no SKILL.md inside) as failed and never clones", async () => {
    // Half-installed dir — exists, but has no SKILL.md inside.
    const preflightDir = join(tmpRoot, ".claude", "skills", "vaultpilot-preflight");
    mkdirSync(preflightDir, { recursive: true });

    const { kickoffSkillAutoInstall, getAutoInstallState, _resetAutoInstallForTests } =
      await import("../src/setup/auto-install.js");
    _resetAutoInstallForTests();

    kickoffSkillAutoInstall();
    await new Promise((r) => setImmediate(r));

    const entry = getAutoInstallState("vaultpilot-preflight");
    expect(entry.state).toBe("failed");
    expect(entry.detail).toMatch(/Path exists but has no SKILL.md/);
    expect(existsSync(join(preflightDir))).toBe(true);
  });
});
