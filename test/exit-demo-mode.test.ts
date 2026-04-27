/**
 * Tests for the exit_demo_mode handoff guide (issue #371 follow-up — demo
 * → operational mode switch). Covers the decision-tree branches:
 *
 *   - not in demo → no-op response
 *   - hasLedger=false → deferral message
 *   - hasLedger=true / undefined + various chain combos → tailored steps
 *   - hasRunSetup=true → setup-wizard step is skipped / softened
 *   - copy-paste recipe matches the chain selection
 *   - cautions surface security warnings about real signing
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

beforeEach(async () => {
  delete process.env[ENV_KEY];
  const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
  _resetLiveWalletForTests();
  const { _resetRuntimeRpcOverridesForTests } = await import(
    "../src/data/runtime-rpc-overrides.js"
  );
  _resetRuntimeRpcOverridesForTests();
});

afterEach(async () => {
  delete process.env[ENV_KEY];
  const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
  _resetLiveWalletForTests();
  const { _resetRuntimeRpcOverridesForTests } = await import(
    "../src/data/runtime-rpc-overrides.js"
  );
  _resetRuntimeRpcOverridesForTests();
});

describe("exit_demo_mode — outside demo", () => {
  it("returns 'not-in-demo' outcome with a no-op-style message", async () => {
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({});
    expect(r.outcome).toBe("not-in-demo");
    expect(r.currentState.demoActive).toBe(false);
    expect(r.message).toContain("VAULTPILOT_DEMO is unset");
    expect(r.message).toContain("operational mode");
    expect(r.steps).toEqual([]);
    expect(r.copyPasteRecipe).toBeNull();
  });
});

describe("exit_demo_mode — hasLedger=false → deferral", () => {
  it("recommends staying in demo until the user has a Ledger", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: false });
    expect(r.outcome).toBe("deferred-no-ledger");
    expect(r.message).toContain("Real signing requires a Ledger");
    expect(r.message).toContain("non-custodial");
    // The deferral path includes a checklist item nudging the user to acquire one.
    expect(r.preflightChecklist.length).toBeGreaterThan(0);
    expect(r.preflightChecklist[0].item).toContain("Acquire a Ledger");
    // And a security caution about supply-chain pre-tampering.
    expect(r.cautions.join(" ")).toContain("ledger.com");
  });
});

describe("exit_demo_mode — hasLedger=true → ready-to-exit", () => {
  it("returns ready-to-exit with all sections populated when chains is omitted (defaults to ethereum)", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true });
    expect(r.outcome).toBe("ready-to-exit");
    expect(r.steps.length).toBeGreaterThan(0);
    // Ethereum default → Etherscan + Infura/Alchemy recommendations surface.
    const providerNames = r.recommendedProviders.map((p) => p.service).join(" ");
    expect(providerNames).toContain("Etherscan");
    expect(providerNames).toMatch(/Infura|Alchemy/);
    // Steps include setup wizard (command field) + restart action.
    const allActions = r.steps.map((s) => s.action).join(" ");
    const allCommands = r.steps.map((s) => s.command ?? "").join(" ");
    expect(allCommands).toContain("vaultpilot-mcp-setup");
    expect(allActions).toContain("Restart Claude Code");
    // Copy-paste recipe surfaces the EVM env-var slots.
    expect(r.copyPasteRecipe).toContain("ETHERSCAN_API_KEY");
    expect(r.copyPasteRecipe).toContain("WALLETCONNECT_PROJECT_ID");
    expect(r.copyPasteRecipe).not.toContain("VAULTPILOT_DEMO");
  });

  it("includes Helius recommendation + SOLANA_RPC_URL slot when chains includes solana", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true, chains: ["solana", "ethereum"] });
    expect(r.outcome).toBe("ready-to-exit");
    const providerNames = r.recommendedProviders.map((p) => p.service).join(" ");
    expect(providerNames).toContain("Helius");
    expect(r.copyPasteRecipe).toContain("SOLANA_RPC_URL");
    expect(r.copyPasteRecipe).toContain("helius-rpc.com");
  });

  it("includes TronGrid + TRON_API_KEY slot when chains includes tron", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true, chains: ["tron"] });
    const providerNames = r.recommendedProviders.map((p) => p.service).join(" ");
    expect(providerNames).toContain("TronGrid");
    expect(r.copyPasteRecipe).toContain("TRON_API_KEY");
  });

  it("hasRunSetup=true softens the setup-wizard step rather than skipping it", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true, hasRunSetup: true });
    const setupStep = r.steps.find((s) =>
      s.action.includes("setup wizard") || s.action.includes("config already exists"),
    );
    expect(setupStep).toBeDefined();
    expect(setupStep!.action).toContain("config already exists");
    expect(setupStep!.note).toContain("idempotent");
  });

  it("hasRunSetup=false / undefined includes the full setup-wizard walkthrough", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true });
    const setupStep = r.steps.find((s) =>
      s.action.includes("setup wizard") || s.action.includes("Run the setup"),
    );
    expect(setupStep).toBeDefined();
    expect(setupStep!.command).toContain("vaultpilot-mcp-setup");
  });

  it("hasLedger=undefined adds a 'verify Ledger first' checklist item + caution", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({});
    expect(r.outcome).toBe("ready-to-exit");
    const cklItems = r.preflightChecklist.map((c) => c.item).join(" ");
    expect(cklItems).toContain("Confirm your Ledger");
    expect(r.cautions[0]).toContain("Confirm with the user FIRST");
  });

  it("currentState reflects live-mode active status", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const { setLivePersona } = await import("../src/demo/live-mode.js");
    setLivePersona("defi-power-user");
    const r = buildExitDemoGuide({ hasLedger: true });
    expect(r.currentState.subMode).toBe("live");
    expect(r.currentState.activePersonaId).toBe("defi-power-user");
    expect(r.message).toContain("LIVE");
    expect(r.message).toContain("defi-power-user");
  });

  it("cautions cover real-money + Ledger-verification + non-custodial", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true });
    const allCautions = r.cautions.join(" ");
    expect(allCautions).toContain("Real transactions move real money");
    expect(allCautions).toContain("non-custodial");
    expect(allCautions).toMatch(/decoded calldata|prepare-receipt/);
  });

  it("whatYoullGain + whatYoullLose are non-empty arrays of human-readable strings", async () => {
    process.env[ENV_KEY] = "true";
    const { buildExitDemoGuide } = await import("../src/demo/exit-flow.js");
    const r = buildExitDemoGuide({ hasLedger: true });
    expect(r.whatYoullGain.length).toBeGreaterThan(0);
    expect(r.whatYoullLose.length).toBeGreaterThan(0);
    expect(r.whatYoullGain.join(" ")).toContain("Real signing");
    expect(r.whatYoullLose.join(" ").toLowerCase()).toContain("simulated");
  });
});

describe("exit_demo_mode — refusal messages reference exit_demo_mode (discoverability)", () => {
  it("alwaysGatedRefusalMessage mentions exit_demo_mode", async () => {
    const { alwaysGatedRefusalMessage } = await import("../src/demo/index.js");
    const msg = alwaysGatedRefusalMessage("pair_ledger_solana");
    expect(msg).toContain("exit_demo_mode");
  });

  it("defaultModeRefusalMessage mentions exit_demo_mode as the alternative path", async () => {
    const { defaultModeRefusalMessage } = await import("../src/demo/index.js");
    const msg = defaultModeRefusalMessage("prepare_native_send");
    expect(msg).toContain("exit_demo_mode");
    // Original set_demo_wallet path is still surfaced — the alternative.
    expect(msg).toContain("set_demo_wallet");
  });
});
