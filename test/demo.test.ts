/**
 * Demo-mode unit tests (issue #371 PR 4 — write-flow demo).
 *
 * The fixture-based read-only demo (PR #372 / #374 / #377) was removed in
 * favor of a real-RPC + simulated-broadcast model. The test surface here
 * covers the new contract:
 *
 *   - `isDemoMode()` reads VAULTPILOT_DEMO at call time;
 *   - `isAlwaysGatedTool()` classifies the tools that refuse regardless
 *     of live-mode state (pair_ledger_*, sign_message_*, request_capability);
 *   - `isConditionallyGatedTool()` classifies prepare_*, send_transaction,
 *     preview_send / preview_solana_send, verify_tx_decode,
 *     get_verification_artifact — gated in default demo mode, mostly
 *     un-gated in live mode (only send_transaction stays intercepted);
 *   - `isBroadcastTool()` is the single entry point for "this is the one
 *     tool whose live-mode behavior is intercepted to a simulation envelope";
 *   - the refusal-message helpers are stable strings that agents can
 *     pattern-match on the [VAULTPILOT_DEMO] prefix;
 *   - the simulation-envelope builder produces the right shape;
 *   - live-mode state mgmt (set persona, set custom, clear, get current).
 *
 * Wrapper-level integration (the real registerTool flow) is exercised
 * indirectly: spinning up the full server in a unit test is heavy, the
 * wrapper is a thin composition over already-tested primitives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

describe("isDemoMode — reads env at call time", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("returns true only when VAULTPILOT_DEMO is exactly 'true'", async () => {
    const { isDemoMode } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "true";
    expect(isDemoMode()).toBe(true);
    process.env[ENV_KEY] = "TRUE"; // strictly case-sensitive
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "1";
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "yes";
    expect(isDemoMode()).toBe(false);
  });
});

describe("isAlwaysGatedTool — classifies the never-allowed-in-demo set", () => {
  it("classifies pair_ledger_* / sign_message_* prefixes as always-gated", async () => {
    const { isAlwaysGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("pair_ledger_live")).toBe(true);
    expect(isAlwaysGatedTool("pair_ledger_btc")).toBe(true);
    expect(isAlwaysGatedTool("pair_ledger_solana")).toBe(true);
    expect(isAlwaysGatedTool("pair_ledger_tron")).toBe(true);
    expect(isAlwaysGatedTool("sign_message_btc")).toBe(true);
    expect(isAlwaysGatedTool("sign_message_ltc")).toBe(true);
  });

  it("classifies request_capability as always-gated (off-process write)", async () => {
    const { isAlwaysGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("request_capability")).toBe(true);
  });

  it("does NOT classify prepare_* / send_transaction / preview_send as always-gated", async () => {
    const { isAlwaysGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("prepare_native_send")).toBe(false);
    expect(isAlwaysGatedTool("prepare_aave_supply")).toBe(false);
    expect(isAlwaysGatedTool("send_transaction")).toBe(false);
    expect(isAlwaysGatedTool("preview_send")).toBe(false);
    expect(isAlwaysGatedTool("preview_solana_send")).toBe(false);
    expect(isAlwaysGatedTool("verify_tx_decode")).toBe(false);
    expect(isAlwaysGatedTool("get_verification_artifact")).toBe(false);
  });

  it("does NOT classify read tools as always-gated", async () => {
    const { isAlwaysGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("get_token_balance")).toBe(false);
    expect(isAlwaysGatedTool("get_portfolio_summary")).toBe(false);
    expect(isAlwaysGatedTool("simulate_transaction")).toBe(false);
  });
});

describe("isConditionallyGatedTool — classifies the live-mode-aware set", () => {
  it("classifies prepare_* prefix as conditionally gated", async () => {
    const { isConditionallyGatedTool } = await import("../src/demo/index.js");
    expect(isConditionallyGatedTool("prepare_native_send")).toBe(true);
    expect(isConditionallyGatedTool("prepare_aave_supply")).toBe(true);
    expect(isConditionallyGatedTool("prepare_btc_send")).toBe(true);
    expect(isConditionallyGatedTool("prepare_solana_swap")).toBe(true);
  });

  it("classifies the explicit list (broadcast + preview + verify) as conditionally gated", async () => {
    const { isConditionallyGatedTool } = await import("../src/demo/index.js");
    expect(isConditionallyGatedTool("send_transaction")).toBe(true);
    expect(isConditionallyGatedTool("preview_send")).toBe(true);
    expect(isConditionallyGatedTool("preview_solana_send")).toBe(true);
    expect(isConditionallyGatedTool("verify_tx_decode")).toBe(true);
    expect(isConditionallyGatedTool("get_verification_artifact")).toBe(true);
  });

  it("does NOT classify read tools or always-gated tools", async () => {
    const { isConditionallyGatedTool } = await import("../src/demo/index.js");
    expect(isConditionallyGatedTool("get_token_balance")).toBe(false);
    expect(isConditionallyGatedTool("simulate_transaction")).toBe(false);
    expect(isConditionallyGatedTool("pair_ledger_live")).toBe(false);
    expect(isConditionallyGatedTool("sign_message_btc")).toBe(false);
    expect(isConditionallyGatedTool("request_capability")).toBe(false);
  });
});

describe("isBroadcastTool — exactly send_transaction", () => {
  it("only `send_transaction` returns true", async () => {
    const { isBroadcastTool } = await import("../src/demo/index.js");
    expect(isBroadcastTool("send_transaction")).toBe(true);
    expect(isBroadcastTool("preview_send")).toBe(false);
    expect(isBroadcastTool("prepare_native_send")).toBe(false);
    expect(isBroadcastTool("simulate_transaction")).toBe(false);
  });
});

describe("Refusal messages — stable prefix + actionable content", () => {
  it("alwaysGatedRefusalMessage starts with [VAULTPILOT_DEMO] and names the tool", async () => {
    const { alwaysGatedRefusalMessage } = await import("../src/demo/index.js");
    const msg = alwaysGatedRefusalMessage("pair_ledger_solana");
    expect(msg.startsWith("[VAULTPILOT_DEMO]")).toBe(true);
    expect(msg).toContain("'pair_ledger_solana'");
    expect(msg).toContain("regardless of live-wallet");
  });

  it("defaultModeRefusalMessage points the user at set_demo_wallet + lists personas", async () => {
    const { defaultModeRefusalMessage } = await import("../src/demo/index.js");
    const msg = defaultModeRefusalMessage("prepare_native_send");
    expect(msg.startsWith("[VAULTPILOT_DEMO]")).toBe(true);
    expect(msg).toContain("'prepare_native_send'");
    expect(msg).toContain("set_demo_wallet");
    // Lists the four personas by ID so the agent can offer them to the user
    // without an extra get_demo_wallet call.
    expect(msg).toContain("defi-power-user");
    expect(msg).toContain("stable-saver");
    expect(msg).toContain("staking-maxi");
    expect(msg).toContain("whale");
  });
});

describe("buildSimulationEnvelope — broadcast intercept shape", () => {
  it("returns demo:true + outcome:simulated + 0xdemo-prefixed hash", async () => {
    const { buildSimulationEnvelope } = await import("../src/demo/index.js");
    const env = buildSimulationEnvelope({
      toolName: "send_transaction",
      unsignedTxHandle: "h-abc-123",
      simulationResult: { ok: true },
      pinnedPreview: null,
    });
    expect(env.demo).toBe(true);
    expect(env.outcome).toBe("simulated");
    expect(env.simulatedTxHash.startsWith("0xdemo")).toBe(true);
    // Visually distinct from a real txHash: agents pattern-matching the
    // 0xdemo prefix can refuse to paste it into Etherscan.
    expect(env.simulatedTxHash).not.toMatch(/^0x[a-f0-9]{64}$/);
    expect(env.simulation).toEqual({ ok: true });
    // Verbatim-relayable nudge that the broadcast didn't actually happen.
    expect(env.message).toContain("NOT broadcast");
    expect(env.message).toContain("simulatedTxHash");
  });

  it("simulatedTxHash is deterministic for the same handle", async () => {
    const { buildSimulationEnvelope } = await import("../src/demo/index.js");
    const a = buildSimulationEnvelope({
      toolName: "send_transaction",
      unsignedTxHandle: "h-deadbeef",
      simulationResult: null,
    });
    const b = buildSimulationEnvelope({
      toolName: "send_transaction",
      unsignedTxHandle: "h-deadbeef",
      simulationResult: null,
    });
    expect(a.simulatedTxHash).toBe(b.simulatedTxHash);
  });

  it("simulatedTxHash differs across handles (so demo flows don't collide)", async () => {
    const { buildSimulationEnvelope } = await import("../src/demo/index.js");
    const a = buildSimulationEnvelope({
      toolName: "send_transaction",
      unsignedTxHandle: "h-aaa",
      simulationResult: null,
    });
    const b = buildSimulationEnvelope({
      toolName: "send_transaction",
      unsignedTxHandle: "h-bbb",
      simulationResult: null,
    });
    expect(a.simulatedTxHash).not.toBe(b.simulatedTxHash);
  });
});

describe("Live-mode state mgmt — persona / custom / clear", () => {
  beforeEach(async () => {
    const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
    _resetLiveWalletForTests();
  });
  afterEach(async () => {
    const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
    _resetLiveWalletForTests();
  });

  it("isLiveMode returns false by default; getLiveWallet returns null", async () => {
    const { isLiveMode, getLiveWallet } = await import("../src/demo/index.js");
    expect(isLiveMode()).toBe(false);
    expect(getLiveWallet()).toBeNull();
  });

  it("setLivePersona by ID populates addresses from PERSONAS", async () => {
    const { setLivePersona, getLiveWallet, isLiveMode } = await import(
      "../src/demo/index.js"
    );
    const persona = setLivePersona("defi-power-user");
    expect(persona.id).toBe("defi-power-user");
    expect(isLiveMode()).toBe(true);
    const w = getLiveWallet();
    expect(w?.personaId).toBe("defi-power-user");
    expect(w?.addresses.evm.length).toBeGreaterThan(0);
    expect(w?.addresses.solana.length).toBeGreaterThan(0);
    expect(w?.addresses.tron.length).toBeGreaterThan(0);
    // defi-power-user has BTC; stable-saver / staking-maxi do not.
    expect(w?.addresses.bitcoin).not.toBeNull();
  });

  it("setLivePersona throws on unknown persona ID", async () => {
    const { setLivePersona } = await import("../src/demo/index.js");
    expect(() => setLivePersona("unknown-persona")).toThrow(/Unknown persona/);
  });

  it("setLiveCustomAddresses requires at least one chain address", async () => {
    const { setLiveCustomAddresses } = await import("../src/demo/index.js");
    expect(() => setLiveCustomAddresses({})).toThrow(/at least one chain address/);
    expect(() =>
      setLiveCustomAddresses({ evm: [], solana: [], tron: [], bitcoin: [] }),
    ).toThrow(/at least one chain address/);
  });

  it("setLiveCustomAddresses with one chain populates the rest as empty / null bitcoin", async () => {
    const { setLiveCustomAddresses, getLiveWallet } = await import(
      "../src/demo/index.js"
    );
    setLiveCustomAddresses({ evm: ["0xabc"] });
    const w = getLiveWallet();
    expect(w?.personaId).toBeNull();
    expect(w?.addresses.evm).toEqual(["0xabc"]);
    expect(w?.addresses.solana).toEqual([]);
    expect(w?.addresses.tron).toEqual([]);
    expect(w?.addresses.bitcoin).toBeNull();
  });

  it("clearLiveWallet returns to default mode", async () => {
    const { setLivePersona, clearLiveWallet, isLiveMode, getLiveWallet } =
      await import("../src/demo/index.js");
    setLivePersona("whale");
    expect(isLiveMode()).toBe(true);
    clearLiveWallet();
    expect(isLiveMode()).toBe(false);
    expect(getLiveWallet()).toBeNull();
  });

  it("getLiveWallet returns a deep copy — mutations don't leak into state", async () => {
    const { setLivePersona, getLiveWallet } = await import("../src/demo/index.js");
    setLivePersona("defi-power-user");
    const w1 = getLiveWallet()!;
    w1.addresses.evm.push("0xMUTATION");
    const w2 = getLiveWallet()!;
    expect(w2.addresses.evm).not.toContain("0xMUTATION");
  });
});

describe("Personas — every persona has at least one EVM/Solana/TRON; BTC nullable", () => {
  it("each of the 4 personas has expected coverage", async () => {
    const { PERSONAS } = await import("../src/demo/personas.js");
    const ids = Object.keys(PERSONAS).sort();
    expect(ids).toEqual(
      ["defi-power-user", "stable-saver", "staking-maxi", "whale"].sort(),
    );
    for (const id of ids) {
      const p = PERSONAS[id as keyof typeof PERSONAS];
      expect(p.addresses.evm.length, `${id} missing EVM`).toBeGreaterThan(0);
      expect(p.addresses.solana.length, `${id} missing Solana`).toBeGreaterThan(0);
      expect(p.addresses.tron.length, `${id} missing TRON`).toBeGreaterThan(0);
      // BTC is nullable for stable-saver + staking-maxi (no native semantics).
      if (p.addresses.bitcoin !== null) {
        expect(p.addresses.bitcoin.length, `${id} BTC array empty`).toBeGreaterThan(0);
      }
    }
    // Locked: stable-saver and staking-maxi explicitly omit BTC.
    expect(PERSONAS["stable-saver"].addresses.bitcoin).toBeNull();
    expect(PERSONAS["staking-maxi"].addresses.bitcoin).toBeNull();
  });
});

describe("assertNotDemoForSetup — refuses to write real config in demo mode", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("throws when explicit demo is active (VAULTPILOT_DEMO=true)", async () => {
    const { assertNotDemoForSetup } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "true";
    expect(() => assertNotDemoForSetup()).toThrow(
      /Setup is disabled when VAULTPILOT_DEMO=true is explicitly set/,
    );
  });

  it("no-ops when demo is off", async () => {
    const { assertNotDemoForSetup } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    expect(() => assertNotDemoForSetup()).not.toThrow();
  });

  it("no-ops in auto-demo mode — running setup IS the way out, must not be blocked", async () => {
    const { assertNotDemoForSetup, _setAutoDemoLatchForTests } = await import(
      "../src/demo/index.js"
    );
    delete process.env[ENV_KEY];
    _setAutoDemoLatchForTests(true);
    try {
      expect(() => assertNotDemoForSetup()).not.toThrow();
    } finally {
      _setAutoDemoLatchForTests(null);
    }
  });
});

describe("issue #392 — getDemoModeEnvState distinguishes unset / invalid / enabled", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("returns 'unset' when the env var is absent", async () => {
    const { getDemoModeEnvState } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    expect(getDemoModeEnvState()).toBe("unset");
  });

  it("returns 'enabled' only on the exact literal 'true'", async () => {
    const { getDemoModeEnvState } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "true";
    expect(getDemoModeEnvState()).toBe("enabled");
  });

  it("returns 'invalid' for values that are neither 'true' nor 'false' (truthy mistakes etc.)", async () => {
    const { getDemoModeEnvState } = await import("../src/demo/index.js");
    for (const v of ["1", "yes", "on", "TRUE", "True", " true", "true "]) {
      process.env[ENV_KEY] = v;
      expect(getDemoModeEnvState(), `value ${JSON.stringify(v)}`).toBe("invalid");
    }
  });

  it("returns 'disabled' for the exact literal 'false' (auto-demo opt-out)", async () => {
    const { getDemoModeEnvState } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "false";
    expect(getDemoModeEnvState()).toBe("disabled");
  });

  it("returns 'invalid' for the empty string (set, but empty)", async () => {
    const { getDemoModeEnvState } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "";
    expect(getDemoModeEnvState()).toBe("invalid");
  });
});

describe("issue #392 — redactInvalidDemoEnvValue caps length and strips control chars", () => {
  it("passes short, printable values through unchanged", async () => {
    const { redactInvalidDemoEnvValue } = await import("../src/demo/index.js");
    expect(redactInvalidDemoEnvValue("1")).toBe("1");
    expect(redactInvalidDemoEnvValue("yes")).toBe("yes");
    expect(redactInvalidDemoEnvValue("TRUE")).toBe("TRUE");
  });

  it("truncates values longer than 32 chars with an ellipsis", async () => {
    const { redactInvalidDemoEnvValue } = await import("../src/demo/index.js");
    const long = "a".repeat(100);
    const out = redactInvalidDemoEnvValue(long);
    expect(out.length).toBe(32);
    expect(out.endsWith("...")).toBe(true);
  });

  it("replaces ASCII control characters with '?'", async () => {
    const { redactInvalidDemoEnvValue } = await import("../src/demo/index.js");
    expect(redactInvalidDemoEnvValue("a\x00b\x1fc\x7fd")).toBe("a?b?c?d");
    // Newline + tab also replaced (they would corrupt the JSON-string layout
    // when relayed to a chat renderer).
    expect(redactInvalidDemoEnvValue("a\nb\tc")).toBe("a?b?c");
  });
});

describe("issue #392 — buildGetDemoWalletResponse always lists personas", () => {
  let saved: string | undefined;
  beforeEach(async () => {
    saved = process.env[ENV_KEY];
    const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
    _resetLiveWalletForTests();
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
    const { _resetLiveWalletForTests } = await import("../src/demo/live-mode.js");
    _resetLiveWalletForTests();
  });

  it("returns the four personas regardless of env state (the core #392 fix)", async () => {
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    for (const v of [undefined, "1", "true", "yes"]) {
      if (v === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = v;
      const r = buildGetDemoWalletResponse();
      const ids = r.personas.map((p) => p.id).sort();
      expect(ids, `personas with VAULTPILOT_DEMO=${JSON.stringify(v)}`).toEqual(
        ["defi-power-user", "stable-saver", "staking-maxi", "whale"].sort(),
      );
    }
  });

  it("when env is unset: demoActive=false, envState='unset', message names the literal", async () => {
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(false);
    expect(r.envState).toBe("unset");
    expect(r.mode).toBeNull();
    if (!r.demoActive) {
      expect(r.message).toContain("VAULTPILOT_DEMO is unset");
      expect(r.message).toContain("VAULTPILOT_DEMO=true");
    }
  });

  it("when env is invalid: message echoes the (sanitized) value and explains the strict literal", async () => {
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "1";
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(false);
    expect(r.envState).toBe("invalid");
    if (!r.demoActive) {
      expect(r.message).toContain("set to '1'");
      expect(r.message).toContain("expects the exact literal 'true'");
      // The most common mistakes are called out so the user (and agent)
      // doesn't burn a debugging cycle on truthy-parse assumptions.
      expect(r.message).toMatch(/'1'.*'yes'.*'on'.*'TRUE'|'TRUE'.*'on'.*'yes'.*'1'/);
    }
  });

  it("redacts an attacker-shaped invalid value before echoing it back", async () => {
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "x".repeat(200) + "\n\x00";
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(false);
    if (!r.demoActive) {
      // No raw newline / NUL leaks into the response.
      expect(r.message).not.toMatch(/[\n\x00]/);
      // The displayed value is bounded.
      const m = r.message.match(/set to '([^']*)'/);
      expect(m).not.toBeNull();
      expect(m![1].length).toBeLessThanOrEqual(32);
    }
  });

  it("when env is enabled and no live wallet: demoActive=true, mode='default', active=null", async () => {
    const { buildGetDemoWalletResponse } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "true";
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(true);
    expect(r.envState).toBe("enabled");
    if (r.demoActive) {
      expect(r.mode).toBe("default");
      expect(r.active).toBeNull();
    }
  });

  it("when env is enabled and a persona is active: demoActive=true, mode='live', active populated", async () => {
    const { buildGetDemoWalletResponse, setLivePersona } = await import(
      "../src/demo/index.js"
    );
    process.env[ENV_KEY] = "true";
    setLivePersona("defi-power-user");
    const r = buildGetDemoWalletResponse();
    expect(r.demoActive).toBe(true);
    if (r.demoActive) {
      expect(r.mode).toBe("live");
      expect(r.active?.personaId).toBe("defi-power-user");
    }
  });
});
