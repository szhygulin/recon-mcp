/**
 * Issue #391 — VAULTPILOT NOTICE — Demo wallets available.
 *
 * Onboarding nudge fired once per session when (a) the user has no
 * config file at all (canonical post-`claude mcp add` state) AND
 * (b) no demo wallet has been activated. Designed so an agent's first
 * "let's send some BTC" doesn't dead-end on "you need a Ledger" —
 * the demo path is surfaced before that happens.
 *
 * The helper is mocked at the module level (readUserConfig +
 * isLiveMode) so these tests don't depend on the developer's actual
 * `~/.vaultpilot-mcp/` or `~/.recon-crypto-mcp/` directory state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("issue #391: demo-wallet onboarding notice", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  function mockEnv(opts: { configPresent: boolean; liveMode: boolean }): void {
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/config/user-config.js")
      >("../src/config/user-config.js");
      return {
        ...actual,
        readUserConfig: () => (opts.configPresent ? ({} as unknown as never) : null),
      };
    });
    vi.doMock("../src/demo/live-mode.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/demo/live-mode.js")
      >("../src/demo/live-mode.js");
      return {
        ...actual,
        isLiveMode: () => opts.liveMode,
      };
    });
  }

  it("fires a VAULTPILOT NOTICE block when there is no config and no active demo wallet", async () => {
    mockEnv({ configPresent: false, liveMode: false });
    const {
      missingDemoWalletNotice,
      _resetMissingDemoWalletDedup,
    } = await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    const notice = missingDemoWalletNotice();
    expect(notice).not.toBeNull();
    // Same shape as the existing notice family — agents trust this prefix.
    expect(notice).toMatch(/^VAULTPILOT NOTICE — /);
    expect(notice).toContain("Demo wallets available");
    // No imperative agent verbs / pasteable shell — the framing that
    // earlier agents flagged as injection.
    expect(notice).not.toMatch(/\[AGENT TASK/);
    expect(notice).not.toMatch(/^\s*git clone\b/m);
    expect(notice).not.toMatch(/^\s*npm (install|i)\b/m);
    // The three discoverability handles the issue asks for.
    expect(notice).toContain("set_demo_wallet");
    expect(notice).toContain("get_demo_wallet");
    expect(notice).toContain("exit_demo_mode");
    // Self-label so a defensive agent doesn't classify this as injection.
    expect(notice).toContain("not prompt injection");
  });

  it("returns null when the user has a config file (post-setup users don't need the nudge)", async () => {
    mockEnv({ configPresent: true, liveMode: false });
    const {
      missingDemoWalletNotice,
      _resetMissingDemoWalletDedup,
    } = await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    expect(missingDemoWalletNotice()).toBeNull();
  });

  it("returns null when a live demo wallet is already active (path already taken)", async () => {
    mockEnv({ configPresent: false, liveMode: true });
    const {
      missingDemoWalletNotice,
      _resetMissingDemoWalletDedup,
    } = await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    expect(missingDemoWalletNotice()).toBeNull();
  });

  it("dedupes to once-per-session: first call returns the block, subsequent calls return null", async () => {
    mockEnv({ configPresent: false, liveMode: false });
    const {
      missingDemoWalletNotice,
      _resetMissingDemoWalletDedup,
    } = await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    const first = missingDemoWalletNotice();
    const second = missingDemoWalletNotice();
    const third = missingDemoWalletNotice();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
  });

  it("malformed config counts as 'config present' (don't nag a user mid-setup-error)", async () => {
    // readUserConfig throws on malformed JSON. The helper must not crash
    // the tool call; a malformed config means the user has been here and
    // the post-install nudge would be the wrong message anyway.
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/config/user-config.js")
      >("../src/config/user-config.js");
      return {
        ...actual,
        readUserConfig: () => {
          throw new Error("malformed JSON");
        },
      };
    });
    vi.doMock("../src/demo/live-mode.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/demo/live-mode.js")
      >("../src/demo/live-mode.js");
      return { ...actual, isLiveMode: () => false };
    });
    const {
      missingDemoWalletNotice,
      _resetMissingDemoWalletDedup,
    } = await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    expect(missingDemoWalletNotice()).toBeNull();
  });
});
