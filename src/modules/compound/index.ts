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

  // allowFailure:true so one weird sub-read doesn't nuke the batch. Previously
  // we silently dropped any failed market to null; now we THROW on any of the
  // three position-critical reads failing, because the registry is curated
  // (every address in CONTRACTS[chain].compound is a known-deployed Comet
  // proxy). A silent null-return here is how issue #34 hid a six-figure
  // cUSDCv3 supply — a flaky RPC made the market invisible and the aggregator
  // reported clean coverage. numAssets is the only sub-read allowed to fail
  // silently: it just gates the collateral breakdown, not the base position.
  const results = await client.multicall({
    contracts: [
      { address: comet, abi: cometAbi, functionName: "baseToken" },
      { address: comet, abi: cometAbi, functionName: "numAssets" },
      { address: comet, abi: cometAbi, functionName: "balanceOf", args: [wallet] },
      { address: comet, abi: cometAbi, functionName: "borrowBalanceOf", args: [wallet] },
    ],
    allowFailure: true,
  });
  const failed: string[] = [];
  if (results[0].status !== "success") failed.push("baseToken");
  if (results[2].status !== "success") failed.push("balanceOf");
  if (results[3].status !== "success") failed.push("borrowBalanceOf");
  if (failed.length > 0) {
    throw new Error(
      `Compound V3 ${chain}:${market.name} — ${failed.join(", ")} read failed on a curated-registry market`,
    );
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
  // If either base balance is nonzero we MUST know the base token's decimals
  // to format correctly — a silent fallback to 18 once rendered a 184k USDC
  // (6-decimal) supply as ~0.0000002 USDC. Previously this path `return null`'d,
  // which aggregator-side looked like "no position" and did NOT set the
  // `errored` flag (issue #36: a 184k cUSDCv3 supply vanished from results
  // with clean coverage). Throw instead, so the Promise.allSettled wrapper in
  // getCompoundPositions classifies the market as errored and `positions: []`
  // is never reported as clean coverage when a curated-registry market's
  // base-token decimals read failed.
  if (
    metaResults[0].status !== "success" &&
    (baseSuppliedWei > 0n || baseBorrowedWei > 0n)
  ) {
    throw new Error(
      `Compound V3 ${chain}:${market.name} — base-token decimals read failed ` +
        `on a curated-registry market with a nonzero base balance; refusing to ` +
        `emit a wrong-scale amount.`,
    );
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
): Promise<{
  wallet: `0x${string}`;
  positions: CompoundPosition[];
  /**
   * True if any per-market read failed (RPC blip on a deployed market). A
   * six-figure position can vanish from `positions` when this is true, so the
   * portfolio aggregator uses this to set `coverage.compound.errored = true`
   * instead of claiming clean coverage. See issue #34.
   */
  errored: boolean;
  /** Per-market failures, for diagnostics when errored is true. */
  erroredMarkets?: { chain: SupportedChain; market: string; error: string }[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = (args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS];
  // Use allSettled so an unhealthy chain (Multicall3 returning 0x, rate-limit, etc.)
  // doesn't nuke the other chain's results. Rejections are counted and surfaced via
  // the `errored` flag — the previous silent `.catch(() => null)` swallow meant a
  // flaky cUSDCv3 read would drop a live six-figure supply without any warning.
  const tagged = chains.flatMap((chain) =>
    listMarkets(chain).map((m) => ({ chain, market: m })),
  );
  const settled = await Promise.allSettled(
    tagged.map(({ chain, market }) => readMarketPosition(wallet, chain, market)),
  );
  const positions: CompoundPosition[] = [];
  const erroredMarkets: { chain: SupportedChain; market: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value !== null) positions.push(r.value);
    } else {
      erroredMarkets.push({
        chain: tagged[i].chain,
        market: tagged[i].market.name,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  return {
    wallet,
    positions,
    errored: erroredMarkets.length > 0,
    ...(erroredMarkets.length > 0 ? { erroredMarkets } : {}),
  };
}

export { formatUnits };
