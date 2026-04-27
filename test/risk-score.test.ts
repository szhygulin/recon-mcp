/**
 * Regression tests for #309 — get_protocol_risk_score returns score:null
 * for major protocols.
 *
 * Two underlying bugs covered:
 *   - Bug 1: DefiLlama's `/protocol/<slug>` endpoint returns `tvl` as a
 *     time-series array of `{ date, totalLiquidityUSD }` snapshots, not a
 *     scalar. The old extractor read `data.tvl` as a number, computed
 *     `array / 1e6`, got NaN, and propagated null through the score.
 *   - Bug 2: `IMMUNEFI_BOUNTIES` keys are program-level (`aave`,
 *     `compound`) but DefiLlama slugs are versioned (`aave-v3`,
 *     `compound-v3`), so the bounty lookup missed.
 *
 * Both bugs make the headline `score` field of the tool's output null for
 * the two largest non-Maker EVM lending protocols. These tests pin the
 * fixed behavior so a future refactor that re-introduces either bug fails
 * loud.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/http.js", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
}));

// Disable cache so fixture changes between tests aren't masked.
vi.mock("../src/data/cache.js", () => ({
  cache: {
    remember: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
  },
}));

import { getProtocolRiskScore } from "../src/modules/security/risk-score.js";

function fakeOk(body: unknown) {
  return { ok: true, json: async () => body };
}

function tvlSeries(latest: number, length: number, days30Ago: number) {
  // Build a series whose tail looks like
  //   ... [length-31] = days30Ago   ...  [length-1] = latest
  const out: Array<{ date: number; totalLiquidityUSD: number }> = [];
  for (let i = 0; i < length; i++) {
    let v: number;
    if (i === length - 1) v = latest;
    else if (i === length - 31) v = days30Ago;
    else v = Math.round((latest + days30Ago) / 2);
    out.push({ date: 1_700_000_000 + i * 86400, totalLiquidityUSD: v });
  }
  return out;
}

beforeEach(() => {
  fetchWithTimeoutMock.mockReset();
});

describe("getProtocolRiskScore — #309 regressions", () => {
  it("Bug 1: extracts current TVL from the time-series array shape (latest snapshot)", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Compound V3",
        // Current API shape: array of { date, totalLiquidityUSD }
        tvl: tvlSeries(1_350_000_000, 60, 1_300_000_000),
        listedAt: 1_640_000_000,
        audit_links: ["https://x.com/audit1", "https://x.com/audit2"],
      }),
    );

    const result = await getProtocolRiskScore("compound-v3");

    // Headline: score must be a real number, not null.
    expect(result.score).toBeDefined();
    expect(Number.isFinite(result.score)).toBe(true);

    // raw.tvlUsd resolves to the latest snapshot's totalLiquidityUSD.
    expect(result.raw.tvlUsd).toBe(1_350_000_000);

    // No more "TVL $NaNM" — the note string must contain a real number.
    expect(result.breakdown.tvl.note).toMatch(/TVL \$[\d.]+M/);
    expect(result.breakdown.tvl.note).not.toMatch(/NaN/);

    // Trend computed from the same series (latest vs 30 days ago).
    expect(result.raw.tvlTrend30d).toBeDefined();
  });

  it("Bug 1: still works when tvl is the legacy scalar shape", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Some Old Protocol",
        tvl: 12_500_000, // legacy scalar form
        listedAt: 1_640_000_000,
        audit_links: ["https://x.com/audit1"],
      }),
    );
    const result = await getProtocolRiskScore("some-old-protocol");
    expect(result.score).toBeDefined();
    expect(result.raw.tvlUsd).toBe(12_500_000);
  });

  it("Bug 1: missing tvl field doesn't crash; surfaces as 'no TVL data'", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Something",
        listedAt: 1_640_000_000,
      }),
    );
    const result = await getProtocolRiskScore("something");
    expect(result.raw.tvlUsd).toBeUndefined();
    expect(result.breakdown.tvl.note).toBe("no TVL data");
    // Score still computed — TVL just contributes 0.
    expect(result.score).toBeDefined();
  });

  it("Bug 2: aave-v3 resolves to the Aave Immunefi bounty via alias map", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Aave V3",
        tvl: tvlSeries(8_000_000_000, 60, 7_500_000_000),
        listedAt: 1_600_000_000,
        audit_links: Array.from({ length: 8 }, (_, i) => `https://x.com/audit${i}`),
      }),
    );

    const result = await getProtocolRiskScore("aave-v3");

    expect(result.raw.hasBugBounty).toBe(true);
    expect(result.raw.bountyMaxUsd).toBe(1_000_000); // matches IMMUNEFI_BOUNTIES.aave
    expect(result.breakdown.bounty.value).toBe(20);
    expect(result.breakdown.bounty.note).toMatch(/Immunefi bounty up to \$1,000,000/);
  });

  it("Bug 2: compound-v3 resolves to the Compound Immunefi bounty via alias map", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Compound V3",
        tvl: tvlSeries(1_350_000_000, 60, 1_300_000_000),
        listedAt: 1_640_000_000,
        audit_links: ["https://x.com/audit1", "https://x.com/audit2"],
      }),
    );

    const result = await getProtocolRiskScore("compound-v3");

    expect(result.raw.hasBugBounty).toBe(true);
    expect(result.raw.bountyMaxUsd).toBe(500_000);
    expect(result.breakdown.bounty.value).toBe(20);
  });

  it("Bug 2: unaliased + unbounty-listed slug correctly reports no bounty", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({ name: "Random Protocol", tvl: 100_000_000 }),
    );
    const result = await getProtocolRiskScore("random-rugpull");
    expect(result.raw.hasBugBounty).toBe(false);
    expect(result.breakdown.bounty.value).toBe(0);
    expect(result.breakdown.bounty.note).toBe("no Immunefi bounty registered");
  });

  it("End-to-end: compound-v3 with the realistic API shape produces a meaningful score (the issue repro)", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      fakeOk({
        name: "Compound V3",
        tvl: tvlSeries(1_350_000_000, 100, 1_200_000_000),
        listedAt: Math.floor(Date.now() / 1000) - 1320 * 86400, // ~1320 days
        audit_links: ["https://x.com/audit1"],
      }),
    );

    const result = await getProtocolRiskScore("compound-v3");

    // Pre-fix behavior: score === undefined (rendered as null).
    // Post-fix: should be a meaningful positive number — TVL + age + bounty + audits all contribute.
    expect(result.score).toBeDefined();
    expect(result.score!).toBeGreaterThan(50);
    expect(result.raw.hasBugBounty).toBe(true);
    expect(result.raw.tvlUsd).toBe(1_350_000_000);
  });
});
