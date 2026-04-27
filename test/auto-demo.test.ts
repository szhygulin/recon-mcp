/**
 * Auto-demo mode (issue #391/#392 follow-up).
 *
 * A fresh install with no config file boots into demo mode by default,
 * so an agent can offer personas + simulated signing without the user
 * editing `.claude.json` first. Auto-demo turns OFF the moment a
 * config file appears OR the user opts out via `VAULTPILOT_DEMO=false`.
 *
 * Detection runs once at boot and is latched for the process lifetime
 * (mirrors the env-var commitment: a mode change requires off-process
 * state + restart, which an in-session prompt injection can't reach).
 *
 * Tests cover:
 *   - the trigger table (env var × latched auto-detect → reason)
 *   - the latching invariant (detection result frozen for process)
 *   - `detectAutoDemoMode()` against real filesystem state via the
 *     `setConfigDirForTesting` hook
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

describe("getDemoModeReason — trigger table", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
  });

  it("env=true → explicit-env (demo on, regardless of disk state)", async () => {
    const { getDemoModeReason, isDemoMode, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    process.env[ENV_KEY] = "true";
    // Latch state shouldn't matter when env is the primary signal.
    _setAutoDemoLatchForTests(false);
    expect(getDemoModeReason()).toBe("explicit-env");
    expect(isDemoMode()).toBe(true);
    _setAutoDemoLatchForTests(true);
    expect(getDemoModeReason()).toBe("explicit-env");
    expect(isDemoMode()).toBe(true);
  });

  it("env=false → explicit-opt-out (demo off, even if no config)", async () => {
    const { getDemoModeReason, isDemoMode, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    process.env[ENV_KEY] = "false";
    // Even when fresh-install conditions hold, env=false suppresses.
    _setAutoDemoLatchForTests(true);
    expect(getDemoModeReason()).toBe("explicit-opt-out");
    expect(isDemoMode()).toBe(false);
  });

  it("env=invalid (e.g. '1') → invalid-env (demo off, even if no config)", async () => {
    const { getDemoModeReason, isDemoMode, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    process.env[ENV_KEY] = "1";
    _setAutoDemoLatchForTests(true);
    expect(getDemoModeReason()).toBe("invalid-env");
    // Critical: invalid env does NOT fall through to auto-demo. The
    // user tried to set the var; honoring that signal — by NOT
    // auto-flipping — keeps the behavior predictable.
    expect(isDemoMode()).toBe(false);
  });

  it("env unset + latched=true → auto-fresh-install (demo on)", async () => {
    const { getDemoModeReason, isDemoMode, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    _setAutoDemoLatchForTests(true);
    expect(getDemoModeReason()).toBe("auto-fresh-install");
    expect(isDemoMode()).toBe(true);
  });

  it("env unset + latched=false → off (demo off, normal mode)", async () => {
    const { getDemoModeReason, isDemoMode, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    _setAutoDemoLatchForTests(false);
    expect(getDemoModeReason()).toBe("off");
    expect(isDemoMode()).toBe(false);
  });

  it("env unset + latch never initialized → off (fail closed, real mode)", async () => {
    const { getDemoModeReason, isDemoMode, _resetAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    _resetAutoDemoLatchForTests();
    // Forgetting to call initDemoMode() must not silently flip the
    // server into demo mode — fail closed (real) is the safer default.
    expect(getDemoModeReason()).toBe("off");
    expect(isDemoMode()).toBe(false);
  });
});

describe("detectAutoDemoMode — readUserConfig signal", () => {
  // We mock readUserConfig directly rather than fixturing the
  // filesystem because `setConfigDirForTesting` only redirects the new
  // path (~/.vaultpilot-mcp/) — the legacy fallback path is fixed at
  // module-load time via homedir(), so a developer machine that has a
  // legacy ~/.recon-crypto-mcp/config.json will leak through. Mocking
  // is more deterministic.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns true when readUserConfig returns null (fresh install)", async () => {
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/config/user-config.js")
      >("../src/config/user-config.js");
      return { ...actual, readUserConfig: () => null };
    });
    const { detectAutoDemoMode } = await import("../src/demo/auto-detect.js");
    expect(detectAutoDemoMode()).toBe(true);
  });

  it("returns false when readUserConfig returns a config object (user has set up or paired)", async () => {
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/config/user-config.js")
      >("../src/config/user-config.js");
      return { ...actual, readUserConfig: () => ({} as unknown as never) };
    });
    const { detectAutoDemoMode } = await import("../src/demo/auto-detect.js");
    expect(detectAutoDemoMode()).toBe(false);
  });

  it("returns false on malformed config — fail closed (real mode) when state is ambiguous", async () => {
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
    const { detectAutoDemoMode } = await import("../src/demo/auto-detect.js");
    expect(detectAutoDemoMode()).toBe(false);
  });
});

describe("initDemoMode — latching invariant", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("freezes detection at first call: a config appearing mid-process does NOT flip the latched value", async () => {
    // Phase 1: boot with no config → detector returns true.
    let configPresent = false;
    vi.doMock("../src/config/user-config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/config/user-config.js")
      >("../src/config/user-config.js");
      return {
        ...actual,
        readUserConfig: () => (configPresent ? ({} as unknown as never) : null),
      };
    });
    const {
      initDemoMode,
      getDemoModeReason,
      _resetAutoDemoLatchForTests,
    } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
    initDemoMode();
    expect(getDemoModeReason()).toBe("auto-fresh-install");
    // Phase 2: user runs setup mid-session, config appears, but the
    // latched value stays `auto-fresh-install` until process restart.
    configPresent = true;
    initDemoMode();
    expect(getDemoModeReason()).toBe("auto-fresh-install");
  });

  it("subsequent initDemoMode() calls are no-ops (idempotent)", async () => {
    const {
      initDemoMode,
      getDemoModeReason,
      _resetAutoDemoLatchForTests,
      _setAutoDemoLatchForTests,
    } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
    _setAutoDemoLatchForTests(true);
    // initDemoMode should NOT overwrite the explicitly-set latch.
    initDemoMode();
    expect(getDemoModeReason()).toBe("auto-fresh-install");
  });
});

describe("buildGetDemoWalletResponse — auto-demo branch", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    const { _resetLiveWalletForTests } = await import(
      "../src/demo/live-mode.js"
    );
    _resetAutoDemoLatchForTests();
    _resetLiveWalletForTests();
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    const { _resetLiveWalletForTests } = await import(
      "../src/demo/live-mode.js"
    );
    _resetAutoDemoLatchForTests();
    _resetLiveWalletForTests();
  });

  it("auto-fresh-install: demoActive=true with reason='auto-fresh-install'", async () => {
    delete process.env[ENV_KEY];
    const { buildGetDemoWalletResponse, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(true);
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(true);
    if (r.demoActive) {
      expect(r.reason).toBe("auto-fresh-install");
      expect(r.envState).toBe("unset");
      expect(r.mode).toBe("default");
    }
  });

  it("explicit-opt-out: demoActive=false with reason='explicit-opt-out' and the right message", async () => {
    process.env[ENV_KEY] = "false";
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(false);
    if (!r.demoActive) {
      expect(r.reason).toBe("explicit-opt-out");
      expect(r.envState).toBe("disabled");
      expect(r.message).toContain("set to 'false'");
      expect(r.message).toContain("explicit opt-out");
    }
  });

  it("off (env unset + config present): message names the config-detected branch", async () => {
    delete process.env[ENV_KEY];
    const { buildGetDemoWalletResponse, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(false);
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(false);
    if (!r.demoActive) {
      expect(r.reason).toBe("off");
      expect(r.message).toContain("user config was detected at boot");
    }
  });
});

describe("alwaysGatedRefusalMessage — branches on reason", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
  });

  it("auto-fresh-install: leave path is `vaultpilot-mcp-setup`, not `unset VAULTPILOT_DEMO`", async () => {
    delete process.env[ENV_KEY];
    const { alwaysGatedRefusalMessage, _setAutoDemoLatchForTests } =
      await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(true);
    const msg = alwaysGatedRefusalMessage("pair_ledger_solana");
    expect(msg).toContain("Auto-demo is on");
    expect(msg).toContain("vaultpilot-mcp-setup");
    expect(msg).not.toContain("unset VAULTPILOT_DEMO and restart");
  });

  it("explicit-env: leave path is `unset VAULTPILOT_DEMO and restart` (existing copy preserved)", async () => {
    process.env[ENV_KEY] = "true";
    const { alwaysGatedRefusalMessage } = await import("../src/demo/index.js");
    const msg = alwaysGatedRefusalMessage("pair_ledger_btc");
    expect(msg).toContain("unset VAULTPILOT_DEMO and restart");
    expect(msg).not.toContain("Auto-demo is on");
  });
});
