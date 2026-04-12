import { formatUnits, parseUnits, maxUint256 } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { aavePoolAbi, aavePoolAddressProviderAbi } from "../../abis/aave-pool.js";
import { aaveUiPoolDataProviderAbi } from "../../abis/aave-ui-pool-data-provider.js";
import { round } from "../../data/format.js";
import type { LendingPosition, SupportedChain, TokenAmount } from "../../types/index.js";

const BASE_DECIMALS = 8; // Aave V3 market reference currency (USD) uses 8 decimals.

interface AggregateData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  healthFactor: bigint;
}

interface UserReserve {
  underlyingAsset: `0x${string}`;
  scaledATokenBalance: bigint;
  usageAsCollateralEnabledOnUser: boolean;
  scaledVariableDebt: bigint;
  principalStableDebt: bigint;
  stableBorrowRate: bigint;
  stableBorrowLastUpdateTimestamp: number;
}

interface ReserveData {
  underlyingAsset: `0x${string}`;
  symbol: string;
  decimals: bigint;
  reserveLiquidationThreshold: bigint;
  priceInMarketReferenceCurrency: bigint;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
}

interface BaseCurrencyInfo {
  marketReferenceCurrencyUnit: bigint;
  marketReferenceCurrencyPriceInUsd: bigint;
  networkBaseTokenPriceInUsd: bigint;
  networkBaseTokenPriceDecimals: number;
}

const RAY = 10n ** 27n;

function rayMul(a: bigint, b: bigint): bigint {
  return (a * b + RAY / 2n) / RAY;
}

/** Fetch the fully-resolved Aave V3 lending position on a single chain. Returns null if the user has no Aave activity. */
export async function getAaveLendingPosition(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<LendingPosition | null> {
  const client = getClient(chain);
  const provider = CONTRACTS[chain].aave.poolAddressProvider as `0x${string}`;
  const uiProvider = CONTRACTS[chain].aave.uiPoolDataProvider as `0x${string}`;

  // Resolve the current Pool address dynamically.
  const poolAddr = (await client.readContract({
    address: provider,
    abi: aavePoolAddressProviderAbi,
    functionName: "getPool",
  })) as `0x${string}`;

  // Fetch aggregate + reserves + per-user data in parallel.
  const [account, userReservesResult, reservesResult] = await Promise.all([
    client.readContract({ address: poolAddr, abi: aavePoolAbi, functionName: "getUserAccountData", args: [wallet] }),
    client.readContract({
      address: uiProvider,
      abi: aaveUiPoolDataProviderAbi,
      functionName: "getUserReservesData",
      args: [provider, wallet],
    }),
    client.readContract({ address: uiProvider, abi: aaveUiPoolDataProviderAbi, functionName: "getReservesData", args: [provider] }),
  ]);

  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] =
    account as unknown as [bigint, bigint, bigint, bigint, bigint, bigint];

  // Early exit if the wallet has no Aave activity.
  if (totalCollateralBase === 0n && totalDebtBase === 0n) return null;

  const agg: AggregateData = {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  };

  const [userReservesRaw] = userReservesResult as unknown as [UserReserve[], number];
  const [reservesRaw, baseCurrencyRaw] = reservesResult as unknown as [ReserveData[], BaseCurrencyInfo];
  const reservesBySymbol = new Map<string, ReserveData>(
    reservesRaw.map((r) => [r.underlyingAsset.toLowerCase(), r])
  );

  // Unit-of-account price = USD price with `networkBaseTokenPriceDecimals` decimals
  const usdUnit = 10 ** baseCurrencyRaw.networkBaseTokenPriceDecimals;
  const marketBase = Number(baseCurrencyRaw.marketReferenceCurrencyUnit);

  const collateral: TokenAmount[] = [];
  const debt: TokenAmount[] = [];

  for (const ur of userReservesRaw) {
    const reserve = reservesBySymbol.get(ur.underlyingAsset.toLowerCase());
    if (!reserve) continue;

    const decimals = Number(reserve.decimals);
    const priceBase = Number(reserve.priceInMarketReferenceCurrency);
    const tokenPriceUsd =
      (priceBase / marketBase) * (Number(baseCurrencyRaw.marketReferenceCurrencyPriceInUsd) / usdUnit);

    // aToken balance (actual) = scaled × liquidityIndex / RAY
    const aTokenBalance = rayMul(ur.scaledATokenBalance, reserve.liquidityIndex);
    const variableDebt = rayMul(ur.scaledVariableDebt, reserve.variableBorrowIndex);
    const stableDebt = ur.principalStableDebt; // approximation; stable is near-zero in practice
    const totalDebt = variableDebt + stableDebt;

    if (aTokenBalance > 0n) {
      const amount = Number(formatUnits(aTokenBalance, decimals));
      collateral.push({
        token: ur.underlyingAsset,
        symbol: reserve.symbol,
        decimals,
        amount: aTokenBalance.toString(),
        formatted: amount.toString(),
        priceUsd: round(tokenPriceUsd, 6),
        valueUsd: round(amount * tokenPriceUsd, 2),
      });
    }
    if (totalDebt > 0n) {
      const amount = Number(formatUnits(totalDebt, decimals));
      debt.push({
        token: ur.underlyingAsset,
        symbol: reserve.symbol,
        decimals,
        amount: totalDebt.toString(),
        formatted: amount.toString(),
        priceUsd: round(tokenPriceUsd, 6),
        valueUsd: round(amount * tokenPriceUsd, 2),
      });
    }
  }

  const totalCollateralUsd = Number(formatUnits(agg.totalCollateralBase, BASE_DECIMALS));
  const totalDebtUsd = Number(formatUnits(agg.totalDebtBase, BASE_DECIMALS));
  // healthFactor returned by Aave is scaled 1e18; cap at a big number if no debt.
  const hf =
    agg.totalDebtBase === 0n
      ? Number.POSITIVE_INFINITY
      : Number(formatUnits(agg.healthFactor, 18));

  return {
    protocol: "aave-v3",
    chain,
    collateral,
    debt,
    totalCollateralUsd: round(totalCollateralUsd, 2),
    totalDebtUsd: round(totalDebtUsd, 2),
    netValueUsd: round(totalCollateralUsd - totalDebtUsd, 2),
    healthFactor: hf === Number.POSITIVE_INFINITY ? 1e18 : round(hf, 4),
    liquidationThreshold: Number(agg.currentLiquidationThreshold),
    ltv: Number(agg.ltv),
  };
}

