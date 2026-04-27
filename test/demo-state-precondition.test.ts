/**
 * Issue #409 — demo mode can't walk through state-dependent multi-step
 * flows because simulated sends don't mutate real chain state. The
 * minimum-viable fix (Option B) is to surface a one-shot advisory
 * hint when a `prepare_*` fails in demo mode, so the agent doesn't
 * loop the user through a fix that's itself another simulation.
 *
 * Coverage:
 *   - `demoStatePreconditionHint` returns null outside demo mode.
 *   - Returns null for non-`prepare_*` tool names (the loop class is
 *     specific to state-changing prepare flows).
 *   - Returns a structured `[VAULTPILOT_DEMO]` hint for prepare_* in
 *     demo mode.
 *   - Dedups: subsequent calls for the same tool return null.
 *   - Different prepare_* tools each get their own one-shot.
 *   - Reset hook clears dedup for test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

describe("issue #409 — demoStatePreconditionHint", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    const {
      _resetAutoDemoLatchForTests,
      _resetStatePreconditionHintDedup,
    } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
    _resetStatePreconditionHintDedup();
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    const {
      _resetAutoDemoLatchForTests,
      _resetStatePreconditionHintDedup,
    } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
    _resetStatePreconditionHintDedup();
  });

  it("returns null when demo mode is OFF (env unset, no auto-demo latch)", async () => {
    delete process.env[ENV_KEY];
    const { demoStatePreconditionHint } = await import("../src/demo/index.js");
    expect(demoStatePreconditionHint("prepare_marinade_stake")).toBeNull();
  });

  it("returns null for non-prepare_* tool names (read tools, signing tools)", async () => {
    process.env[ENV_KEY] = "true";
    const {
      demoStatePreconditionHint,
      _resetStatePreconditionHintDedup,
    } = await import("../src/demo/index.js");
    _resetStatePreconditionHintDedup();
    expect(demoStatePreconditionHint("get_lending_positions")).toBeNull();
    expect(demoStatePreconditionHint("send_transaction")).toBeNull();
    expect(demoStatePreconditionHint("preview_solana_send")).toBeNull();
    expect(demoStatePreconditionHint("set_demo_wallet")).toBeNull();
  });

  it("returns the hint for prepare_* in demo mode (explicit env)", async () => {
    process.env[ENV_KEY] = "true";
    const { demoStatePreconditionHint } = await import("../src/demo/index.js");
    const hint = demoStatePreconditionHint("prepare_marinade_stake");
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/^\[VAULTPILOT_DEMO\]/);
    expect(hint).toContain("prepare_marinade_stake");
    expect(hint).toContain("state-changing prerequisites");
    // Names the leave path so the agent can offer it to the user.
    expect(hint).toContain("VAULTPILOT_DEMO=false");
    expect(hint).toContain("vaultpilot-mcp-setup");
    // Self-labels as advisory so a defensive agent doesn't treat it
    // as an authoritative diagnosis.
    expect(hint).toContain("ignore this hint");
  });

  it("returns the hint under auto-demo (env unset + latched)", async () => {
    delete process.env[ENV_KEY];
    const {
      demoStatePreconditionHint,
      _setAutoDemoLatchForTests,
    } = await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(true);
    const hint = demoStatePreconditionHint("prepare_aave_borrow");
    expect(hint).not.toBeNull();
    expect(hint).toContain("prepare_aave_borrow");
  });

  it("dedupes per (tool, session) — second call for same tool returns null", async () => {
    process.env[ENV_KEY] = "true";
    const { demoStatePreconditionHint } = await import("../src/demo/index.js");
    const first = demoStatePreconditionHint("prepare_marinade_stake");
    const second = demoStatePreconditionHint("prepare_marinade_stake");
    const third = demoStatePreconditionHint("prepare_marinade_stake");
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
  });

  it("dedup is per-tool, not global — different prepare_* each get one shot", async () => {
    process.env[ENV_KEY] = "true";
    const { demoStatePreconditionHint } = await import("../src/demo/index.js");
    expect(demoStatePreconditionHint("prepare_marinade_stake")).not.toBeNull();
    // After firing for marinade, a different prepare_* still fires.
    expect(demoStatePreconditionHint("prepare_aave_borrow")).not.toBeNull();
    expect(demoStatePreconditionHint("prepare_solana_swap")).not.toBeNull();
    // But each only fires once.
    expect(demoStatePreconditionHint("prepare_marinade_stake")).toBeNull();
    expect(demoStatePreconditionHint("prepare_aave_borrow")).toBeNull();
  });

  it("reset hook clears dedup so tests can simulate a fresh session", async () => {
    process.env[ENV_KEY] = "true";
    const {
      demoStatePreconditionHint,
      _resetStatePreconditionHintDedup,
    } = await import("../src/demo/index.js");
    expect(demoStatePreconditionHint("prepare_marinade_stake")).not.toBeNull();
    expect(demoStatePreconditionHint("prepare_marinade_stake")).toBeNull();
    _resetStatePreconditionHintDedup();
    expect(demoStatePreconditionHint("prepare_marinade_stake")).not.toBeNull();
  });
});

describe("issue #409 side-note — Solana handle in broadcastSimulationDispatch", () => {
  it("hasSolanaDraft returns false for unknown handles, true after issueSolanaDraftHandle", async () => {
    const { issueSolanaDraftHandle, hasSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    expect(hasSolanaDraft("nonexistent-handle-xyz")).toBe(false);

    // Minimal draft shape — issueSolanaDraftHandle takes a SolanaTxDraft;
    // the test just needs the handle to round-trip through the store, not
    // to be a valid signable draft.
    const fakeDraft = {
      action: "nonce_init" as const,
      wallet: "test-wallet",
      meta: {},
      // The draft's other fields are unused by hasSolanaDraft (which
      // only consults the Map's keys); cast to unknown to skip typing
      // the full shape.
    } as unknown as Parameters<typeof issueSolanaDraftHandle>[0];
    const { handle } = issueSolanaDraftHandle(fakeDraft);
    expect(hasSolanaDraft(handle)).toBe(true);
  });
});
