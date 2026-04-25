/**
 * Tests for the agent-client auto-register module — mounts a temp HOME so
 * the `homedir()`-relative paths land somewhere we control, then exercises
 * the patch logic against synthetic fixtures.
 *
 * The MCP-server entry is dependent on this test file's runtime location
 * (it resolves via `import.meta.url`), so most tests pass an explicit
 * `serverEntry` opt to keep assertions deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClient,
  getClientConfigPaths,
  patchClientConfig,
  registerVaultPilotWithClients,
  summarizePatchResults,
} from "../src/setup/register-clients.js";

const FAKE_SERVER_ENTRY = {
  command: "node",
  args: ["/abs/dist/index.js"],
};

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-register-test-"));
  vi.spyOn({ homedir }, "homedir").mockReturnValue(tmpHome);
  // homedir() is imported by the module under test at module-evaluation
  // time; spying on the local import doesn't affect it. Override via the
  // HOME env var instead, which os.homedir() reads on POSIX.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("getClientConfigPaths", () => {
  it("includes Claude Desktop on the running platform with a non-empty path", () => {
    const paths = getClientConfigPaths();
    const claudeDesktop = paths.find((p) => p.client === "Claude Desktop");
    if (platform() !== "win32" || process.env.APPDATA) {
      expect(claudeDesktop).toBeDefined();
      expect(claudeDesktop!.configPath).toContain("Claude");
    }
  });

  it("includes Claude Code at ~/.claude.json", () => {
    const paths = getClientConfigPaths();
    const claudeCode = paths.find((p) => p.client === "Claude Code");
    expect(claudeCode).toBeDefined();
    expect(claudeCode!.configPath).toBe(join(homedir(), ".claude.json"));
  });

  it("includes Cursor at ~/.cursor/mcp.json", () => {
    const paths = getClientConfigPaths();
    const cursor = paths.find((p) => p.client === "Cursor");
    expect(cursor).toBeDefined();
    expect(cursor!.configPath).toBe(join(homedir(), ".cursor", "mcp.json"));
  });
});

describe("detectClient", () => {
  it("returns 'absent' when neither file nor parent exists", () => {
    const target = join(tmpHome, "no-such-app", "config.json");
    expect(detectClient(target)).toBe("absent");
  });

  it("returns 'installed' when parent dir exists but config does not", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    expect(detectClient(join(dir, "config.json"))).toBe("installed");
  });

  it("returns 'configured' when the config file itself exists", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    writeFileSync(file, "{}");
    expect(detectClient(file)).toBe("configured");
  });
});

describe("patchClientConfig", () => {
  it("returns 'not-detected' when the client isn't installed", () => {
    const result = patchClientConfig(
      "Imaginary",
      join(tmpHome, "no-such-dir", "config.json"),
      { serverEntry: FAKE_SERVER_ENTRY },
    );
    expect(result.status).toBe("not-detected");
  });

  it("creates the config file with the vaultpilot-mcp entry when the parent dir exists but config does not", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");

    const result = patchClientConfig("FakeApp", file, {
      serverEntry: FAKE_SERVER_ENTRY,
    });

    expect(result.status).toBe("added");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.mcpServers).toEqual({
      "vaultpilot-mcp": FAKE_SERVER_ENTRY,
    });
    // No backup when the file didn't exist before.
    expect(existsSync(`${file}.vaultpilot.bak`)).toBe(false);
  });

  it("preserves unrelated keys + adds vaultpilot-mcp alongside existing servers", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    const before = {
      foo: { bar: 1 },
      mcpServers: {
        "some-other-server": { command: "other", args: ["x"] },
      },
    };
    writeFileSync(file, JSON.stringify(before, null, 2));

    const result = patchClientConfig("FakeApp", file, {
      serverEntry: FAKE_SERVER_ENTRY,
    });

    expect(result.status).toBe("added");
    expect(existsSync(`${file}.vaultpilot.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.vaultpilot.bak`, "utf8"))).toEqual(
      before,
    );
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(after.foo).toEqual({ bar: 1 });
    expect(after.mcpServers).toEqual({
      "some-other-server": { command: "other", args: ["x"] },
      "vaultpilot-mcp": FAKE_SERVER_ENTRY,
    });
  });

  it("is idempotent — re-running on a config that already has vaultpilot-mcp returns 'already-present' without writing", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    const before = {
      mcpServers: {
        "vaultpilot-mcp": { command: "node", args: ["/different/path"] },
      },
    };
    writeFileSync(file, JSON.stringify(before, null, 2));

    const result = patchClientConfig("FakeApp", file, {
      serverEntry: FAKE_SERVER_ENTRY,
    });

    expect(result.status).toBe("already-present");
    // Existing entry not overwritten with the new server entry.
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(after.mcpServers).toEqual(before.mcpServers);
    // No backup created on the no-op path.
    expect(existsSync(`${file}.vaultpilot.bak`)).toBe(false);
  });

  it("returns 'error' when the existing config is malformed JSON, leaves the file untouched", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    const malformed = "{ not really json";
    writeFileSync(file, malformed);

    const result = patchClientConfig("FakeApp", file, {
      serverEntry: FAKE_SERVER_ENTRY,
    });

    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/malformed/i);
    // Original file untouched.
    expect(readFileSync(file, "utf8")).toBe(malformed);
    expect(existsSync(`${file}.vaultpilot.bak`)).toBe(false);
  });

  it("writes the config with 0o600 mode (configs may carry secrets)", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");

    patchClientConfig("FakeApp", file, { serverEntry: FAKE_SERVER_ENTRY });

    const { statSync } = require("node:fs") as typeof import("node:fs");
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("treats an empty-string config file as absent-content (still adds the entry without throwing)", () => {
    const dir = join(tmpHome, "FakeApp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    writeFileSync(file, "");

    const result = patchClientConfig("FakeApp", file, {
      serverEntry: FAKE_SERVER_ENTRY,
    });

    expect(result.status).toBe("added");
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(after.mcpServers).toEqual({ "vaultpilot-mcp": FAKE_SERVER_ENTRY });
  });
});

describe("registerVaultPilotWithClients (integration)", () => {
  it("returns one result per detected client + 'not-detected' for absent ones", () => {
    // Create only the Claude Code config dir/file so a single client is
    // detectable; leave Claude Desktop and Cursor absent.
    writeFileSync(join(tmpHome, ".claude.json"), "{}");

    const results = registerVaultPilotWithClients({
      serverEntry: FAKE_SERVER_ENTRY,
    });

    const byClient = new Map(results.map((r) => [r.client, r]));
    expect(byClient.get("Claude Code")?.status).toBe("added");
    // The other two clients should report not-detected.
    expect(byClient.get("Claude Desktop")?.status).toBe("not-detected");
    expect(byClient.get("Cursor")?.status).toBe("not-detected");
  });
});

describe("summarizePatchResults", () => {
  it("formats added / already-present / not-detected / error rows distinctly", () => {
    const out = summarizePatchResults([
      { client: "A", configPath: "/a", status: "added", detail: "Backup at /a.bak" },
      { client: "B", configPath: "/b", status: "already-present" },
      { client: "C", configPath: "/c", status: "not-detected" },
      { client: "D", configPath: "/d", status: "error", detail: "boom" },
    ]);
    expect(out).toContain("✓ Added: A");
    expect(out).toContain("Backup at /a.bak");
    expect(out).toContain("✓ Already configured: B");
    expect(out).toContain("Not detected: C");
    expect(out).toContain("✗ Error: D");
    expect(out).toContain("boom");
  });
});
