import { zeroAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { eigenStrategyManagerAbi, eigenStrategyAbi } from "../../abis/eigenlayer-strategy-manager.js";
import { eigenDelegationManagerAbi } from "../../abis/eigenlayer-delegation-manager.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount } from "../../data/format.js";
import { getTokenPrices } from "../../data/prices.js";
import type { StakingPosition } from "../../types/index.js";

/** EigenLayer positions — Ethereum only. */
export async function getEigenLayerPositions(wallet: `0x${string}`): Promise<StakingPosition[]> {
  const client = getClient("ethereum");
  const strategyManager = CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`;
  const delegationManager = CONTRACTS.ethereum.eigenlayer.delegationManager as `0x${string}`;

  const [strategies, delegatedTo] = await Promise.all([
    client.readContract({
      address: strategyManager,
      abi: eigenStrategyManagerAbi,
      functionName: "stakerStrategyList",
      args: [wallet],
    }) as Promise<readonly `0x${string}`[]>,
    client.readContract({
      address: delegationManager,
      abi: eigenDelegationManagerAbi,
      functionName: "delegatedTo",
      args: [wallet],
    }) as Promise<`0x${string}`>,
  ]);

  if (strategies.length === 0) return [];

  // Per-strategy: shares, underlying token
  const contracts = strategies.flatMap((strategy) => [
    { address: strategyManager, abi: eigenStrategyManagerAbi, functionName: "stakerStrategyShares", args: [wallet, strategy] },
    { address: strategy, abi: eigenStrategyAbi, functionName: "underlyingToken" },
  ] as const);

  const results = await client.multicall({ contracts, allowFailure: true });

  const positions: StakingPosition[] = [];
  const underlyings: `0x${string}`[] = [];
  const perStrategy: Array<{ strategy: `0x${string}`; shares: bigint; underlying: `0x${string}` }> = [];

  for (let i = 0; i < strategies.length; i++) {
    const sharesRes = results[i * 2];
    const underlyingRes = results[i * 2 + 1];
    if (sharesRes.status !== "success" || underlyingRes.status !== "success") continue;
    const shares = sharesRes.result as bigint;
    if (shares === 0n) continue;
    const underlying = underlyingRes.result as `0x${string}`;
    perStrategy.push({ strategy: strategies[i], shares, underlying });
    underlyings.push(underlying);
  }

  if (perStrategy.length === 0) return [];

  // Fetch underlying metadata + conversion in one multicall
  const metaContracts = perStrategy.flatMap(({ strategy, shares, underlying }) => [
    { address: strategy, abi: eigenStrategyAbi, functionName: "sharesToUnderlyingView", args: [shares] },
    { address: underlying, abi: erc20Abi, functionName: "decimals" },
    { address: underlying, abi: erc20Abi, functionName: "symbol" },
  ] as const);
  const metaResults = await client.multicall({ contracts: metaContracts, allowFailure: true });

  // Batch price fetch for all underlyings
  const prices = await getTokenPrices(underlyings.map((a) => ({ chain: "ethereum" as const, address: a })));

  const isDelegated = delegatedTo !== zeroAddress;

  for (let i = 0; i < perStrategy.length; i++) {
    const p = perStrategy[i];
    const underlyingRes = metaResults[i * 3];
    const decimalsRes = metaResults[i * 3 + 1];
    const symbolRes = metaResults[i * 3 + 2];
    if (underlyingRes.status !== "success" || decimalsRes.status !== "success") continue;
    const amountWei = underlyingRes.result as bigint;
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
