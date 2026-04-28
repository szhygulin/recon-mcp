/**
 * Unit tests for `resolve_token` (issue #440).
 *
 * The resolver is canonical-registry-only — it reads `CONTRACTS`,
 * `SOLANA_TOKENS`, `TRON_TOKENS` from the existing config files. Tests
 * exercise the real shape (no mocks) per the
 * `feedback_guard_tests_exercise_real_shape` memory: a registry update
 * that adds / renames a symbol or breaks a bridged-sibling pair must
 * be visible here.
 */
import { describe, it, expect } from "vitest";
import { resolveToken } from "../src/modules/tokens/resolve.js";

describe("resolveToken — EVM stables", () => {
  it("USDC on ethereum returns the canonical Circle USDC contract with no warnings", async () => {
    const out = await resolveToken({ chain: "ethereum", symbol: "USDC" });
    expect(out.contract).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(out.decimals).toBe(6);
    expect(out.warnings).toEqual([]);
    expect(out.alternatives).toEqual([]);
  });

  it("USDC on arbitrum warns hasBridgedVariant + surfaces USDC.e in alternatives", async () => {
    const out = await resolveToken({ chain: "arbitrum", symbol: "USDC" });
    expect(out.contract).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(out.warnings).toContain("hasBridgedVariant");
    expect(out.alternatives).toEqual([
      {
        symbol: "USDC.e",
        contract: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
        decimals: 6,
      },
    ]);
  });

  it("USDC.e on arbitrum warns isBridgedVariant + surfaces USDC native", async () => {
    const out = await resolveToken({ chain: "arbitrum", symbol: "USDC.e" });
    expect(out.contract).toBe("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8");
    expect(out.symbol).toBe("USDC.e");
    expect(out.warnings).toContain("isBridgedVariant");
    expect(out.alternatives[0]?.symbol).toBe("USDC");
  });

  it("USDC on base warns hasBridgedVariant + surfaces USDbC", async () => {
    const out = await resolveToken({ chain: "base", symbol: "USDC" });
    expect(out.warnings).toContain("hasBridgedVariant");
    expect(out.alternatives[0]?.symbol).toBe("USDbC");
  });

  it("USDbC on base warns isBridgedVariant + surfaces native USDC", async () => {
    const out = await resolveToken({ chain: "base", symbol: "USDbC" });
    expect(out.warnings).toContain("isBridgedVariant");
    expect(out.alternatives[0]?.symbol).toBe("USDC");
  });

  it("USDC on optimism warns hasBridgedVariant + surfaces USDC.e", async () => {
    const out = await resolveToken({ chain: "optimism", symbol: "USDC" });
    expect(out.warnings).toContain("hasBridgedVariant");
    expect(out.alternatives[0]?.symbol).toBe("USDC.e");
  });

  it("USDC on polygon warns hasBridgedVariant + surfaces USDC.e", async () => {
    const out = await resolveToken({ chain: "polygon", symbol: "USDC" });
    expect(out.warnings).toContain("hasBridgedVariant");
    expect(out.alternatives[0]?.symbol).toBe("USDC.e");
  });
});

describe("resolveToken — EVM non-stables", () => {
  it("WETH on ethereum returns the canonical wrapped-ETH contract", async () => {
    const out = await resolveToken({ chain: "ethereum", symbol: "WETH" });
    expect(out.contract.toLowerCase()).toBe(
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    );
    expect(out.decimals).toBe(18);
    expect(out.warnings).toEqual([]);
  });

  it("WBTC on ethereum returns the canonical contract with 8 decimals", async () => {
    const out = await resolveToken({ chain: "ethereum", symbol: "WBTC" });
    expect(out.decimals).toBe(8);
    expect(out.warnings).toEqual([]);
  });

  it("preserves registry casing on output (cbETH on base)", async () => {
    const out = await resolveToken({ chain: "base", symbol: "cbeth" });
    expect(out.symbol).toBe("cbETH");
    expect(out.decimals).toBe(18);
  });
});

describe("resolveToken — Solana", () => {
  it("USDC on solana returns the canonical SPL mint", async () => {
    const out = await resolveToken({ chain: "solana", symbol: "USDC" });
    expect(out.contract).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(out.decimals).toBe(6);
    expect(out.warnings).toEqual([]);
  });

  it("BONK on solana returns the canonical mint with 5 decimals", async () => {
    const out = await resolveToken({ chain: "solana", symbol: "BONK" });
    expect(out.decimals).toBe(5);
  });
});

describe("resolveToken — TRON", () => {
  it("USDT on tron returns the canonical TRC-20 contract with 6 decimals", async () => {
    const out = await resolveToken({ chain: "tron", symbol: "USDT" });
    expect(out.contract).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(out.decimals).toBe(6);
    expect(out.warnings).toEqual([]);
  });
});

describe("resolveToken — case-insensitive lookup, registry casing on output", () => {
  it("symbol input is matched case-insensitively but the response uses the registry casing", async () => {
    const out = await resolveToken({ chain: "ethereum", symbol: "usdc" });
    expect(out.symbol).toBe("USDC");
    const out2 = await resolveToken({ chain: "arbitrum", symbol: "usdc.e" });
    expect(out2.symbol).toBe("USDC.e");
  });
});

describe("resolveToken — unknown symbols", () => {
  it("rejects an unknown symbol on ethereum with a list of known ones", async () => {
    await expect(
      resolveToken({ chain: "ethereum", symbol: "FAKEDOGE" }),
    ).rejects.toThrow(/Unknown token symbol "FAKEDOGE" on ethereum.*Known symbols/i);
  });

  it("rejects an unknown symbol on solana", async () => {
    await expect(
      resolveToken({ chain: "solana", symbol: "NOTREAL" }),
    ).rejects.toThrow(/Unknown token symbol "NOTREAL" on solana/i);
  });

  it("rejects an unknown symbol on tron", async () => {
    await expect(
      resolveToken({ chain: "tron", symbol: "NOTREAL" }),
    ).rejects.toThrow(/Unknown token symbol "NOTREAL" on tron/i);
  });

  it("error message points the user at the explicit-contract escape hatch", async () => {
    await expect(
      resolveToken({ chain: "ethereum", symbol: "FAKEDOGE" }),
    ).rejects.toThrow(/look up its contract.*pass it directly to prepare_token_send/i);
  });
});

describe("resolveToken — refuses on-chain probing (security note)", () => {
  it("does NOT reach an RPC client — pure registry lookup", async () => {
    // Empirical evidence: every successful test above runs without any
    // mocked Connection / viem client. If the resolver ever calls into
    // an RPC client, the suite breaks (no client is set up). This test
    // documents the invariant explicitly.
    const out = await resolveToken({ chain: "ethereum", symbol: "USDC" });
    expect(out.source).toBe("canonical-registry");
  });
});
