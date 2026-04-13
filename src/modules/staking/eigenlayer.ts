import { zeroAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { eigenStrategyManagerAbi, eigenStrategyAbi } from "../../abis/eigenlayer-strategy-manager.js";
import { eigenDelegationManagerAbi } from "../../abis/eigenlayer-delegation-manager.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount } from "../../data/format.js";
import { getTokenPrices } from "../../data/prices.js";
import type { StakingPosition } from "../../types/index.js";

/**
 * EigenLayer positions — Ethereum only.
 *
 * Uses `StrategyManager.getDeposits(staker)` which returns strategies + shares together in
 * one call. Previously we used `stakerStrategyList(staker)` — that signature doesn't exist:
 * the public mapping's auto-generated getter takes (address, uint256) and reverts when
 * called with just the address. See the ABI file for context.
 *
 * The whole function is wrapped so a revert or RPC error returns `[]` instead of killing
 * the enclosing portfolio call. EigenLayer is frequently upgraded and its contracts move —
 * we should never let staking failure block the rest of the portfolio.
 */
export async function getEigenLayerPositions(wallet: `0x${string}`): Promise<StakingPosition[]> {
  try {
    return await readEigenLayerPositions(wallet);
  } catch {
    return [];
  }
}

async function readEigenLayerPositions(wallet: `0x${string}`): Promise<StakingPosition[]> {
  const client = getClient("ethereum");
  const strategyManager = CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`;
  const delegationManager = CONTRACTS.ethereum.eigenlayer.delegationManager as `0x${string}`;

  const [deposits, delegatedTo] = await Promise.all([
    client.readContract({
      address: strategyManager,
      abi: eigenStrategyManagerAbi,
      functionName: "getDeposits",
      args: [wallet],
    }) as Promise<readonly [readonly `0x${string}`[], readonly bigint[]]>,
    client.readContract({
      address: delegationManager,
      abi: eigenDelegationManagerAbi,
      functionName: "delegatedTo",
      args: [wallet],
    }) as Promise<`0x${string}`>,
  ]);

  const [strategies, shares] = deposits;
  if (strategies.length === 0) return [];

  // Resolve each strategy's underlying token (one call per strategy).
  const underlyingResults = await client.multicall({
    contracts: strategies.map((strategy) => ({
      address: strategy,
      abi: eigenStrategyAbi,
      functionName: "underlyingToken" as const,
    })),
    allowFailure: true,
  });

  const perStrategy: Array<{ strategy: `0x${string}`; shares: bigint; underlying: `0x${string}` }> = [];
  for (let i = 0; i < strategies.length; i++) {
    const s = shares[i];
    if (s === 0n) continue;
    const u = underlyingResults[i];
    if (u.status !== "success") continue;
    perStrategy.push({ strategy: strategies[i], shares: s, underlying: u.result as `0x${string}` });
  }

  if (perStrategy.length === 0) return [];

  const metaContracts = perStrategy.flatMap(({ strategy, shares, underlying }) => [
    { address: strategy, abi: eigenStrategyAbi, functionName: "sharesToUnderlyingView", args: [shares] },
    { address: underlying, abi: erc20Abi, functionName: "decimals" },
    { address: underlying, abi: erc20Abi, functionName: "symbol" },
  ] as const);
  const metaResults = await client.multicall({ contracts: metaContracts, allowFailure: true });

  const prices = await getTokenPrices(
    perStrategy.map((p) => ({ chain: "ethereum" as const, address: p.underlying }))
  );

  const isDelegated = delegatedTo !== zeroAddress;
  const positions: StakingPosition[] = [];

  for (let i = 0; i < perStrategy.length; i++) {
    const p = perStrategy[i];
    const underlyingAmountRes = metaResults[i * 3];
    const decimalsRes = metaResults[i * 3 + 1];
    const symbolRes = metaResults[i * 3 + 2];
    if (underlyingAmountRes.status !== "success" || decimalsRes.status !== "success") continue;
    const amountWei = underlyingAmountRes.result as bigint;
    const decimals = Number(decimalsRes.result);
    const symbol = symbolRes.status === "success" ? (symbolRes.result as string) : "?";
    const priceUsd = prices.get(`ethereum:${p.underlying.toLowerCase()}`);

    positions.push({
      protocol: "eigenlayer",
      chain: "ethereum",
      stakedAmount: makeTokenAmount("ethereum", p.underlying, amountWei, decimals, symbol, priceUsd),
      delegatedTo: isDelegated ? delegatedTo : undefined,
      meta: {
        strategy: p.strategy,
        shares: p.shares.toString(),
        isDelegated,
      },
    });
  }

  return positions;
}
