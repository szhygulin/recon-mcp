/**
 * Aave V3 yields adapter — reads `getReservesData(provider)` from the
 * Aave UiPoolDataProvider directly. Doesn't need a wallet.
 *
 * `liquidityRate` from Aave is the supply APR in ray (1e27 == 100%).
 * Per the Aave docs and the existing wallet-aware reader at
 * `src/modules/positions/aave.ts`, we use the same UiPoolDataProvider
 * address from `CONTRACTS[chain].aave.uiPoolDataProvider`.
 */
import { getClient } from "../../../data/rpc.js";
import { readAaveReservesData } from "../../../abis/aave-ui-pool-data-provider.js";
import { CONTRACTS } from "../../../config/contracts.js";
import type { SupportedChain } from "../../../types/index.js";
import type { YieldRow, UnavailableProtocolEntry } from "../types.js";
import type { SupportedAsset } from "../asset-map.js";
import { resolveAsset } from "../asset-map.js";
import { aprToApy } from "../types.js";

/** Ray (1e27) → fractional. */
const RAY = 10n ** 27n;
function rayToFraction(ray: bigint): number {
  // Convert via Number with 18 decimals of precision retained as a
  // big-integer divide first, then float — keeps precision well above
  // what an APR display ever needs.
  const SCALED = 10n ** 9n;
  const scaled = (ray * SCALED) / RAY;
  return Number(scaled) / Number(SCALED);
}

/**
 * Read all reserves from the Aave V3 UiPoolDataProvider on `chain` and
 * filter to the row(s) matching the resolved asset address.
 */
export async function readAaveYields(
  asset: SupportedAsset,
  chains: ReadonlyArray<SupportedChain>,
): Promise<{ rows: YieldRow[]; unavailable: UnavailableProtocolEntry[] }> {
  const rows: YieldRow[] = [];
  const unavailable: UnavailableProtocolEntry[] = [];

  for (const chain of chains) {
    const cfg = CONTRACTS[chain].aave;
    if (!cfg) continue;
    const targetAsset = resolveAsset(asset, chain);
    if (!targetAsset?.address) continue;
    const targetAddrLc = targetAsset.address.toLowerCase();

    const client = getClient(chain);
    let reservesRaw: Awaited<ReturnType<typeof readAaveReservesData>>["reserves"] = [];
    try {
      const result = await readAaveReservesData(
        client,
        cfg.uiPoolDataProvider as `0x${string}`,
        cfg.poolAddressProvider as `0x${string}`,
      );
      reservesRaw = result.reserves;
    } catch (err) {
      unavailable.push({
        protocol: "aave-v3",
        chain,
        available: false,
        reason: `Aave V3 read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    for (const reserve of reservesRaw) {
      if (reserve.underlyingAsset.toLowerCase() !== targetAddrLc) continue;

      const apr = rayToFraction(reserve.liquidityRate);

      const notes: string[] = [];
      if (reserve.isPaused) notes.push("reserve is paused — supply/withdraw blocked");
      if (reserve.isFrozen) notes.push("reserve is frozen — no new supplies; existing positions can withdraw");
      if (reserve.isActive === false) notes.push("reserve inactive");

      // Aave's `getReservesData` doesn't expose USD TVL directly —
      // computing it would require multiplying availableLiquidity (in
      // token decimals) by `priceInMarketReferenceCurrency` and the
      // marketReferenceCurrencyPriceInUsd (which we'd have to grab from
      // the same call's BaseCurrencyInfo). Worth doing in v2; for v1
      // the row carries the rate and protocol risk score, and we leave
      // `tvl: null` honestly.
      rows.push({
        protocol: "aave-v3",
        chain,
        market: reserve.symbol,
        supplyApr: apr,
        supplyApy: aprToApy(apr),
        tvl: null,
        riskScore: null, // enriched by composer
        ...(notes.length > 0 ? { notes } : {}),
      });
    }
  }
  return { rows, unavailable };
}
