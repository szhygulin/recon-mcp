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
    expect(() => setHeliusApiKey("not-a-uuid")).toThrow(/Helius UUID format/);
    expect(() => setHeliusApiKey("12345678-1234-1234-1234-12345678")).toThrow(
      /Helius UUID format/,
    );
    expect(() =>
      // wrong segment lengths
      setHeliusApiKey("12345678-1234-1234-1234-1234567890ab-extra"),
    ).toThrow(/Helius UUID format/);
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

describe("Helius nudge — fires every 10th public error, clears on consume", () => {
  it("does NOT fire on counts 1-9", () => {
    for (let i = 0; i < 9; i++) recordSolanaPublicError();
    expect(consumePendingHeliusNudge()).toBeNull();
  });

  it("fires on count 10", () => {
    for (let i = 0; i < 10; i++) recordSolanaPublicError();
    const nudge = consumePendingHeliusNudge();
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("VAULTPILOT_DEMO");
    expect(nudge!).toContain("Helius");
    expect(nudge!).toContain("set_helius_api_key");
    expect(nudge!).toContain("dashboard.helius.dev");
    // Mentions the count so the user sees how often they've been throttled.
    expect(nudge!).toContain("10");
  });

  it("consume is pop-style — clears the flag after returning the text", () => {
    for (let i = 0; i < 10; i++) recordSolanaPublicError();
    expect(consumePendingHeliusNudge()).not.toBeNull();
    // Second consume returns null — only one response per threshold crossing.
    expect(consumePendingHeliusNudge()).toBeNull();
  });

  it("re-fires on the next threshold (count 20)", () => {
    for (let i = 0; i < 10; i++) recordSolanaPublicError();
    consumePendingHeliusNudge(); // pop the first one
    for (let i = 0; i < 9; i++) recordSolanaPublicError();
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
