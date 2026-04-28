/**
 * Unit tests for `list_solana_validators` (issue #436).
 *
 * Stubs the stakewiz fetch with a controlled fixture so filter / sort /
 * limit / Inv-#14-notes behavior is asserted without a live HTTP call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

interface FixtureValidator {
  rank: number;
  identity: string;
  vote_identity: string;
  name?: string | null;
  ip_country?: string | null;
  version?: string | null;
  activated_stake: number;
  commission: number;
  delinquent: boolean;
  superminority_penalty: number;
  wiz_score: number;
  skip_rate: number;
  uptime: number;
  is_jito: boolean;
  jito_commission_bps: number;
  total_apy: number | null;
  staking_apy: number | null;
  jito_apy: number | null;
}

function makeValidator(
  i: number,
  overrides: Partial<FixtureValidator> = {},
): FixtureValidator {
  return {
    rank: i,
    identity: `id${i}`,
    vote_identity: `vote${i}`,
    name: `Validator ${i}`,
    ip_country: "Germany",
    version: "3.1.13",
    activated_stake: 1_000_000 - i * 1000,
    commission: 5,
    delinquent: false,
    superminority_penalty: 0,
    wiz_score: 99 - i * 0.5,
    skip_rate: 0,
    uptime: 100,
    is_jito: i % 2 === 0,
    jito_commission_bps: i % 2 === 0 ? 1000 : 0,
    total_apy: 6 + i * 0.01,
    staking_apy: 5.9,
    jito_apy: 0.1,
    ...overrides,
  };
}

function defaultFixture(): FixtureValidator[] {
  return [
    makeValidator(1, {
      wiz_score: 99,
      total_apy: 6.0,
      activated_stake: 145_000,
      commission: 0,
      is_jito: true,
    }),
    makeValidator(2, {
      wiz_score: 95,
      total_apy: 6.5,
      activated_stake: 80_000,
      commission: 5,
      is_jito: true,
    }),
    makeValidator(3, {
      wiz_score: 90,
      total_apy: 5.5,
      activated_stake: 200_000,
      commission: 10,
      is_jito: false,
    }),
    makeValidator(4, {
      wiz_score: 85,
      total_apy: null,
      activated_stake: 1_000,
      commission: 100,
      delinquent: true,
      is_jito: false,
    }),
    makeValidator(5, {
      wiz_score: 70,
      total_apy: 4.5,
      activated_stake: 500_000,
      commission: 8,
      superminority_penalty: 50,
      is_jito: true,
    }),
  ];
}

async function setup(opts: {
  fetchOk?: boolean;
  pool?: FixtureValidator[];
  fetchThrows?: boolean;
} = {}) {
  vi.resetModules();
  const fetchOk = opts.fetchOk ?? true;
  const pool = opts.pool ?? defaultFixture();
  vi.doMock("../src/data/http.js", () => ({
    fetchWithTimeout: vi.fn(async () => {
      if (opts.fetchThrows) throw new Error("network down");
      return {
        ok: fetchOk,
        json: async () => pool,
      };
    }),
  }));
  vi.doMock("../src/data/cache.js", () => ({
    cache: {
      remember: async (_k: string, _t: number, fn: () => Promise<unknown>) =>
        fn(),
      get: () => undefined,
      set: () => {},
    },
  }));
  return import("../src/modules/solana/validators.js");
}

describe("list_solana_validators", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns validators sorted by wiz_score descending by default", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({});
    // delinquent (rank 4) is excluded by default; remaining sorted by wiz_score desc.
    expect(out.validators.map((v) => v.rank)).toEqual([1, 2, 3, 5]);
  });

  it("excludes delinquent validators by default", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({});
    expect(out.validators.find((v) => v.delinquent)).toBeUndefined();
  });

  it("includes delinquent when excludeDelinquent=false", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { excludeDelinquent: false },
    });
    expect(out.validators.find((v) => v.delinquent)).toBeDefined();
  });

  it("excludes superminority when excludeSuperminority=true", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { excludeSuperminority: true },
    });
    expect(out.validators.find((v) => v.superminorityPenalty)).toBeUndefined();
  });

  it("filters by commissionMaxPct (inclusive)", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { commissionMaxPct: 5 },
    });
    expect(out.validators.every((v) => v.commissionPct <= 5)).toBe(true);
  });

  it("filters by minActivatedStakeSol", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { minActivatedStakeSol: 100_000 },
    });
    expect(
      out.validators.every((v) => v.activatedStakeSol >= 100_000),
    ).toBe(true);
  });

  it("filters by mevEnabled=true (Jito only)", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { mevEnabled: true },
    });
    expect(out.validators.every((v) => v.mevEnabled)).toBe(true);
  });

  it("filters by mevEnabled=false (non-Jito only)", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      filters: { mevEnabled: false, excludeDelinquent: false },
    });
    expect(out.validators.every((v) => !v.mevEnabled)).toBe(true);
  });

  it("sortBy=apy ranks by total APY descending; null APY sinks", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({
      sortBy: "apy",
      filters: { excludeDelinquent: false },
    });
    const apys = out.validators.map((v) => v.apyEstimate);
    // First non-null APY in result must be 6.5 (rank 2 in fixture).
    const firstNumeric = apys.find((a) => typeof a === "number");
    expect(firstNumeric).toBe(6.5);
    // Null-APY validator (rank 4) is at the bottom.
    expect(apys[apys.length - 1]).toBeNull();
  });

  it("sortBy=stake ranks by activated stake descending", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({ sortBy: "stake" });
    const stakes = out.validators.map((v) => v.activatedStakeSol);
    const sortedDesc = [...stakes].sort((a, b) => b - a);
    expect(stakes).toEqual(sortedDesc);
  });

  it("sortBy=commission ranks by commission ascending; ties broken by wiz_score", async () => {
    const pool = [
      makeValidator(1, { commission: 5, wiz_score: 80 }),
      makeValidator(2, { commission: 5, wiz_score: 95 }),
      makeValidator(3, { commission: 0, wiz_score: 70 }),
    ];
    const { listSolanaValidators } = await setup({ pool });
    const out = await listSolanaValidators({ sortBy: "commission" });
    // 0% commission first; then both 5% — wiz_score=95 before wiz_score=80.
    expect(out.validators.map((v) => v.rank)).toEqual([3, 2, 1]);
  });

  it("respects the limit parameter", async () => {
    const pool = Array.from({ length: 50 }, (_, i) => makeValidator(i + 1));
    const { listSolanaValidators } = await setup({ pool });
    const out = await listSolanaValidators({ limit: 10 });
    expect(out.validators).toHaveLength(10);
    expect(out.totalSourceCount).toBe(50);
  });

  it("attaches Inv #14 notes to every successful response", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({});
    expect(out.notes.length).toBeGreaterThanOrEqual(2);
    expect(out.notes.some((n) => /Invariant #14/i.test(n))).toBe(true);
    expect(out.notes.some((n) => /byte-equality-check/i.test(n))).toBe(true);
  });

  it("attaches a stakewizUrl per validator for browser-side verification", async () => {
    const { listSolanaValidators } = await setup();
    const out = await listSolanaValidators({});
    for (const v of out.validators) {
      expect(v.stakewizUrl).toMatch(
        /^https:\/\/stakewiz\.com\/validator\/[A-Za-z0-9]+$/,
      );
      expect(v.stakewizUrl).toContain(v.votePubkey);
    }
  });

  it("returns empty validators[] + an unreachable-feed note when fetch fails", async () => {
    const { listSolanaValidators } = await setup({ fetchOk: false });
    const out = await listSolanaValidators({});
    expect(out.validators).toHaveLength(0);
    expect(out.notes.some((n) => /unreachable/i.test(n))).toBe(true);
  });

  it("returns empty validators[] when fetch throws (network error)", async () => {
    const { listSolanaValidators } = await setup({ fetchThrows: true });
    const out = await listSolanaValidators({});
    expect(out.validators).toHaveLength(0);
    expect(out.notes.some((n) => /unreachable/i.test(n))).toBe(true);
  });

  it("populates filteredCount and totalSourceCount honestly", async () => {
    const pool = [
      makeValidator(1, { delinquent: true }),
      makeValidator(2),
      makeValidator(3, { commission: 100 }),
    ];
    const { listSolanaValidators } = await setup({ pool });
    const out = await listSolanaValidators({
      filters: { commissionMaxPct: 10 },
    });
    expect(out.totalSourceCount).toBe(3);
    expect(out.filteredCount).toBe(1); // 1 delinquent excluded, 1 commission=100 excluded
  });
});
