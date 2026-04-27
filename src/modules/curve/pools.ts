/**
 * Curve pool discovery + per-pool metadata.
 * v0.1 — Ethereum stable_ng plain pools only.
 *
 * Discovery follows the SDK's per-factory iteration approach:
 *   factory.pool_count() → N
 *   factory.pool_list(0..N-1) → pool addresses
 *
 * MetaRegistry is intentionally NOT used (its deployment address per chain
 * is unverified per the plan's rnd-pass — circle back if multi-factory
 * support is added in a follow-up). Per-factory iteration matches the
 * @curvefi/api SDK's approach and dodges the unresolved address.
 *
 * Per-pool metadata (coins, balances, n_coins, is_meta, gauge) is read
 * via the factory's view methods rather than calling the pool directly —
 * the factory aggregates this in one place.
 *
 * Cache: 30s TTL. Pool list rarely changes; balances update faster but
 * the composer above us re-reads via direct pool calls when freshness
 * matters (e.g. before a write).
 */
import type { Address } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { curveStableNgFactoryAbi } from "../../abis/curve.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface CurvePoolMetadata {
  pool: Address;
  /** stable_ng plain only in v0.1 — meta pools filtered out. */
  poolType: "stable-ng-plain";
  coins: Address[];
  /** Reserves in raw token units (per-coin decimals applied by caller). */
  balances: bigint[];
  /** Gauge address for staking; null when no gauge deployed. */
  gauge: Address | null;
}

/**
 * Enumerate stable_ng plain pools on Ethereum + return per-pool metadata.
 * Filters out meta pools (factory.is_meta(pool) === true) — meta pools
 * have a different ABI signature for add_liquidity (fixed uint256[2] vs
 * dynamic uint256[]) and are deferred to a follow-up PR.
 */
export async function listEthereumStableNgPools(): Promise<CurvePoolMetadata[]> {
  return cache.remember("curve:pools:eth-stable-ng", CACHE_TTL.YIELD, async () => {
    const factory = CONTRACTS.ethereum.curve.stableNgFactory as Address;
    const client = getClient("ethereum");

    const poolCount = (await client.readContract({
      address: factory,
      abi: curveStableNgFactoryAbi,
      functionName: "pool_count",
    })) as bigint;

    if (poolCount === 0n) return [];

    // Fetch all pool addresses via multicall — pool_list(i) for i in [0, N).
    const indexCalls = Array.from({ length: Number(poolCount) }, (_, i) => ({
      address: factory,
      abi: curveStableNgFactoryAbi,
      functionName: "pool_list" as const,
      args: [BigInt(i)] as const,
    }));
    const addressResults = await client.multicall({
      contracts: indexCalls,
      allowFailure: true,
    });
    const poolAddresses = addressResults
      .map((r) => (r.status === "success" ? (r.result as Address) : null))
      .filter((a): a is Address => a !== null && a !== ZERO_ADDRESS);

    if (poolAddresses.length === 0) return [];

    // Per-pool: is_meta, get_coins, get_balances, get_gauge — one multicall.
    const perPoolCalls = poolAddresses.flatMap((pool) => [
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "is_meta" as const,
        args: [pool] as const,
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_coins" as const,
        args: [pool] as const,
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_balances" as const,
        args: [pool] as const,
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_gauge" as const,
        args: [pool] as const,
      },
    ]);
    const perPoolResults = await client.multicall({
      contracts: perPoolCalls,
      allowFailure: true,
    });

    const out: CurvePoolMetadata[] = [];
    for (let i = 0; i < poolAddresses.length; i++) {
      const isMetaR = perPoolResults[i * 4];
      const coinsR = perPoolResults[i * 4 + 1];
      const balsR = perPoolResults[i * 4 + 2];
      const gaugeR = perPoolResults[i * 4 + 3];

      // Skip pools where any of the four reads failed — better to miss a
      // pool than to surface partial / corrupt metadata that callers
      // could mistakenly act on.
      if (isMetaR.status !== "success" || coinsR.status !== "success" || balsR.status !== "success" || gaugeR.status !== "success") {
        continue;
      }
      // v0.1: filter meta pools out (different add_liquidity ABI; separate follow-up).
      if (isMetaR.result === true) continue;

      const rawCoins = coinsR.result as readonly Address[];
      // get_coins returns a fixed-size MAX_COINS array padded with zero
      // addresses for unused slots; trim trailing zeros.
      const coins: Address[] = [];
      for (const c of rawCoins) {
        if (c === ZERO_ADDRESS) break;
        coins.push(c);
      }
      const rawBalances = balsR.result as readonly bigint[];
      const balances = rawBalances.slice(0, coins.length);

      const gaugeAddr = gaugeR.result as Address;
      const gauge = gaugeAddr === ZERO_ADDRESS ? null : gaugeAddr;

      out.push({
        pool: poolAddresses[i],
        poolType: "stable-ng-plain",
        coins,
        balances: balances as bigint[],
        gauge,
      });
    }
    return out;
  });
}
