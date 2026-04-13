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
  // Need baseToken + balanceOf + borrowBalanceOf to say anything meaningful. numAssets
  // failing is survivable — we just skip the collateral breakdown.
  if (
    results[0].status !== "success" ||
    results[2].status !== "success" ||
    results[3].status !== "success"
  ) {
    return null;
  }
  const baseToken = results[0].result;
  const supplied = results[2].result;
  const borrowed = results[3].result;
  const baseAddr = baseToken as `0x${string}`;
  const n = results[1].status === "success" ? Number(results[1].result) : 0;

  // Fetch base token metadata + enumerate collateral asset addresses. allowFailure:true
  // so one weird collateral (non-standard decimals/symbol, rate-limit) doesn't nuke the
  // whole position. We fall back to sane defaults for base token metadata if needed.
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
  const metaResults = await client.multicall({ contracts: metaCalls, allowFailure: true });
  const baseSuppliedWei = supplied as bigint;
  const baseBorrowedWei = borrowed as bigint;
  // If either base balance is nonzero we MUST know the base token's decimals to
  // format correctly. Previously this silently fell back to 18, which rendered a
  // 184k USDC (6-decimal) supply as ~0.0000002 USDC — showed up as dust in the
  // portfolio summary while the direct get_compound_positions call succeeded.
  // Skip the market rather than emit a wrong-scale amount.
  if (
    metaResults[0].status !== "success" &&
    (baseSuppliedWei > 0n || baseBorrowedWei > 0n)
  ) {
    return null;
  }
  const baseDecimals =
    metaResults[0].status === "success" ? Number(metaResults[0].result) : 18;
  const baseSymbol =
    metaResults[1].status === "success" ? (metaResults[1].result as string) : "?";
  const collateralAddrs: `0x${string}`[] = [];
  for (let i = 0; i < n; i++) {
    const r = metaResults[2 + i];
    if (r.status !== "success") continue;
    const info = r.result as unknown as { asset: `0x${string}` };
    collateralAddrs.push(info.asset);
  }

  // Collateral balances (parallel). Per-slot allowFailure so one broken ERC-20 read
  // doesn't hide the (healthy) base supply/borrow numbers.
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
          allowFailure: true,
        });

  const collateral: TokenAmount[] = [];
  for (let i = 0; i < collateralAddrs.length; i++) {
    const balRes = collatResults[i * 3];
    if (balRes?.status !== "success") continue;
    const bal = balRes.result as bigint;
    if (bal === 0n) continue;
    const decRes = collatResults[i * 3 + 1];
    const symRes = collatResults[i * 3 + 2];
    const decimals = decRes?.status === "success" ? Number(decRes.result) : 18;
    const symbol = symRes?.status === "success" ? (symRes.result as string) : "?";
    collateral.push(makeTokenAmount(chain, collateralAddrs[i], bal, decimals, symbol));
  }

  if (baseSuppliedWei === 0n && baseBorrowedWei === 0n && collateral.length === 0) {
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