/**
 * Simulate a delta to the lending position and return the projected health factor.
 * We work in USD space: newHF = (newCollateral × liqThreshold) / newDebt.
 */
export function simulateHealthFactorChange(
  base: LendingPosition,
  action: "add_collateral" | "remove_collateral" | "borrow" | "repay",
  deltaUsd: number
): { newHealthFactor: number; newCollateralUsd: number; newDebtUsd: number; safe: boolean } {
  let collateral = base.totalCollateralUsd;
  let debtUsd = base.totalDebtUsd;

  switch (action) {
    case "add_collateral":
      collateral += deltaUsd;
      break;
    case "remove_collateral":
      collateral = Math.max(0, collateral - deltaUsd);
      break;
    case "borrow":
      debtUsd += deltaUsd;
      break;
    case "repay":
      debtUsd = Math.max(0, debtUsd - deltaUsd);
      break;
  }

  const liqThresh = base.liquidationThreshold / 10_000; // bps → fraction
  const hf =
    debtUsd === 0
      ? Number.POSITIVE_INFINITY
      : (collateral * liqThresh) / debtUsd;

  return {
    newHealthFactor: hf === Number.POSITIVE_INFINITY ? 1e18 : round(hf, 4),
    newCollateralUsd: round(collateral, 2),
    newDebtUsd: round(debtUsd, 2),
    safe: hf > 1.0,
  };
}

/** Export a tiny helper for action builders. */
export async function getAavePoolAddress(chain: SupportedChain): Promise<`0x${string}`> {
  const client = getClient(chain);
  const provider = CONTRACTS[chain].aave.poolAddressProvider as `0x${string}`;
  return (await client.readContract({
    address: provider,
    abi: aavePoolAddressProviderAbi,
    functionName: "getPool",
  })) as `0x${string}`;
}

export { maxUint256, parseUnits };
