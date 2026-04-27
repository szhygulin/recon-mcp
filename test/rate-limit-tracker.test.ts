import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordRateLimit,
  getActiveHints,
  resetRateLimitTracker,
  _trackerState,
} from "../src/data/rate-limit-tracker.js";

/**
 * Pure unit tests for the rate-limit tracker. No I/O, no module
 * mocking — the tracker is a leaf module.
 *
 * Conventions used here mirror the production wiring:
 *   - threshold: 3 hits in a 5-min rolling window
 *   - hints stay sticky once tripped, until config change clears the
 *     tracker (resetRateLimitTracker)
 *   - hints only surface for sources currently using a no-key default
 *     (the caller passes the `usingDefault` map per source)
 */

const ALL_DEFAULT = {
  evmUsingDefault: {
    ethereum: true,
    arbitrum: true,
    polygon: true,
    base: true,
    optimism: true,
  } as const,
  solanaUsingDefault: true,
  tronUsingDefault: true,
};

const NONE_DEFAULT = {
  evmUsingDefault: {
    ethereum: false,
    arbitrum: false,
    polygon: false,
    base: false,
    optimism: false,
  } as const,
  solanaUsingDefault: false,
  tronUsingDefault: false,
};

beforeEach(() => {
  resetRateLimitTracker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rate-limit tracker — threshold + window", () => {
  it("does not surface a hint below threshold (2 hits)", () => {
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    expect(getActiveHints(ALL_DEFAULT)).toEqual([]);
  });

  it("surfaces a hint at exactly threshold (3 hits)", () => {
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    const hints = getActiveHints(ALL_DEFAULT);
    expect(hints.length).toBe(1);
    expect(hints[0].source).toBe("evm:ethereum");
    // Rate-limit hints carry the `kind: "rate-limit"` discriminator
    // so callers can distinguish them from `demo-mode` hints (issue #371).
    expect(hints[0].kind).toBe("rate-limit");
    expect(hints[0].providers!.length).toBeGreaterThan(0);
    // Sanity: providers point at real signup dashboards.
    expect(hints[0].providers!.some((p) => p.dashboardUrl.startsWith("https://"))).toBe(true);
  });

  it("trims hits outside the rolling window (5 min)", () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    // Two hits at t=0
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    // Advance 6 min — those two are now outside the window.
    vi.setSystemTime(1_000_000_000_000 + 6 * 60_000);
    // Two more hits — only these are in-window.
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    // The two old hits don't count toward the threshold; should NOT
    // surface a hint yet (only 2 hits in current window).
    // BUT: once tripped, the source stays in `tripped`. To validate
    // the window-trim logic in isolation, we look at internal state.
    const state = _trackerState();
    expect(state.hits["evm:ethereum"]?.length).toBe(2);
    // Add one more hit to reach 3 in-window — should trip.
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    expect(getActiveHints(ALL_DEFAULT).length).toBe(1);
  });
});

describe("rate-limit tracker — sticky tripped state", () => {
  it("once tripped, the hint stays even after no further hits", () => {
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    expect(getActiveHints(ALL_DEFAULT).length).toBe(1);
    // Even after the window scrolls past, the source remains tripped
    // (intentional — the user shouldn't get nudged once and then
    // silently un-nudged before they actually act on it).
    vi.useFakeTimers({ now: Date.now() + 60 * 60_000 }); // +1 hr
    expect(getActiveHints(ALL_DEFAULT).length).toBe(1);
  });

  it("resetRateLimitTracker clears tripped state and hits", () => {
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    expect(getActiveHints(ALL_DEFAULT).length).toBe(1);
    resetRateLimitTracker();
    expect(getActiveHints(ALL_DEFAULT)).toEqual([]);
    expect(_trackerState().tripped).toEqual([]);
  });
});

describe("rate-limit tracker — usingDefault gating", () => {
  it("does NOT surface a hint when the user is already on a paid key for that source", () => {
    // Trip ethereum tracker.
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    // But tell the diagnostics layer the user is NOT using defaults
    // anywhere (i.e. they have an Infura key configured). The hint
    // is suppressed even though the tracker says ethereum is tripped
    // — there's nothing actionable to suggest.
    expect(getActiveHints(NONE_DEFAULT)).toEqual([]);
  });

  it("surfaces hints only for tripped + still-on-default sources (mixed case)", () => {
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "solana" });
    recordRateLimit({ kind: "solana" });
    recordRateLimit({ kind: "solana" });
    // User has an Infura key (so EVM defaults are off) but no Helius
    // key. Only the solana hint should surface.
    const hints = getActiveHints({
      evmUsingDefault: {
        ethereum: false,
        arbitrum: false,
        polygon: false,
        base: false,
        optimism: false,
      },
      solanaUsingDefault: true,
      tronUsingDefault: false,
    });
    expect(hints.length).toBe(1);
    expect(hints[0].source).toBe("solana");
  });
});

describe("rate-limit tracker — independent per-source counters", () => {
  it("solana and tron tracked independently from EVM", () => {
    recordRateLimit({ kind: "solana" });
    recordRateLimit({ kind: "solana" });
    recordRateLimit({ kind: "solana" });
    recordRateLimit({ kind: "tron" });
    recordRateLimit({ kind: "tron" });
    recordRateLimit({ kind: "tron" });
    const hints = getActiveHints(ALL_DEFAULT);
    expect(hints.map((h) => h.source).sort()).toEqual(["solana", "tron"]);
    // Solana hint points at Helius.
    const solana = hints.find((h) => h.source === "solana")!;
    expect(solana.providers![0].name).toBe("Helius");
    // TRON hint points at TronGrid.
    const tron = hints.find((h) => h.source === "tron")!;
    expect(tron.providers![0].name).toBe("TronGrid");
  });

  it("each EVM chain tracked independently", () => {
    // 3 hits on ethereum trips it. 2 hits on arbitrum doesn't.
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "ethereum" });
    recordRateLimit({ kind: "evm", chain: "arbitrum" });
    recordRateLimit({ kind: "evm", chain: "arbitrum" });
    const hints = getActiveHints(ALL_DEFAULT);
    expect(hints.length).toBe(1);
    expect(hints[0].source).toBe("evm:ethereum");
  });
});

describe("rate-limit tracker — hint shape sanity", () => {
  it("EVM hint suggests both Infura and Alchemy with valid dashboard URLs", () => {
    recordRateLimit({ kind: "evm", chain: "polygon" });
    recordRateLimit({ kind: "evm", chain: "polygon" });
    recordRateLimit({ kind: "evm", chain: "polygon" });
    const hint = getActiveHints(ALL_DEFAULT)[0];
    expect(hint.providers!.map((p) => p.name).sort()).toEqual(["Alchemy", "Infura"]);
    for (const p of hint.providers!) {
      expect(() => new URL(p.dashboardUrl)).not.toThrow();
      expect(p.dashboardUrl.startsWith("https://")).toBe(true);
    }
    // Recommendation mentions the wizard.
    expect(hint.recommendation).toContain("vaultpilot-mcp-setup");
    expect(hint.setupCommand).toBe("vaultpilot-mcp-setup");
  });
});
