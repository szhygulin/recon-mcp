/**
 * Issue #250 — TRON network resource exhaustion baseline. Tests the
 * percentile math, the persisted ring-buffer atomic-write pattern, and
 * the lazy-sample anomaly detection. Mocks `fetchWithTimeout` so the
 * tests never touch live TronGrid.
 *
 * Empirical verification that `/wallet/getaccountresource` returns the
 * four chain-wide totals was done at code-time against the live
 * endpoint — see PR description's R&D section.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fetchMock = vi.fn();
vi.mock("../src/data/http.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("../src/config/user-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
    "../src/config/user-config.js",
  );
  return {
    ...actual,
    resolveTronApiKey: () => undefined,
    readUserConfig: () => ({}),
  };
});

import {
  evaluateResourceExhaustion,
  fetchResourceSnapshot,
  appendSample,
  energyPriceRatio,
  bandwidthPriceRatio,
  percentile,
  _resetResourceBaselineForTests,
  _seedResourceBaselineForTests,
  _peekResourceBaselineForTests,
  type ResourceSample,
} from "../src/modules/tron/resource-baseline.js";
import { setConfigDirForTesting } from "../src/config/user-config.js";

function mockSnapshot(values: {
  energyLimit?: number;
  energyWeight?: number;
  netLimit?: number;
  netWeight?: number;
}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      TotalEnergyLimit: values.energyLimit ?? 180_000_000_000,
      TotalEnergyWeight: values.energyWeight ?? 19_000_000_000,
      TotalNetLimit: values.netLimit ?? 43_200_000_000,
      TotalNetWeight: values.netWeight ?? 26_000_000_000,
    }),
  });
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-tron-baseline-"));
  setConfigDirForTesting(join(tmpHome, ".vaultpilot-mcp"));
  fetchMock.mockReset();
  _resetResourceBaselineForTests();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("percentile", () => {
  it("matches linear-interpolation for the standard test fixture", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 5);
  });

  it("returns NaN on empty input rather than throwing", () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it("handles single-sample input cleanly", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
  });
});

describe("energyPriceRatio / bandwidthPriceRatio", () => {
  it("returns weight/limit ratios for valid samples", () => {
    const sample: ResourceSample = {
      ts: 0,
      totalEnergyLimit: 100,
      totalEnergyWeight: 50,
      totalNetLimit: 200,
      totalNetWeight: 80,
    };
    expect(energyPriceRatio(sample)).toBe(0.5);
    expect(bandwidthPriceRatio(sample)).toBe(0.4);
  });

  it("returns 0 (not Infinity / NaN) when limit is zero", () => {
    const degenerate: ResourceSample = {
      ts: 0,
      totalEnergyLimit: 0,
      totalEnergyWeight: 50,
      totalNetLimit: 0,
      totalNetWeight: 80,
    };
    expect(energyPriceRatio(degenerate)).toBe(0);
    expect(bandwidthPriceRatio(degenerate)).toBe(0);
  });
});

describe("fetchResourceSnapshot", () => {
  it("parses all four chain-wide totals from the TronGrid response", async () => {
    fetchMock.mockReturnValueOnce(
      mockSnapshot({
        energyLimit: 180_000_000_000,
        energyWeight: 19_592_399_053,
        netLimit: 43_200_000_000,
        netWeight: 26_832_640_867,
      }),
    );
    const snap = await fetchResourceSnapshot();
    expect(snap.totalEnergyLimit).toBe(180_000_000_000);
    expect(snap.totalEnergyWeight).toBe(19_592_399_053);
    expect(snap.totalNetLimit).toBe(43_200_000_000);
    expect(snap.totalNetWeight).toBe(26_832_640_867);
  });

  it("throws when one of the four totals is missing (defends against shape drift)", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        json: async () => ({
          TotalEnergyLimit: 1,
          TotalEnergyWeight: 2,
          // TotalNetLimit missing
          TotalNetWeight: 4,
        }),
      }),
    );
    await expect(fetchResourceSnapshot()).rejects.toThrow(/missing.*chain-wide/);
  });

  it("throws on HTTP failure", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 503, statusText: "down" }),
    );
    await expect(fetchResourceSnapshot()).rejects.toThrow(/503/);
  });
});

describe("appendSample (persistence)", () => {
  it("writes the buffer atomically to the config dir", () => {
    const sample: ResourceSample = {
      ts: 1_700_000_000_000,
      totalEnergyLimit: 100,
      totalEnergyWeight: 50,
      totalNetLimit: 200,
      totalNetWeight: 80,
    };
    appendSample(sample);
    const path = join(tmpHome, ".vaultpilot-mcp", "tron-resource-baseline.json");
    expect(existsSync(path)).toBe(true);
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body.version).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0]).toEqual(sample);
  });

  it("caps the ring at 144 samples (drops oldest)", () => {
    for (let i = 0; i < 200; i++) {
      appendSample({
        ts: 1_700_000_000_000 + i,
        totalEnergyLimit: 100,
        totalEnergyWeight: 50 + i,
        totalNetLimit: 200,
        totalNetWeight: 80,
      });
    }
    const samples = _peekResourceBaselineForTests();
    expect(samples).toHaveLength(144);
    // Newest preserved (highest weight); oldest dropped.
    expect(samples[143].totalEnergyWeight).toBe(50 + 199);
    expect(samples[0].totalEnergyWeight).toBe(50 + 200 - 144);
  });
});

describe("evaluateResourceExhaustion", () => {
  function flatSeed(count: number, energyWeight = 19_000_000_000): ResourceSample[] {
    const samples: ResourceSample[] = [];
    for (let i = 0; i < count; i++) {
      samples.push({
        ts: 1_700_000_000_000 + i * 600_000,
        totalEnergyLimit: 180_000_000_000,
        totalEnergyWeight: energyWeight,
        totalNetLimit: 43_200_000_000,
        totalNetWeight: 26_000_000_000,
      });
    }
    return samples;
  }

  it("returns available:false when fewer than MIN_SAMPLES are persisted", async () => {
    fetchMock.mockReturnValueOnce(mockSnapshot({}));
    const result = await evaluateResourceExhaustion();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/insufficient baseline data/);
    }
  });

  it("flags when current energy ratio is > 2× the rolling P90", async () => {
    // Seed 8 samples at a flat low ratio, then return a snapshot
    // showing the ratio jumping ~10× P90. Note that `appendSample`
    // adds the new spike to the buffer BEFORE the percentile is
    // computed, so even if 10% of samples are at the spike value,
    // P90's interpolation between the cluster of low ratios and the
    // spike is well below the spike — making `current/p90` >> 2.
    _seedResourceBaselineForTests(flatSeed(8, 1_000_000_000));
    fetchMock.mockReturnValueOnce(
      mockSnapshot({
        energyLimit: 180_000_000_000,
        energyWeight: 100_000_000_000, // 100× the seeded weight
      }),
    );
    const result = await evaluateResourceExhaustion();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.flagged).toBe(true);
      expect(result.detail.energy.ratioVsP90).toBeGreaterThan(2);
    }
  });

  it("does NOT flag when current is within the threshold", async () => {
    _seedResourceBaselineForTests(flatSeed(8, 10_000_000_000));
    fetchMock.mockReturnValueOnce(
      mockSnapshot({
        energyLimit: 180_000_000_000,
        energyWeight: 12_000_000_000, // 1.2× seeded
      }),
    );
    const result = await evaluateResourceExhaustion();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.flagged).toBe(false);
    }
  });

  it("returns available:false when the snapshot fetch fails", async () => {
    _seedResourceBaselineForTests(flatSeed(8));
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 500, statusText: "boom" }),
    );
    const result = await evaluateResourceExhaustion();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/failed to sample.*500/);
    }
  });

  it("persists the new sample even when emission can't flag (so the next call may)", async () => {
    fetchMock.mockReturnValueOnce(mockSnapshot({}));
    await evaluateResourceExhaustion();
    const samples = _peekResourceBaselineForTests();
    expect(samples).toHaveLength(1);
  });
});
