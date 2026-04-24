import { formatUnits, parseUnits, maxUint256 } from "viem";
import { getClient } from "../../data/rpc.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
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
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
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

/**
 * Fetch the fully-resolved Aave V3 lending position on a single chain.
 * Returns null if the user has no Aave activity OR the RPC returned empty data for any of
 * the required reads (batching mis-handling, rate-limit, transient). The caller treats a
 * null result as "no position on this chain" — safer than exploding the whole portfolio.
 */
export async function getAaveLendingPosition(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<LendingPosition | null> {
  try {
    return await readAaveLendingPosition(wallet, chain);
  } catch {
    return null;
  }
}

/**
 * Cached per-chain Pool address. `PoolAddressesProvider.getPool()` is
 * effectively static (changes only on Aave upgrades), so a 1-hour cache
 * is safe and cuts one RPC per wallet-chain read.
 */
async function resolveAavePoolAddress(chain: SupportedChain): Promise<`0x${string}`> {
  const cacheKey = `aave-pool-addr:${chain}`;
  return cache.remember(cacheKey, CACHE_TTL.SECURITY_PERMISSIONS, async () => {
    const client = getClient(chain);
    const provider = CONTRACTS[chain].aave.poolAddressProvider as `0x${string}`;
    return (await client.readContract({
      address: provider,
      abi: aavePoolAddressProviderAbi,
      functionName: "getPool",
    })) as `0x${string}`;
  });
}

type AccountAggregate = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/**
 * Cross-wallet batch prefetch of Aave `getUserAccountData` across chains.
 * Issues ONE multicall per chain containing all wallets' aggregate reads
 * (+ the pool-address resolve if not cached). Results are stored per-
 * wallet in the aggregate cache so each per-wallet `readAaveLendingPosition`
 * hits the cache instead of firing its own call. Mirrors the Compound
 * probe pattern — reduces N-wallet × M-chains aggregate fan-out to
 * M-chains multicalls.
 *
 * Cached entries are either the 6-tuple aggregate OR `null` (no
 * position) — distinguishing "empty wallet" from "RPC errored" because
 * an errored entry falls back to the uncached readContract path on the
 * next call. If the whole-chain multicall rejects, we skip populating
 * cache entries for that chain so downstream per-wallet reads trigger
 * the existing try/catch and return null (preserves the pre-#88
 * behavior on transport errors).
 */
export async function prefetchAaveAccountData(
  wallets: `0x${string}`[],
  chains: SupportedChain[],
): Promise<void> {
  if (wallets.length === 0 || chains.length === 0) return;
  await Promise.all(chains.map((chain) => prefetchChainAccountData(wallets, chain)));
}

async function prefetchChainAccountData(
  wallets: `0x${string}`[],
  chain: SupportedChain,
): Promise<void> {
  let poolAddr: `0x${string}`;
  try {
    poolAddr = await resolveAavePoolAddress(chain);
  } catch {
    return; // Provider unreachable; per-wallet reads will fall back.
  }
  const client = getClient(chain);
  try {
    const results = await client.multicall({
      contracts: wallets.map((w) => ({
        address: poolAddr,
        abi: aavePoolAbi,
        functionName: "getUserAccountData" as const,
        args: [w] as const,
      })),
      allowFailure: true,
    });
    wallets.forEach((wallet, i) => {
      const r = results[i];
      if (r.status !== "success") return; // leave uncached; fallback path
      const [totalCol, totalDebt] = r.result as AccountAggregate;
      const cacheKey = `aave-account:${chain}:${wallet.toLowerCase()}`;
      if (totalCol === 0n && totalDebt === 0n) {
        cache.set(cacheKey, { empty: true as const }, CACHE_TTL.POSITION);
      } else {
        cache.set(
          cacheKey,
          { empty: false as const, account: r.result as AccountAggregate },
          CACHE_TTL.POSITION,
        );
      }
    });
  } catch {
    // Whole-chain multicall rejected. Skip cache population — downstream
    // per-wallet reads will hit the uncached path, which wraps its own
    // try/catch and returns null cleanly.
  }
}

async function readAaveLendingPosition(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<LendingPosition | null> {
  const client = getClient(chain);
  const provider = CONTRACTS[chain].aave.poolAddressProvider as `0x${string}`;
  const uiProvider = CONTRACTS[chain].aave.uiPoolDataProvider as `0x${string}`;

  // Cache-first: prefetchAaveAccountData populates the aggregate cache
  // before portfolio fan-out. On hit, the null-position case short-
  // circuits immediately (~0 RPC); the non-null case skips only the
  // aggregate read, still needs the per-reserve breakdown below.
  const cacheKey = `aave-account:${chain}:${wallet.toLowerCase()}`;
  const cached = cache.get<
    { empty: true } | { empty: false; account: AccountAggregate }
  >(cacheKey);
  let account: AccountAggregate;
  if (cached) {
    if (cached.empty) return null;
    account = cached.account;
  } else {
    // Miss: fall through to the original per-wallet read. Resolve pool
    // via the cached helper first to avoid a redundant getPool call.
    const poolAddr = await resolveAavePoolAddress(chain);
    account = (await client.readContract({
      address: poolAddr,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [wallet],
    })) as AccountAggregate;
  }

  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] =
    account;

  if (totalCollateralBase === 0n && totalDebtBase === 0n) return null;

  const agg: AggregateData = {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  };

  let userReservesRaw: UserReserve[] = [];
  let reservesRaw: ReserveData[] = [];
  let baseCurrencyRaw: BaseCurrencyInfo | null = null;
  try {
    const [userReservesResult, reservesResult] = await Promise.all([
      client.readContract({
        address: uiProvider,
        abi: aaveUiPoolDataProviderAbi,
        functionName: "getUserReservesData",
        args: [provider, wallet],
      }),
      client.readContract({
        address: uiProvider,
        abi: aaveUiPoolDataProviderAbi,
        functionName: "getReservesData",
        args: [provider],
      }),
    ]);
    [userReservesRaw] = userReservesResult as unknown as [UserReserve[], number];
    const [rr, bc] = reservesResult as unknown as [ReserveData[], BaseCurrencyInfo];
    reservesRaw = rr;
    baseCurrencyRaw = bc;
  } catch {
    // UiPoolDataProvider ABI drift — surface what we have (aggregate only).
  }

  const reservesBySymbol = new Map<string, ReserveData>(
    reservesRaw.map((r) => [r.underlyingAsset.toLowerCase(), r])
  );

  const collateral: TokenAmount[] = [];
  const debt: TokenAmount[] = [];
  const warnings: string[] = [];

  // Skip per-reserve breakdown if the UiPoolDataProvider call failed — aggregate totals above
  // are still returned.
  if (!baseCurrencyRaw) {
    return buildPosition(chain, agg, collateral, debt, warnings);
  }

  // Unit-of-account price = USD price with `networkBaseTokenPriceDecimals` decimals
  const usdUnit = 10 ** baseCurrencyRaw.networkBaseTokenPriceDecimals;
  const marketBase = Number(baseCurrencyRaw.marketReferenceCurrencyUnit);

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

    // Only emit a warning if the user actually has exposure (collateral OR debt) on this
    // reserve. A frozen reserve the user isn't in isn't a surprise for their position.
    if (aTokenBalance > 0n || totalDebt > 0n) {
      if (reserve.isPaused) {
        warnings.push(
          `${reserve.symbol}: paused — all supply/borrow/withdraw/repay disabled on this reserve until Aave governance unpauses`
        );
      } else if (reserve.isFrozen) {
        warnings.push(
          `${reserve.symbol}: frozen — no new supplies or borrows; existing withdraws/repays still allowed`
        );
      }
    }
  }

  return buildPosition(chain, agg, collateral, debt, warnings);
}

function buildPosition(
  chain: SupportedChain,
  agg: AggregateData,
  collateral: TokenAmount[],
  debt: TokenAmount[],
  warnings: string[]
): LendingPosition {
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
    ...(warnings.length > 0 ? { warnings } : {}),
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
