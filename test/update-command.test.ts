/**
 * Tests for the `get_update_command` tool. Asserts the structured shape
 * the agent will see across the update / no-update / install-path-
 * unknown / version-check-unresolved branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUpdateCommand } from "../src/modules/diagnostics/update-command.js";
import {
  _resetInstallPathCacheForTests,
} from "../src/shared/install-path.js";
import {
  _resetUpdateCheckForTests,
  _setFetchForTests,
  kickoffUpdateCheck,
} from "../src/shared/version-check.js";

const ORIGINAL_ARGV = [...process.argv];

function setArgv(argv0: string, argv1: string): void {
  process.argv = [argv0, argv1, ...ORIGINAL_ARGV.slice(2)];
  _resetInstallPathCacheForTests();
}

function makeFetch(version: string) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ version }) }) as Response);
}

beforeEach(() => {
  _resetUpdateCheckForTests();
  _resetInstallPathCacheForTests();
  delete process.env.VAULTPILOT_DISABLE_UPDATE_CHECK;
});

afterEach(() => {
  _setFetchForTests(null);
  process.argv = ORIGINAL_ARGV;
  _resetUpdateCheckForTests();
  _resetInstallPathCacheForTests();
  delete process.env.VAULTPILOT_DISABLE_UPDATE_CHECK;
});

describe("getUpdateCommand", () => {
  it("returns updateAvailable=false with a null latest before the version check resolves", () => {
    setArgv("/usr/bin/node", "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js");
    const r = getUpdateCommand();
    expect(r.latest).toBeNull();
    expect(r.updateAvailable).toBe(false);
    expect(r.installPath).toBe("npm-global");
    expect(r.command).toBe("npm install -g vaultpilot-mcp@latest");
    expect(r.note).toMatch(/hasn't resolved yet/);
  });

  it("returns updateAvailable=true when the registry has a newer stable", async () => {
    setArgv("/usr/bin/node", "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js");
    _setFetchForTests(makeFetch("999.0.0"));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    const r = getUpdateCommand();
    expect(r.latest).toBe("999.0.0");
    expect(r.updateAvailable).toBe(true);
    expect(r.installPath).toBe("npm-global");
    expect(r.note).toBeUndefined();
  });

  it("returns updateAvailable=false when latest equals current", async () => {
    setArgv("/usr/bin/node", "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js");
    _setFetchForTests(makeFetch("0.0.0"));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    const r = getUpdateCommand();
    expect(r.latest).toBe("0.0.0");
    expect(r.updateAvailable).toBe(false);
    // `note` is undefined here — installPath known, latest known.
    expect(r.note).toBeUndefined();
  });

  it("surfaces a defer-to-INSTALL.md note when install path is unknown", async () => {
    setArgv("/usr/bin/node", "/var/some/non-conventional/place/index.js");
    _setFetchForTests(makeFetch("999.0.0"));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    const r = getUpdateCommand();
    expect(r.installPath).toBe("unknown");
    expect(r.note).toMatch(/INSTALL\.md/);
  });

  it("returns the bundled-binary command when argv[0] is the SEA binary", async () => {
    setArgv("/home/u/.local/bin/vaultpilot-mcp-linux-x64-0.11.0", "");
    _setFetchForTests(makeFetch("999.0.0"));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    const r = getUpdateCommand();
    expect(r.installPath).toBe("bundled-binary");
    expect(r.command).toMatch(/install\.sh \| bash/);
    expect(r.updateAvailable).toBe(true);
  });
});
