import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { cometAbi } from "../../abis/compound-comet.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import type { GetCompoundPositionsArgs } from "./schemas.js";
import type { SupportedChain, TokenAmount } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

/**
 * A Compound V3 Comet position for a single market.
 * `baseSupplied` and `baseBorrowed` are mutually exclusive at the Comet level — an
 * account either has a positive base balance or a nonzero borrow balance, never both.
 */
export interface CompoundPosition {
  protocol: "compound-v3";
  chain: SupportedChain;
  market: string;
  marketAddress: `0x${string}`;
  baseSupplied: TokenAmount | null;
  baseBorrowed: TokenAmount | null;
  collateral: TokenAmount[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
}

function listMarkets(chain: SupportedChain): { name: string; address: `0x${string}` }[] {
  const comp = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]
    ?.compound;
  if (!comp) return [];
  return Object.entries(comp).map(([name, address]) => ({
    name,
    address: address as `0x${string}`,
  }));
}

async function readMarketPosition(
  wallet: `0x${string}`,
  chain: SupportedChain,
  market: { name: string; address: `0x${string}` }
): Promise<CompoundPosition | null> {
  const client = getClient(chain);
  const comet = market.address;

  // Tolerate markets that aren't deployed / reverted — we silently skip them. Previously this
  // used allowFailure:false which made ONE bad market address in the registry blow up the
  // entire portfolio call.
  const results = await client.multicall({
    contracts: [
      { address: comet, abi: cometAbi, functionName: "baseToken" },
      { address: comet, abi: cometAbi, functionName: "numAssets" },
      { address: comet, abi: cometAbi, functionName: "balanceOf", args: [wallet] },
      { address: comet, abi: cometAbi, functionName: "borrowBalanceOf", args: [wallet] },
    ],
    allowFailure: true,
  });
  if (results.some((r) => r.status === "failure")) return null;
  const baseToken = results[0].result;
  const numAssets = results[1].result;
  const supplied = results[2].result;
  const borrowed = results[3].result;
  const baseAddr = baseToken as `0x${string}`;
  const n = Number(numAssets);

  // Fetch base token metadata + enumerate collateral asset addresses.
  const metaCalls = [
    { address: baseAddr, abi: erc20Abi, functionName: "decimals" as const },
    { address: baseAddr, abi: erc20Abi, functionName: "symbol" as const },
    ...Array.from({ length: n }, (_, i) => ({
      address: comet,
      abi: cometAbi,
      functionName: "getAssetInfo" as const,
      args: [i] as const,
    })),
  ];
  const metaResults = await client.multicall({ contracts: metaCalls, allowFailure: false });
  const baseDecimals = Number(metaResults[0]);
  const baseSymbol = metaResults[1] as string;
  const assetInfos = metaResults.slice(2) as unknown as Array<{
    asset: `0x${string}`;
  }>;

  // Collateral balances (parallel).
  const collateralAddrs = assetInfos.map((a) => a.asset);
  const collatResults =
    collateralAddrs.length === 0
      ? []
      : await client.multicall({
          contracts: collateralAddrs.flatMap((addr) => [
            {
              address: comet,
              abi: cometAbi,
              functionName: "collateralBalanceOf" as const,
              args: [wallet, addr] as const,
            },
            { address: addr, abi: erc20Abi, functionName: "decimals" as const },
            { address: addr, abi: erc20Abi, functionName: "symbol" as const },
          ]),
          allowFailure: false,
        });

  const baseSuppliedWei = supplied as bigint;
  const baseBorrowedWei = borrowed as bigint;

  if (baseSuppliedWei === 0n && baseBorrowedWei === 0n && collateralAddrs.every((_, i) => (collatResults[i * 3] as bigint) === 0n)) {
    return null;
  }

  const baseSupplied =
    baseSuppliedWei > 0n
      ? makeTokenAmount(chain, baseAddr, baseSuppliedWei, baseDecimals, baseSymbol)
      : null;
  const baseBorrowed =
    baseBorrowedWei > 0n
      ? makeTokenAmount(chain, baseAddr, baseBorrowedWei, baseDecimals, baseSymbol)
      : null;

  const collateral: TokenAmount[] = [];
  for (let i = 0; i < collateralAddrs.length; i++) {
    const bal = collatResults[i * 3] as bigint;
    if (bal === 0n) continue;
    const decimals = Number(collatResults[i * 3 + 1]);
    const symbol = collatResults[i * 3 + 2] as string;
    collateral.push(makeTokenAmount(chain, collateralAddrs[i], bal, decimals, symbol));
  }

  // Batch price everything (base + collaterals).
  const toPrice = [baseSupplied, baseBorrowed, ...collateral].filter(
    (t): t is TokenAmount => t !== null
  );
  await priceTokenAmounts(chain, toPrice);

  const totalCollateralUsd = collateral.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
  const totalDebtUsd = baseBorrowed?.valueUsd ?? 0;
  const totalSuppliedUsd = baseSupplied?.valueUsd ?? 0;

  return {
    protocol: "compound-v3",
    chain,
    market: market.name,
    marketAddress: market.address,
    baseSupplied,
    baseBorrowed,
    collateral,
    totalCollateralUsd: round(totalCollateralUsd, 2),
    totalDebtUsd: round(totalDebtUsd, 2),
    totalSuppliedUsd: round(totalSuppliedUsd, 2),
    netValueUsd: round(totalSuppliedUsd + totalCollateralUsd - totalDebtUsd, 2),
  };
}

export async function getCompoundPositions(
  args: GetCompoundPositionsArgs
): Promise<{ wallet: `0x${string}`; positions: CompoundPosition[] }> {
  const wallet = args.wallet as `0x${string}`;
  const chains = (args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS];
  // Use allSettled so an unhealthy chain (Multicall3 returning 0x, rate-limit, etc.)
  // doesn't nuke the other chain's results. Rejected reads are dropped silently.
  const tasks = chains.flatMap((chain) =>
    listMarkets(chain).map((m) => readMarketPosition(wallet, chain, m).catch(() => null))
  );
  const all = await Promise.all(tasks);
  return { wallet, positions: all.filter((p): p is CompoundPosition => p !== null) };
}

export { formatUnits };
