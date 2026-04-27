/**
 * Tests for the runtime Solana RPC override + Helius nudge mechanism
 * (issue #371 follow-up — add demo-mode UX for fixing public-Solana
 * rate-limits without restarting the MCP server).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  setHeliusApiKey,
  getRuntimeSolanaRpc,
  getRuntimeSolanaRpcStatus,
  clearRuntimeSolanaRpc,
  recordSolanaPublicError,
  getSolanaPublicErrorCount,
  consumePendingHeliusNudge,
  _resetRuntimeRpcOverridesForTests,
} from "../src/data/runtime-rpc-overrides.js";

const VALID_KEY = "b7d6f3a1-1234-5678-9abc-def012345678";

beforeEach(() => {
  _resetRuntimeRpcOverridesForTests();
});

describe("setHeliusApiKey — input validation", () => {
  it("accepts a UUID-format API key and stores the canonical Helius URL", () => {
    const { url } = setHeliusApiKey(VALID_KEY);
    expect(url).toBe(`https://mainnet.helius-rpc.com/?api-key=${VALID_KEY}`);
    expect(getRuntimeSolanaRpc()).toBe(url);
  });

  it("rejects empty / non-string input", () => {
    expect(() => setHeliusApiKey("")).toThrow(/must be a non-empty string/);
    // @ts-expect-error — testing runtime validation
    expect(() => setHeliusApiKey(undefined)).toThrow(/must be a non-empty string/);
    // @ts-expect-error — testing runtime validation
    expect(() => setHeliusApiKey(null)).toThrow(/must be a non-empty string/);
  });

  it("rejects URLs (so prompt injection can't redirect to a malicious endpoint)", () => {
    expect(() =>
      setHeliusApiKey("https://attacker.example.com/?api-key=stealth"),
    ).toThrow(/pass the bare API key, not a URL/);
    expect(() =>
      setHeliusApiKey("http://malicious.example.com/"),
    ).toThrow(/pass the bare API key, not a URL/);
    expect(() =>
      setHeliusApiKey("data://something/?api-key=foo"),
    ).toThrow(/pass the bare API key, not a URL/);
  });

  it("rejects malformed UUIDs", () => {
    expect(() => setHeliusApiKey("not-a-uuid")).toThrow(/UUID format/);
    expect(() => setHeliusApiKey("12345678-1234-1234-1234-12345678")).toThrow(
      /UUID format/,
    );
    expect(() =>
      // wrong segment lengths
      setHeliusApiKey("12345678-1234-1234-1234-1234567890ab-extra"),
    ).toThrow(/UUID format/);
  });
});

describe("Runtime override precedence + status surface", () => {
  it("getRuntimeSolanaRpc returns null when no override is set", () => {
    expect(getRuntimeSolanaRpc()).toBeNull();
    expect(getRuntimeSolanaRpcStatus().active).toBe(false);
  });

  it("status surface reports last-4 of API key only — never the full value", () => {
    setHeliusApiKey(VALID_KEY);
    const status = getRuntimeSolanaRpcStatus();
    expect(status.active).toBe(true);
    expect(status.apiKeySuffix).toBe(VALID_KEY.slice(-4));
    expect(typeof status.setAt).toBe("number");
    // Sweep: nothing in the status surface should contain the full key.
    expect(JSON.stringify(status)).not.toContain(VALID_KEY);
  });

  it("clearRuntimeSolanaRpc returns to null state", () => {
    setHeliusApiKey(VALID_KEY);
    expect(getRuntimeSolanaRpc()).not.toBeNull();
    clearRuntimeSolanaRpc();
    expect(getRuntimeSolanaRpc()).toBeNull();
    expect(getRuntimeSolanaRpcStatus().active).toBe(false);
  });
});

describe("Solana public-error counter — tracks exactly when no override is set", () => {
  it("counter increments on each call when no override is set", () => {
    expect(getSolanaPublicErrorCount()).toBe(0);
    recordSolanaPublicError();
    recordSolanaPublicError();
    recordSolanaPublicError();
    expect(getSolanaPublicErrorCount()).toBe(3);
  });

  it("counter does NOT increment once an override is set (keyed traffic doesn't count)", () => {
    setHeliusApiKey(VALID_KEY);
    recordSolanaPublicError();
    recordSolanaPublicError();
    expect(getSolanaPublicErrorCount()).toBe(0);
  });

  it("counter resets to 0 when setHeliusApiKey is called", () => {
    recordSolanaPublicError();
    recordSolanaPublicError();
    expect(getSolanaPublicErrorCount()).toBe(2);
    setHeliusApiKey(VALID_KEY);
    expect(getSolanaPublicErrorCount()).toBe(0);
  });
});

describe("Helius nudge — fires on first error + every 10th thereafter", () => {
  it("fires on count 1 (first error of the session)", () => {
    recordSolanaPublicError();
    const nudge = consumePendingHeliusNudge();
    expect(nudge).not.toBeNull();
    // Mentions the count so the user sees how often they've been throttled.
    // Singular form on count 1 (no trailing 's').
    expect(nudge!).toContain("hit 1 rate-limit error");
  });

  it("does NOT re-fire on counts 2-9 after the first nudge has been consumed", () => {
    recordSolanaPublicError();
    consumePendingHeliusNudge(); // pop the count=1 nudge
    for (let i = 0; i < 8; i++) recordSolanaPublicError(); // counts 2..9
    expect(consumePendingHeliusNudge()).toBeNull();
  });

  it("re-fires on count 10 after the count=1 nudge was consumed", () => {
    recordSolanaPublicError();
    consumePendingHeliusNudge();
    for (let i = 0; i < 9; i++) recordSolanaPublicError(); // brings to 10
    const nudge = consumePendingHeliusNudge();
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("VAULTPILOT_DEMO");
    expect(nudge!).toContain("Helius");
    expect(nudge!).toContain("set_helius_api_key");
    expect(nudge!).toContain("dashboard.helius.dev");
    expect(nudge!).toContain("hit 10 rate-limit errors");
  });

  it("consume is pop-style — clears the flag after returning the text", () => {
    recordSolanaPublicError();
    expect(consumePendingHeliusNudge()).not.toBeNull();
    // Second consume returns null — only one response per threshold crossing.
    expect(consumePendingHeliusNudge()).toBeNull();
  });

  it("re-fires on the next threshold (count 20) after pop at 10", () => {
    for (let i = 0; i < 10; i++) recordSolanaPublicError();
    consumePendingHeliusNudge(); // pop the count=10 (count=1 already consumed implicitly via the same flag)
    for (let i = 0; i < 9; i++) recordSolanaPublicError(); // 11..19
    expect(consumePendingHeliusNudge()).toBeNull();
    recordSolanaPublicError(); // 20th
    const nudge = consumePendingHeliusNudge();
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("20");
  });

  it("does NOT fire after a successful set_helius_api_key (counter zeroed)", () => {
    for (let i = 0; i < 9; i++) recordSolanaPublicError();
    setHeliusApiKey(VALID_KEY);
    // Even if more public errors come in (which shouldn't, since override
    // is active — but guard anyway), they don't count.
    recordSolanaPublicError();
    expect(consumePendingHeliusNudge()).toBeNull();
  });
});

describe("Etherscan override (issue #371 PR generalization)", () => {
  const VALID_ETHERSCAN_KEY = "ZQTKPM98R5N4YT8GMTBI3XR2P4HFZNTAYG"; // 34 chars

  it("setRuntimeOverride('etherscan', key) stores the bare key (no URL wrapping)", async () => {
    const { setRuntimeOverride, getRuntimeOverride } = await import(
      "../src/data/runtime-rpc-overrides.js"
    );
    setRuntimeOverride("etherscan", VALID_ETHERSCAN_KEY);
    // Etherscan resolves to the bare key (used as-is in query params),
    // unlike Helius which wraps in a URL.
    expect(getRuntimeOverride("etherscan")).toBe(VALID_ETHERSCAN_KEY);
  });

  it("rejects URL-shaped input (security: no prompt-injection redirects)", async () => {
    const { setRuntimeOverride } = await import(
      "../src/data/runtime-rpc-overrides.js"
    );
    expect(() =>
      setRuntimeOverride("etherscan", "https://malicious.example.com/?api=stealth"),
    ).toThrow(/pass the bare API key, not a URL/);
  });

  it("rejects malformed keys (wrong length / dashes / etc.)", async () => {
    const { setRuntimeOverride } = await import(
      "../src/data/runtime-rpc-overrides.js"
    );
    expect(() => setRuntimeOverride("etherscan", "too-short")).toThrow(
      /Etherscan V2/,
    );
    // UUID-shaped (Helius's format) is wrong for Etherscan — too-many dashes.
    expect(() =>
      setRuntimeOverride("etherscan", "b7d6f3a1-1234-5678-9abc-def012345678"),
    ).toThrow(/Etherscan V2/);
    // 33 chars (off by one) — must be exactly 34.
    expect(() =>
      setRuntimeOverride("etherscan", "ZQTKPM98R5N4YT8GMTBI3XR2P4HFZNTAY"),
    ).toThrow(/Etherscan V2/);
  });

  it("Etherscan + Helius counters are independent (per-service state)", async () => {
    const {
      recordPublicError,
      getPublicErrorCount,
    } = await import("../src/data/runtime-rpc-overrides.js");
    recordPublicError("helius");
    recordPublicError("helius");
    recordPublicError("etherscan");
    expect(getPublicErrorCount("helius")).toBe(2);
    expect(getPublicErrorCount("etherscan")).toBe(1);
  });

  it("nudge fires on first Etherscan error + every 10th thereafter", async () => {
    const {
      recordPublicError,
      consumePendingNudge,
    } = await import("../src/data/runtime-rpc-overrides.js");
    // Count 1 → fires.
    recordPublicError("etherscan");
    const first = consumePendingNudge("etherscan");
    expect(first).not.toBeNull();
    expect(first!).toContain("Etherscan");
    expect(first!).toContain("set_etherscan_api_key");
    expect(first!).toContain("etherscan.io/myapikey");
    expect(first!).toContain("rejected 1 call");
    // Counts 2-9 → no fire.
    for (let i = 0; i < 8; i++) recordPublicError("etherscan");
    expect(consumePendingNudge("etherscan")).toBeNull();
    // Count 10 → fires.
    recordPublicError("etherscan");
    const tenth = consumePendingNudge("etherscan");
    expect(tenth).not.toBeNull();
    expect(tenth!).toContain("rejected 10 calls");
  });

  it("setting an Etherscan key zeroes the counter + clears pending nudge", async () => {
    const {
      recordPublicError,
      setRuntimeOverride,
      getPublicErrorCount,
      consumePendingNudge,
    } = await import("../src/data/runtime-rpc-overrides.js");
    recordPublicError("etherscan");
    expect(getPublicErrorCount("etherscan")).toBe(1);
    setRuntimeOverride("etherscan", VALID_ETHERSCAN_KEY);
    expect(getPublicErrorCount("etherscan")).toBe(0);
    expect(consumePendingNudge("etherscan")).toBeNull();
  });

  it("consumeAllPendingNudges returns both Helius + Etherscan when both pending", async () => {
    const {
      recordPublicError,
      consumeAllPendingNudges,
    } = await import("../src/data/runtime-rpc-overrides.js");
    recordPublicError("helius");
    recordPublicError("etherscan");
    const all = consumeAllPendingNudges();
    expect(all.length).toBe(2);
    const services = all.map((x) => x.service).sort();
    expect(services).toEqual(["etherscan", "helius"]);
    // Subsequent call: both consumed, returns empty.
    expect(consumeAllPendingNudges()).toEqual([]);
  });

  it("Etherscan status surface redacts to last-4 chars", async () => {
    const {
      setRuntimeOverride,
      getRuntimeOverrideStatus,
    } = await import("../src/data/runtime-rpc-overrides.js");
    setRuntimeOverride("etherscan", VALID_ETHERSCAN_KEY);
    const status = getRuntimeOverrideStatus("etherscan");
    expect(status.active).toBe(true);
    expect(status.apiKeySuffix).toBe(VALID_ETHERSCAN_KEY.slice(-4));
    expect(JSON.stringify(status)).not.toContain(VALID_ETHERSCAN_KEY);
  });

  it("resolveEtherscanApiKey integration — runtime-override wins over env + config", async () => {
    delete process.env.ETHERSCAN_API_KEY;
    const { setRuntimeOverride } = await import(
      "../src/data/runtime-rpc-overrides.js"
    );
    setRuntimeOverride("etherscan", VALID_ETHERSCAN_KEY);
    const { resolveEtherscanApiKey } = await import("../src/config/user-config.js");
    expect(resolveEtherscanApiKey(null)).toBe(VALID_ETHERSCAN_KEY);
    // Env var doesn't override the runtime setting.
    process.env.ETHERSCAN_API_KEY = "DIFFERENT_KEY_VIA_ENV_VAR_THAT_LOSES_MMM";
    expect(resolveEtherscanApiKey(null)).toBe(VALID_ETHERSCAN_KEY);
    delete process.env.ETHERSCAN_API_KEY;
  });
});

describe("classifySolanaRpcSource integration — runtime-override wins", () => {
  it("runtime-override takes precedence over env / config / public-fallback", async () => {
    // Reset everything that could leak from another test.
    delete process.env.SOLANA_RPC_URL;
    setHeliusApiKey(VALID_KEY);
    // classifySolanaRpcSource is internal to diagnostics, but the
    // public surface is `get_vaultpilot_config_status`. Spinning up the
    // full diagnostic is heavy — the contract here is that
    // resolveSolanaRpcUrl returns the override. That's the load-bearing
    // claim agents and tests rely on.
    const { resolveSolanaRpcUrl } = await import("../src/config/chains.js");
    const resolved = resolveSolanaRpcUrl(null);
    expect(resolved).toBe(`https://mainnet.helius-rpc.com/?api-key=${VALID_KEY}`);
  });

  it("falls through to env when no runtime override is set", async () => {
    process.env.SOLANA_RPC_URL = "https://my-helius.example.com/?api-key=ENV";
    const { resolveSolanaRpcUrl } = await import("../src/config/chains.js");
    expect(resolveSolanaRpcUrl(null)).toBe(
      "https://my-helius.example.com/?api-key=ENV",
    );
    delete process.env.SOLANA_RPC_URL;
  });
});
