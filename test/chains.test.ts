import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveRpcUrl, RpcConfigError } from "../src/config/chains.js";
import type { UserConfig } from "../src/types/index.js";

const RPC_ENV_KEYS = [
  "ETHEREUM_RPC_URL",
  "ARBITRUM_RPC_URL",
  "POLYGON_RPC_URL",
  "BASE_RPC_URL",
  "OPTIMISM_RPC_URL",
  "RPC_PROVIDER",
  "RPC_API_KEY",
];

describe("resolveRpcUrl", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of RPC_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of RPC_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("env per-chain URL wins over everything else", () => {
    process.env.ETHEREUM_RPC_URL = "https://env-eth.example/";
    process.env.RPC_PROVIDER = "infura";
    process.env.RPC_API_KEY = "envkey";
    const cfg: UserConfig = { rpc: { provider: "alchemy", apiKey: "cfgkey" } };
    expect(resolveRpcUrl("ethereum", cfg)).toBe("https://env-eth.example/");
  });

  it("env RPC_PROVIDER + RPC_API_KEY builds Infura URL", () => {
    process.env.RPC_PROVIDER = "infura";
    process.env.RPC_API_KEY = "abc123";
    expect(resolveRpcUrl("ethereum", null)).toBe("https://mainnet.infura.io/v3/abc123");
    expect(resolveRpcUrl("arbitrum", null)).toBe(
      "https://arbitrum-mainnet.infura.io/v3/abc123"
    );
    expect(resolveRpcUrl("base", null)).toBe("https://base-mainnet.infura.io/v3/abc123");
  });

  it("user config Alchemy produces provider URL", () => {
    const cfg: UserConfig = { rpc: { provider: "alchemy", apiKey: "k" } };
    expect(resolveRpcUrl("ethereum", cfg)).toBe("https://eth-mainnet.g.alchemy.com/v2/k");
    expect(resolveRpcUrl("arbitrum", cfg)).toBe("https://arb-mainnet.g.alchemy.com/v2/k");
    expect(resolveRpcUrl("base", cfg)).toBe("https://base-mainnet.g.alchemy.com/v2/k");
  });

  it("BASE_RPC_URL env var wins over everything else", () => {
    process.env.BASE_RPC_URL = "https://env-base.example/";
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "envkey";
    const cfg: UserConfig = { rpc: { provider: "infura", apiKey: "cfgkey" } };
    expect(resolveRpcUrl("base", cfg)).toBe("https://env-base.example/");
  });

  it("OPTIMISM_RPC_URL env var wins over everything else", () => {
    process.env.OPTIMISM_RPC_URL = "https://env-optimism.example/";
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "envkey";
    const cfg: UserConfig = { rpc: { provider: "infura", apiKey: "cfgkey" } };
    expect(resolveRpcUrl("optimism", cfg)).toBe("https://env-optimism.example/");
  });

  it("Infura and Alchemy build the right Optimism URL", () => {
    process.env.RPC_PROVIDER = "infura";
    process.env.RPC_API_KEY = "abc123";
    expect(resolveRpcUrl("optimism", null)).toBe(
      "https://optimism-mainnet.infura.io/v3/abc123"
    );

    delete process.env.RPC_PROVIDER;
    delete process.env.RPC_API_KEY;
    const cfg: UserConfig = { rpc: { provider: "alchemy", apiKey: "k" } };
    expect(resolveRpcUrl("optimism", cfg)).toBe("https://opt-mainnet.g.alchemy.com/v2/k");
  });

  it("custom provider uses per-chain URL from config", () => {
    const cfg: UserConfig = {
      rpc: {
        provider: "custom",
        customUrls: { ethereum: "https://my-node/eth", arbitrum: "https://my-node/arb" },
      },
    };
    expect(resolveRpcUrl("ethereum", cfg)).toBe("https://my-node/eth");
    expect(resolveRpcUrl("arbitrum", cfg)).toBe("https://my-node/arb");
  });

  it("missing API key for Infura throws", () => {
    const cfg: UserConfig = { rpc: { provider: "infura" } };
    expect(() => resolveRpcUrl("ethereum", cfg)).toThrow(RpcConfigError);
  });

  it("custom provider without URL for a chain throws", () => {
    const cfg: UserConfig = {
      rpc: { provider: "custom", customUrls: { ethereum: "https://x" } },
    };
    expect(() => resolveRpcUrl("arbitrum", cfg)).toThrow(RpcConfigError);
  });

  it("no configuration at all throws", () => {
    expect(() => resolveRpcUrl("ethereum", null)).toThrow(RpcConfigError);
  });
});
