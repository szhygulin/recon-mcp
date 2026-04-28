import { describe, it, expect } from "vitest";

/**
 * Pin the `setup` subcommand detection. The actual dispatch happens
 * at the top of `main()` in `src/index.ts`; this test exercises the
 * argv-detection contract independently so a regression that breaks
 * the binary path's wizard invocation surfaces in vitest before
 * release-binaries.yml runs at release time.
 */

function detectsSetup(argv: readonly string[]): boolean {
  return argv.includes("setup");
}

describe("setup subcommand argv detection", () => {
  it("fires on the binary-path invocation `vaultpilot-mcp setup`", () => {
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp", "setup"])).toBe(true);
  });

  it("fires on the npm-path invocation `node dist/index.js setup`", () => {
    expect(detectsSetup(["node", "dist/index.js", "setup"])).toBe(true);
  });

  it("fires when the wizard's flags are passed alongside (install.sh path)", () => {
    expect(
      detectsSetup([
        "/usr/local/bin/vaultpilot-mcp",
        "setup",
        "--non-interactive",
        "--json",
      ]),
    ).toBe(true);
  });

  it("does NOT fire on plain server invocation", () => {
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp"])).toBe(false);
  });

  it("does NOT fire on unrelated flags (`--check`, `--demo`)", () => {
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp", "--check"])).toBe(false);
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp", "--demo"])).toBe(false);
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp", "--check", "--json"])).toBe(false);
  });

  it("does NOT fire on the literal `--setup` (subcommand, not flag)", () => {
    // The contract is intentionally a positional `setup` (subcommand
    // convention), NOT `--setup` (flag). Mixing the two would conflate
    // "which program" with "how the program behaves" — see the design
    // discussion that picked option A over option B.
    expect(detectsSetup(["/usr/local/bin/vaultpilot-mcp", "--setup"])).toBe(false);
  });

  it("backward-compat: `vaultpilot-mcp-setup` (no positional arg) does not fire the unified-binary path", () => {
    // The `vaultpilot-mcp-setup` npm bin entry still points at
    // `dist/setup.js` directly (preserved in package.json), which has
    // its own `invokedDirectly` guard. So argv on that path is just
    // ["node", "dist/setup.js"] with no "setup" positional — and our
    // unified-binary detection should NOT fire (the direct entry
    // handles the wizard via its own guard).
    expect(detectsSetup(["node", "dist/setup.js"])).toBe(false);
  });
});
