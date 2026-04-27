/**
 * Regression test for the Aave V3 UiPoolDataProvider ABI drift (#308).
 *
 * Three on-chain ABI variants are live across the EVM chains we read:
 *
 *   - V3 (legacy)   — Polygon. 54-field reserve tuple including stable-
 *                     rate fields and in-tuple eMode trailers.
 *   - V3.2          — Ethereum, Arbitrum (and likely Base; not verified).
 *                     41-field reserve tuple, no stable-rate, no in-tuple
 *                     eMode. Adds `virtualAccActive` + `virtualUnderlyingBalance`.
 *   - V3.3          — Optimism. 40-field tuple — drops `unbacked` and
 *                     `virtualAccActive`, adds `deficit` at the end.
 *
 * Fixtures are real eth_call return data captured at PR time; if a future
 * chain upgrade rolls a 4th shape forward, the trial-decode loop will
 * fail this test against that chain's fixture rather than going silent in
 * production (the original bug).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  _resetAaveAbiCacheForTest,
  readAaveReservesData,
} from "../src/abis/aave-ui-pool-data-provider.js";

const FIXTURE_DIR = join(__dirname, "fixtures", "aave");

function loadFixture(chain: string): `0x${string}` {
  const hex = readFileSync(
    join(FIXTURE_DIR, `getReservesData-${chain}.hex`),
    "utf8",
  ).trim();
  if (!hex.startsWith("0x")) {
    throw new Error(`fixture ${chain} does not start with 0x`);
  }
  return hex as `0x${string}`;
}

interface Case {
  chain: string;
  uiProvider: `0x${string}`;
  poolAddressProvider: `0x${string}`;
}

const CASES: Case[] = [
  {
    chain: "ethereum",
    uiProvider: "0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC",
    poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  },
  {
    chain: "arbitrum",
    uiProvider: "0x5c5228aC8BC1528482514aF3e27E692495148717",
    poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  },
  {
    chain: "polygon",
    uiProvider: "0xC69728f11E9E6127733751c8410432913123acf1",
    poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  },
  {
    chain: "optimism",
    uiProvider: "0xa6741111f4CcB5162Ec6A825465354Ed8c6F7095",
    poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  },
];

function makeMockClient(returnData: `0x${string}`) {
  return {
    call: async () => ({ data: returnData }),
  } as unknown as Parameters<typeof readAaveReservesData>[0];
}

describe("Aave V3 UiPoolDataProvider ABI drift (#308)", () => {
  beforeEach(() => _resetAaveAbiCacheForTest());

  it.each(CASES)(
    "decodes live $chain fixture against the matching ABI variant",
    async ({ chain, uiProvider, poolAddressProvider }) => {
      const fixture = loadFixture(chain);
      const client = makeMockClient(fixture);
      const { reserves, baseCurrency } = await readAaveReservesData(
        client,
        uiProvider,
        poolAddressProvider,
      );

      // The chain has live USDC liquidity, so reserves[] is never empty
      // on any of the four chains we exercise. If a fixture refresh
      // produces an empty list, something else is wrong upstream.
      expect(reserves.length).toBeGreaterThan(0);

      // Spot-check the fields every consumer reads. If one of these is
      // missing the normalized projection is broken.
      const sample = reserves[0];
      expect(typeof sample.symbol).toBe("string");
      expect(typeof sample.decimals).toBe("bigint");
      expect(typeof sample.liquidityRate).toBe("bigint");
      expect(typeof sample.variableBorrowIndex).toBe("bigint");
      expect(typeof sample.availableLiquidity).toBe("bigint");
      expect(typeof sample.totalScaledVariableDebt).toBe("bigint");
      expect(typeof sample.priceInMarketReferenceCurrency).toBe("bigint");
      expect(typeof sample.isActive).toBe("boolean");
      expect(typeof sample.isPaused).toBe("boolean");
      expect(typeof sample.isFrozen).toBe("boolean");
      expect(sample.underlyingAsset).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // BaseCurrencyInfo is identical across all three variants — just
      // assert the canonical shape so a future drift here is also
      // caught by this test.
      expect(typeof baseCurrency.marketReferenceCurrencyUnit).toBe("bigint");
      expect(typeof baseCurrency.marketReferenceCurrencyPriceInUsd).toBe("bigint");
      expect(typeof baseCurrency.networkBaseTokenPriceDecimals).toBe("number");
    },
  );

  it("regression: ethereum fixture would have failed against V3-only ABI (the 2026-04-26 bug)", async () => {
    // Sanity: if we forced the LEGACY (V3) ABI as the only choice, the
    // ethereum fixture must NOT decode as a 54-field tuple. This locks
    // in the bug-shape so a future "simplification" that drops the
    // multi-variant logic doesn't silently regress.
    const { decodeFunctionResult } = await import("viem");
    const { aaveUiPoolDataProviderAbiV3 } = await import(
      "../src/abis/aave-ui-pool-data-provider.js"
    );
    const fixture = loadFixture("ethereum");
    expect(() =>
      decodeFunctionResult({
        abi: aaveUiPoolDataProviderAbiV3,
        functionName: "getReservesData",
        data: fixture,
      }),
    ).toThrow();
  });

  it("caches the matching variant per uiProvider after first decode", async () => {
    const fixture = loadFixture("ethereum");
    const ethereum = CASES[0];

    let calls = 0;
    const client = {
      call: async () => {
        calls += 1;
        return { data: fixture };
      },
    } as unknown as Parameters<typeof readAaveReservesData>[0];

    // First call: trial-decodes V3.2 (matches), caches.
    await readAaveReservesData(
      client,
      ethereum.uiProvider,
      ethereum.poolAddressProvider,
    );
    // Second call: cached variant tried first, decodes immediately.
    await readAaveReservesData(
      client,
      ethereum.uiProvider,
      ethereum.poolAddressProvider,
    );

    expect(calls).toBe(2); // one eth_call per request — caching is on the variant, not the result
  });
});
