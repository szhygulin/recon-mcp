import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { CONTRACTS } from "../../config/contracts.js";
import { stETHAbi, wstETHAbi } from "../../abis/lido.js";
import { getTokenPrice } from "../../data/prices.js";
import { makeTokenAmount, round } from "../../data/format.js";
import type { StakingPosition, SupportedChain } from "../../types/index.js";

/**
 * Lido staking positions across Ethereum (stETH + wstETH) and Arbitrum
 * (wstETH only). Results are cached per-wallet for CACHE_TTL.POSITION
 * (60s) so a multi-wallet portfolio summary calling repeatedly in a
 * short window doesn't re-hit the mainnet RPC — a live #88 trace
 * showed Lido 429ing on 3 of 4 wallets when every wallet's fetch hit
 * Infura fresh. The `chains` filter is folded into the cache key so a
 * partial-chain call (e.g. just mainnet) doesn't cache-poison a later
 * multi-chain read.
 */
export async function getLidoPositions(wallet: `0x${string}`, chains: SupportedChain[]): Promise<StakingPosition[]> {
  const chainsKey = [...chains].sort().join(",");
  const cacheKey = `lido:${wallet.toLowerCase()}:${chainsKey}`;
  return cache.remember(cacheKey, CACHE_TTL.POSITION, () =>
    fetchLidoPositions(wallet, chains),
  );
}

/**
 * Cross-wallet batch prefetch for Lido mainnet reads. Issues ONE
 * multicall on ethereum containing `stEthPerToken()` + all wallets'
 * `stETH.balanceOf` + `wstETH.balanceOf`. Results are stored per-
 * wallet in a raw-data cache so per-wallet `fetchLidoPositions` on
 * ethereum checks that cache first and skips its own multicall.
 *
 * Mirrors the Compound + Aave prefetch pattern. For a 4-wallet
 * portfolio call, ethereum Lido reads drop from 4 multicalls
 * (3 calls each = 12 RPC) to 1 multicall (1 + 2*4 = 9 reads batched).
 * Arbitrum Lido reads aren't batched here — the per-wallet flow is
 * already 1 balanceOf per wallet, and arbitrum wstETH exposure is
 * typically small. If arbitrum becomes the next hotspot, the same
 * pattern extends trivially.
 */
export async function prefetchLidoMainnet(wallets: `0x${string}`[]): Promise<void> {
  if (wallets.length === 0) return;
  const client = getClient("ethereum");
  const stEthAddr = CONTRACTS.ethereum.lido.stETH as `0x${string}`;
  const wstEthAddr = CONTRACTS.ethereum.lido.wstETH as `0x${string}`;
  try {
    const contracts = [
      { address: wstEthAddr, abi: wstETHAbi, functionName: "stEthPerToken" as const },
      ...wallets.flatMap((w) => [
        { address: stEthAddr, abi: stETHAbi, functionName: "balanceOf" as const, args: [w] as const },
        { address: wstEthAddr, abi: wstETHAbi, functionName: "balanceOf" as const, args: [w] as const },
      ]),
    ];
    const results = await client.multicall({ contracts, allowFailure: true });
    const stPerResult = results[0];
    if (stPerResult.status !== "success") return;
    const stPer = stPerResult.result as bigint;
    wallets.forEach((wallet, i) => {
      const stResult = results[1 + i * 2];
      const wstResult = results[1 + i * 2 + 1];
      if (stResult.status !== "success" || wstResult.status !== "success") return;
      cache.set(
        `lido-raw-eth:${wallet.toLowerCase()}`,
        {
          stEthWei: stResult.result as bigint,
          wstEthWei: wstResult.result as bigint,
          stEthPerToken: stPer,
        },
        CACHE_TTL.POSITION,
      );
    });
  } catch {
    // Whole-multicall failure — skip cache population; per-wallet reads
    // fall through to their own multicall (which may succeed post-rate-
    // limit window).
  }
}

