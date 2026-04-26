/**
 * Tests for the UTXO-chain RPC config resolvers (BTC + LTC).
 * Issue #248. Locks the env-var precedence and the auth-mode pick.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuthFromEnv, resolveBitcoinRpcConfig } from "../src/config/btc.js";
import { resolveLitecoinRpcConfig } from "../src/config/litecoin.js";

const ENV_KEYS_BTC = [
  "BITCOIN_RPC_URL",
  "BITCOIN_RPC_COOKIE",
  "BITCOIN_RPC_USER",
  "BITCOIN_RPC_PASSWORD",
  "BITCOIN_RPC_AUTH_HEADER_NAME",
  "BITCOIN_RPC_AUTH_HEADER_VALUE",
];
const ENV_KEYS_LTC = ENV_KEYS_BTC.map((k) => k.replace("BITCOIN", "LITECOIN"));

beforeEach(() => {
  for (const k of [...ENV_KEYS_BTC, ...ENV_KEYS_LTC]) delete process.env[k];
});
afterEach(() => {
  for (const k of [...ENV_KEYS_BTC, ...ENV_KEYS_LTC]) delete process.env[k];
});

describe("resolveBitcoinRpcConfig", () => {
  it("returns null when BITCOIN_RPC_URL is unset (RPC tools must surface available:false)", () => {
    expect(resolveBitcoinRpcConfig()).toBeNull();
  });

  it("returns null when BITCOIN_RPC_URL is whitespace-only", () => {
    process.env.BITCOIN_RPC_URL = "   ";
    expect(resolveBitcoinRpcConfig()).toBeNull();
  });

  it("returns config with `none` auth when only URL is set", () => {
    process.env.BITCOIN_RPC_URL = "http://127.0.0.1:8332";
    const cfg = resolveBitcoinRpcConfig();
    expect(cfg).toEqual({
      url: "http://127.0.0.1:8332",
      auth: { kind: "none" },
    });
  });

  it("trims whitespace around the URL", () => {
    process.env.BITCOIN_RPC_URL = "  http://127.0.0.1:8332  ";
    expect(resolveBitcoinRpcConfig()?.url).toBe("http://127.0.0.1:8332");
  });
});

describe("resolveAuthFromEnv — auth-mode priority", () => {
  it("cookie takes precedence over basic + header", () => {
    process.env.BITCOIN_RPC_COOKIE = "/home/user/.bitcoin/.cookie";
    process.env.BITCOIN_RPC_USER = "alice";
    process.env.BITCOIN_RPC_PASSWORD = "bob";
    process.env.BITCOIN_RPC_AUTH_HEADER_NAME = "X-Token";
    process.env.BITCOIN_RPC_AUTH_HEADER_VALUE = "secret";
    const auth = resolveAuthFromEnv("BITCOIN");
    expect(auth).toEqual({
      kind: "cookie",
      cookiePath: "/home/user/.bitcoin/.cookie",
    });
  });

  it("basic auth takes precedence over header when no cookie", () => {
    process.env.BITCOIN_RPC_USER = "alice";
    process.env.BITCOIN_RPC_PASSWORD = "bob";
    process.env.BITCOIN_RPC_AUTH_HEADER_NAME = "X-Token";
    process.env.BITCOIN_RPC_AUTH_HEADER_VALUE = "secret";
    const auth = resolveAuthFromEnv("BITCOIN");
    expect(auth).toEqual({ kind: "basic", user: "alice", password: "bob" });
  });

  it("falls through to header when no cookie + no basic-auth pair", () => {
    process.env.BITCOIN_RPC_AUTH_HEADER_NAME = "X-Token";
    process.env.BITCOIN_RPC_AUTH_HEADER_VALUE = "secret123";
    const auth = resolveAuthFromEnv("BITCOIN");
    expect(auth).toEqual({
      kind: "header",
      headerName: "X-Token",
      headerValue: "secret123",
    });
  });

  it("requires BOTH user and password for basic auth (one alone falls through)", () => {
    process.env.BITCOIN_RPC_USER = "alice";
    // no password
    process.env.BITCOIN_RPC_AUTH_HEADER_NAME = "X-Token";
    process.env.BITCOIN_RPC_AUTH_HEADER_VALUE = "secret";
    const auth = resolveAuthFromEnv("BITCOIN");
    expect(auth.kind).toBe("header");
  });

  it("requires BOTH header name and value (one alone falls through)", () => {
    process.env.BITCOIN_RPC_AUTH_HEADER_NAME = "X-Token";
    // no value
    const auth = resolveAuthFromEnv("BITCOIN");
    expect(auth.kind).toBe("none");
  });

  it("uses the chain-specific prefix — LTC env vars are not consulted for BTC", () => {
    process.env.LITECOIN_RPC_USER = "ltc-user";
    process.env.LITECOIN_RPC_PASSWORD = "ltc-pw";
    expect(resolveAuthFromEnv("BITCOIN").kind).toBe("none");
  });
});

describe("resolveLitecoinRpcConfig", () => {
  it("mirrors BTC behavior with the LITECOIN_ prefix", () => {
    expect(resolveLitecoinRpcConfig()).toBeNull();
    process.env.LITECOIN_RPC_URL = "http://127.0.0.1:9332";
    process.env.LITECOIN_RPC_USER = "ltc";
    process.env.LITECOIN_RPC_PASSWORD = "p";
    expect(resolveLitecoinRpcConfig()).toEqual({
      url: "http://127.0.0.1:9332",
      auth: { kind: "basic", user: "ltc", password: "p" },
    });
  });
});
