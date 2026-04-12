import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { CONTRACTS } from "../../config/contracts.js";
import { stETHAbi, wstETHAbi } from "../../abis/lido.js";
import { getTokenPrice } from "../../data/prices.js";
import { makeTokenAmount, round } from "../../data/format.js";
import type { StakingPosition, SupportedChain } from "../../types/index.js";

/** Lido staking positions across Ethereum (stETH + wstETH) and Arbitrum (wstETH only). */
export async function getLidoPositions(wallet: `0x${string}`, chains: SupportedChain[]): Promise<StakingPosition[]> {
  const positions: StakingPosition[] = [];
  const ethPrice = await getTokenPrice("ethereum", "native");

  for (const chain of chains) {
    const client = getClient(chain);

    if (chain === "ethereum") {
      const stEthAddr = CONTRACTS.ethereum.lido.stETH as `0x${string}`;
      const wstEthAddr = CONTRACTS.ethereum.lido.wstETH as `0x${string}`;

      const [stBalance, wstBalance, stPerWst] = await client.multicall({
        contracts: [
          { address: stEthAddr, abi: stETHAbi, functionName: "balanceOf", args: [wallet] },
          { address: wstEthAddr, abi: wstETHAbi, functionName: "balanceOf", args: [wallet] },
          { address: wstEthAddr, abi: wstETHAbi, functionName: "stEthPerToken" },
        ],
        allowFailure: false,
      });

      const stEthWei = stBalance as bigint;
      const wstEthWei = wstBalance as bigint;
      const stPer = stPerWst as bigint;
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