async function fetchLidoPositions(wallet: `0x${string}`, chains: SupportedChain[]): Promise<StakingPosition[]> {
  const positions: StakingPosition[] = [];
  const ethPrice = await getTokenPrice("ethereum", "native");

  for (const chain of chains) {
    const client = getClient(chain);

    if (chain === "ethereum") {
      const stEthAddr = CONTRACTS.ethereum.lido.stETH as `0x${string}`;
      const wstEthAddr = CONTRACTS.ethereum.lido.wstETH as `0x${string}`;

      // Prefetch populates this cache before the portfolio fan-out so
      // the per-wallet path skips its own multicall when batched data
      // is already available. Single-wallet callers (get_staking_*) or
      // cold starts fall through to the per-wallet multicall below.
      let stEthWei: bigint;
      let wstEthWei: bigint;
      let stPer: bigint;
      const raw = cache.get<{
        stEthWei: bigint;
        wstEthWei: bigint;
        stEthPerToken: bigint;
      }>(`lido-raw-eth:${wallet.toLowerCase()}`);
      if (raw) {
        stEthWei = raw.stEthWei;
        wstEthWei = raw.wstEthWei;
        stPer = raw.stEthPerToken;
      } else {
        const [stBalance, wstBalance, stPerWst] = await client.multicall({
          contracts: [
            { address: stEthAddr, abi: stETHAbi, functionName: "balanceOf", args: [wallet] },
            { address: wstEthAddr, abi: wstETHAbi, functionName: "balanceOf", args: [wallet] },
            { address: wstEthAddr, abi: wstETHAbi, functionName: "stEthPerToken" },
          ],
          allowFailure: false,
        });
        stEthWei = stBalance as bigint;
        wstEthWei = wstBalance as bigint;
        stPer = stPerWst as bigint;
      }
      // Convert wstETH to stETH equivalent (both 18 decimals).
      const wstInStEth = (wstEthWei * stPer) / 10n ** 18n;
      const totalStEthWei = stEthWei + wstInStEth;

      if (totalStEthWei > 0n) {
        const apr = await getLidoApr();
        positions.push({
          protocol: "lido",
          chain,
          stakedAmount: makeTokenAmount(chain, stEthAddr, totalStEthWei, 18, "stETH", ethPrice),
          apr,
          meta: {
            stEthBalance: stEthWei.toString(),
            wstEthBalance: wstEthWei.toString(),
            wstEthAsStEth: wstInStEth.toString(),
          },
        });
      }
    }

    if (chain === "arbitrum") {
      const wstEthAddr = CONTRACTS.arbitrum.lido.wstETH as `0x${string}`;
      // On Arbitrum, wstETH is the only Lido-adjacent token, and stEthPerToken
      // is not available (bridged representation) — we use Ethereum's rate.
      const wstBalance = (await client.readContract({
        address: wstEthAddr,
        abi: wstETHAbi,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;

      if (wstBalance > 0n) {
        const ethClient = getClient("ethereum");
        const stPer = (await ethClient.readContract({
          address: CONTRACTS.ethereum.lido.wstETH as `0x${string}`,
          abi: wstETHAbi,
          functionName: "stEthPerToken",
        })) as bigint;
        const wstInStEth = (wstBalance * stPer) / 10n ** 18n;
        const apr = await getLidoApr();
        positions.push({
          protocol: "lido",
          chain,
          stakedAmount: makeTokenAmount(chain, wstEthAddr, wstInStEth, 18, "wstETH (as stETH)", ethPrice),
          apr,
          meta: { wstEthBalance: wstBalance.toString() },
        });
      }
    }
  }

  return positions;
}

/** Fetch current Lido Ethereum APR from DefiLlama yields. Cached 10 minutes. */
export async function getLidoApr(): Promise<number | undefined> {
  return cache.remember("yields:lido-eth", CACHE_TTL.YIELD, async () => {
    try {
      const res = await fetch("https://yields.llama.fi/pools");
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data: Array<{ project: string; symbol: string; apy: number; chain: string }> };
      const pool = body.data.find(
        (p) => p.project === "lido" && p.symbol === "STETH" && p.chain === "Ethereum"
      );
      return pool ? round(pool.apy / 100, 6) : undefined;
    } catch {
      return undefined;
    }
  });
}

/**
 * Rough rewards estimate for Lido — we lack historical balances without an indexer,
 * so we project: rewards ≈ balance × apr × (days / 365).
 */
export function estimateLidoRewards(
  currentBalance: StakingPosition,
  days: number
): { amount: string; valueUsd?: number; note: string } | undefined {
  const apr = currentBalance.apr;
  if (!apr) return undefined;
  const bal = Number(formatUnits(BigInt(currentBalance.stakedAmount.amount), 18));
  const amount = bal * apr * (days / 365);
  const valueUsd = currentBalance.stakedAmount.priceUsd
    ? round(amount * currentBalance.stakedAmount.priceUsd, 2)
    : undefined;
  return {
    amount: amount.toFixed(6),
    valueUsd,
    note: "Estimate based on current APR; actual rewards depend on rebase timing.",
  };
}
