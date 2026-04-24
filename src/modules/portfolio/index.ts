import { getClient } from "../../data/rpc.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../../config/contracts.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import { getTokenPrice } from "../../data/prices.js";
import { getLendingPositions, getLpPositions } from "../positions/index.js";
import { getStakingPositions } from "../staking/index.js";
import { getCompoundPositions } from "../compound/index.js";
import { getMorphoPositions } from "../morpho/index.js";
import { getTronBalances } from "../tron/balances.js";
import { getTronStaking } from "../tron/staking.js";
import { getSolanaBalances } from "../solana/balances.js";
import type { GetPortfolioSummaryArgs } from "./schemas.js";
import type {
  LendingPositionUnion,
  MultiWalletPortfolioSummary,
  PortfolioCoverage,
  PortfolioSummary,
  SolanaPortfolioSlice,
  SupportedChain,
  TokenAmount,
  TronPortfolioSlice,
  TronStakingSlice,
} from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function zeroNative(wallet: `0x${string}`, chain: SupportedChain): TokenAmount {
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    0n,
    18,
    NATIVE_SYMBOL[chain]
  );
}

async function fetchNativeBalance(wallet: `0x${string}`, chain: SupportedChain): Promise<TokenAmount> {
  const client = getClient(chain);
  const [balance, ethPrice] = await Promise.all([
    client.getBalance({ address: wallet }),
    getTokenPrice(chain, "native"),
  ]);
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    balance,
    18,
    NATIVE_SYMBOL[chain],
    ethPrice
  );
}

async function fetchTopErc20Balances(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<TokenAmount[]> {
  const tokens = CONTRACTS[chain].tokens as Record<string, string>;
  const entries = Object.entries(tokens);
  if (entries.length === 0) return [];

  const client = getClient(chain);
  const calls = entries.flatMap(([, addr]) => [
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet] as const },
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
  ]);
  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const out: TokenAmount[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [symbol, addr] = entries[i];
    const balanceRes = results[i * 2];
    const decimalsRes = results[i * 2 + 1];
    if (balanceRes.status !== "success" || decimalsRes.status !== "success") continue;
    const balance = balanceRes.result as bigint;
    if (balance === 0n) continue;
    const decimals = Number(decimalsRes.result);
    out.push(makeTokenAmount(chain, addr as `0x${string}`, balance, decimals, symbol));
  }

  await priceTokenAmounts(chain, out);
  return out;
}

export async function getPortfolioSummary(
  args: GetPortfolioSummaryArgs
): Promise<PortfolioSummary | MultiWalletPortfolioSummary> {
  if (!args.wallet && !(args.wallets && args.wallets.length > 0)) {
    throw new Error("Provide at least one of `wallet` or `wallets`.");
  }
  const chains = ((args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS]);
  const wallets = args.wallets?.length
    ? (args.wallets as `0x${string}`[])
    : args.wallet
    ? [args.wallet as `0x${string}`]
    : [];

  const tronAddress = args.tronAddress;
  const solanaAddress = args.solanaAddress;

  // Branch: single wallet returns the flat summary; multi-wallet aggregates.
  // TRON and Solana are only folded into the single-wallet summary — a
  // multi-wallet view with a single non-EVM address would be ambiguous
  // ("which EVM wallet does it belong to?"), so the caller must use
  // single-wallet mode when pairing with a non-EVM address.
  if (wallets.length === 1) {
    return buildWalletSummary(wallets[0], chains, tronAddress, solanaAddress);
  }
  if (tronAddress) {
    throw new Error(
      "`tronAddress` can only be combined with a single EVM `wallet`. For multi-wallet portfolios, call `get_portfolio_summary` once per EVM wallet."
    );
  }
  if (solanaAddress) {
    throw new Error(
      "`solanaAddress` can only be combined with a single EVM `wallet`. For multi-wallet portfolios, call `get_portfolio_summary` once per EVM wallet."
    );
  }

  const perWallet = await Promise.all(wallets.map((w) => buildWalletSummary(w, chains)));
  const totalUsd = round(perWallet.reduce((s, p) => s + p.totalUsd, 0), 2);
  const walletBalancesUsd = round(perWallet.reduce((s, p) => s + p.walletBalancesUsd, 0), 2);
  const lendingNetUsd = round(perWallet.reduce((s, p) => s + p.lendingNetUsd, 0), 2);
  const lpUsd = round(perWallet.reduce((s, p) => s + p.lpUsd, 0), 2);
  const stakingUsd = round(perWallet.reduce((s, p) => s + p.stakingUsd, 0), 2);
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;
  for (const p of perWallet) {
    for (const c of chains) {
      perChain[c] = round((perChain[c] ?? 0) + (p.perChain[c] ?? 0), 2);
    }
  }
  // Aggregate coverage: a subsystem is considered errored across the group if
  // ANY wallet's fetch failed — because the group-level total will be short
  // that wallet's contribution. Notes get merged to the worst (errored) state.
  const mergedCoverage: PortfolioCoverage = {
    aave: mergeCoverage(perWallet.map((p) => p.coverage.aave)),
    compound: mergeCoverage(perWallet.map((p) => p.coverage.compound)),
    morpho: mergeCoverage(perWallet.map((p) => p.coverage.morpho)),
    uniswapV3: mergeCoverage(perWallet.map((p) => p.coverage.uniswapV3)),
    staking: mergeCoverage(perWallet.map((p) => p.coverage.staking)),
    unpricedAssets: perWallet.reduce((s, p) => s + p.coverage.unpricedAssets, 0),
  };

  return {
    wallets,
    chains,
    totalUsd,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    perChain,
    perWallet,
    coverage: mergedCoverage,
  };
}

/**
 * Build the human-readable `coverage.compound.note` when one or more markets
 * failed to read. Includes per-chain + per-market + raw error message so the
 * agent can tell the user which specific market is broken instead of the
 * generic "fetch failed on at least one market" string (issue #88). When no
 * structured detail is available (empty array), falls back to the old
 * generic message so callers still get a non-empty note.
 *
 * Error messages are truncated to keep the note readable — the full detail
 * is available via `get_compound_positions` directly, which returns the
 * same `erroredMarkets` array on its response.
 *
 * Exported for unit testing; the getPortfolioSummary path is the real caller.
 */
export function formatCompoundErrorNote(
  erroredMarkets?: { chain: SupportedChain; market: string; error: string }[],
): string {
  const generic =
    "Compound V3 fetch failed on at least one market — some positions may be missing from totals.";
  if (!erroredMarkets || erroredMarkets.length === 0) return generic;
  const MAX_ERR = 120;
  const lines = erroredMarkets.map(({ chain, market, error }) => {
    const trimmed =
      error.length > MAX_ERR ? `${error.slice(0, MAX_ERR)}…` : error;
    return `${chain}/${market}: ${trimmed}`;
  });
  return `${generic} Failures: ${lines.join("; ")}. Call get_compound_positions for the full per-market read.`;
}

function mergeCoverage(entries: { covered: boolean; errored?: boolean; note?: string }[]) {
  const anyErrored = entries.some((e) => e.errored);
  const allCovered = entries.every((e) => e.covered);
  return {
    covered: allCovered && !anyErrored,
    ...(anyErrored ? { errored: true } : {}),
    ...(entries.find((e) => e.note)?.note ? { note: entries.find((e) => e.note)!.note } : {}),
  };
}

async function buildWalletSummary(
  wallet: `0x${string}`,
  chains: SupportedChain[],
  tronAddress?: string,
  solanaAddress?: string
): Promise<PortfolioSummary> {
  // Each subquery is independent — one failing shouldn't kill the summary. We swap
  // Promise.all for per-task catchers that return empty payloads on error, so a flaky
  // Aave read (say, "returned no data") still lets us report native + ERC-20 + LP totals.
  // Morpho Blue is discovered per-chain via event-log scan (onBehalf==wallet) since
  // Blue has no on-chain enumeration; discovery is the slowest subquery here on a
  // cold RPC, so it's wrapped in the same catch-and-continue pattern as the others.
  const emptyPositions = { wallet, positions: [] as never[] };
  // Wrap each subquery so the portfolio can distinguish failure from empty. A
  // thrown fetch becomes errored:true so callers don't mistake "Aave down" for
  // "no Aave position".
  const errors = {
    aave: false,
    compound: false,
    morpho: false,
    lp: false,
    staking: false,
    tron: false,
    tronStaking: false,
    solana: false,
  };
  // Per-market Compound V3 failure detail, populated when at least one market
  // read errored. Surfaced in coverage.compound.note so the agent can tell
  // the user WHICH chain/market failed and WHY, instead of the generic "fetch
  // failed on at least one market" message (issue #88).
  let compoundErroredMarkets:
    | { chain: SupportedChain; market: string; error: string }[]
    | undefined;
  const [
    nativeAmounts,
    erc20Amounts,
    aave,
    compound,
    morphoByChain,
    lp,
    staking,
    tronSlice,
    tronStakingSlice,
    solanaSlice,
  ] = await Promise.all([
      Promise.all(
        chains.map((c) =>
          fetchNativeBalance(wallet, c).catch(() => zeroNative(wallet, c))
        )
      ),
      Promise.all(chains.map((c) => fetchTopErc20Balances(wallet, c).catch(() => []))),
      getLendingPositions({ wallet, chains }).catch(() => {
        errors.aave = true;
        return emptyPositions as never;
      }),
      getCompoundPositions({ wallet, chains })
        .then((r) => {
          // Per-market reads use allSettled internally, so the top-level
          // promise succeeds even when individual markets errored. Surface
          // that partial failure so coverage.compound.errored is correct —
          // without this, a flaky cUSDCv3 read would drop a six-figure
          // supply while the aggregator still reported clean coverage
          // (issue #34). The underlying per-market error strings flow
          // through to coverage.compound.note so callers can diagnose
          // which chain/market is broken instead of guessing (issue #88).
          if (r.errored) {
            errors.compound = true;
            if (r.erroredMarkets && r.erroredMarkets.length > 0) {
              compoundErroredMarkets = r.erroredMarkets;
            }
          }
          return r;
        })
        .catch((e) => {
          errors.compound = true;
          compoundErroredMarkets = [
            {
              chain: "ethereum" as SupportedChain,
              market: "(all)",
              error: e instanceof Error ? e.message : String(e),
            },
          ];
          return emptyPositions as never;
        }),
      // Morpho has no multi-chain list endpoint; fan out per-chain and swallow
      // per-chain failures individually so one bad RPC doesn't drop the whole
      // Morpho bucket. If any chain throws, the overall coverage is errored.
      Promise.all(
        chains.map((c) =>
          getMorphoPositions({ wallet, chain: c }).catch(() => {
            errors.morpho = true;
            return { wallet, positions: [] };
          })
        )
      ),
      getLpPositions({ wallet, chains }).catch(() => {
        errors.lp = true;
        return emptyPositions as never;
      }),
      getStakingPositions({ wallet, chains }).catch(() => {
        errors.staking = true;
        return emptyPositions as never;
      }),
      // TRON reads are only attempted when the caller passed a tronAddress.
      // `null` means "not attempted" (coverage.tron left as
      // covered:false,errored:false — same semantics as Morpho without
      // marketIds pre-discovery).
      tronAddress
        ? getTronBalances(tronAddress).catch(() => {
            errors.tron = true;
            return null as TronPortfolioSlice | null;
          })
        : (Promise.resolve(null) as Promise<TronPortfolioSlice | null>),
      // TRON staking is fetched in parallel with balances (separate endpoints
      // on TronGrid — getReward + v1/accounts) and coverage-tracked
      // independently, so a staking failure doesn't mask a successful
      // balance read. Same "not attempted" semantics as the balance slot.
      tronAddress
        ? getTronStaking(tronAddress).catch(() => {
            errors.tronStaking = true;
            return null as TronStakingSlice | null;
          })
        : (Promise.resolve(null) as Promise<TronStakingSlice | null>),
      // Solana reads are only attempted when the caller passed a solanaAddress.
      // Same "not attempted" semantics as TRON: null → coverage.solana absent.
      solanaAddress
        ? getSolanaBalances(solanaAddress).catch(() => {
            errors.solana = true;
            return null as SolanaPortfolioSlice | null;
          })
        : (Promise.resolve(null) as Promise<SolanaPortfolioSlice | null>),
    ]);
  const morphoPositions = morphoByChain.flatMap((r) => r.positions);

  // Filter zero native balances out.
  const native = nativeAmounts.filter((a) => a.amount !== "0");
  const erc20 = erc20Amounts.flat();

  // Merge Aave + Compound + Morpho into a single lending bucket — they all carry
  // `chain` and `netValueUsd`, which is all the summary math needs.
  const lendingPositions: LendingPositionUnion[] = [
    ...aave.positions,
    ...compound.positions,
    ...morphoPositions,
  ];

  const tronBalancesUsd = tronSlice?.walletBalancesUsd ?? 0;
  const tronStakingUsd = tronStakingSlice?.totalStakedUsd ?? 0;
  const solanaBalancesUsd = solanaSlice?.walletBalancesUsd ?? 0;
  const walletBalancesUsd = round(
    [...native, ...erc20].reduce((sum, t) => sum + (t.valueUsd ?? 0), 0) +
      tronBalancesUsd +
      solanaBalancesUsd,
    2
  );
  const lendingNetUsd = round(
    lendingPositions.reduce((sum, p) => sum + p.netValueUsd, 0),
    2
  );
  const lpUsd = round(lp.positions.reduce((sum, p) => sum + p.totalValueUsd, 0), 2);
  const stakingUsd = round(
    staking.positions.reduce((sum, p) => sum + (p.stakedAmount.valueUsd ?? 0), 0),
    2
  );
  // totalUsd folds every accounted-for slice: EVM balances + TRON balances +
  // Solana balances are already rolled into walletBalancesUsd; TRON staking
  // is surfaced separately (Phase 2 for Solana staking). EVM-only slices
  // (lending/LP/staking) are added here.
  const totalUsd = round(
    walletBalancesUsd + lendingNetUsd + lpUsd + stakingUsd + tronStakingUsd,
    2
  );

  // Per-chain breakdown (sums everything tagged to each chain).
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;

  chains.forEach((c, i) => {
    const chainNative = nativeAmounts[i]?.valueUsd ?? 0;
    const chainErc20 = erc20Amounts[i].reduce((s, t) => s + (t.valueUsd ?? 0), 0);
    const chainLending = lendingPositions.filter((p) => p.chain === c).reduce((s, p) => s + p.netValueUsd, 0);
    const chainLp = lp.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.totalValueUsd, 0);
    const chainStaking = staking.positions.filter((p) => p.chain === c).reduce((s, p) => s + (p.stakedAmount.valueUsd ?? 0), 0);
    perChain[c] = round(chainNative + chainErc20 + chainLending + chainLp + chainStaking, 2);
  });

  const tronUnpriced = tronSlice
    ? [...tronSlice.native, ...tronSlice.trc20].filter((t) => t.priceMissing).length
    : 0;
  const solanaUnpriced = solanaSlice
    ? [...solanaSlice.native, ...solanaSlice.spl].filter((t) => t.priceMissing).length
    : 0;
  const unpricedAssets =
    [...native, ...erc20].filter((t) => t.priceMissing).length +
    tronUnpriced +
    solanaUnpriced;
  const coverage: PortfolioCoverage = {
    aave: { covered: !errors.aave, ...(errors.aave ? { errored: true, note: "Aave fetch failed — positions not included in totals." } : {}) },
    compound: {
      covered: !errors.compound,
      ...(errors.compound
        ? {
            errored: true,
            note: formatCompoundErrorNote(compoundErroredMarkets),
          }
        : {}),
    },
    morpho: { covered: !errors.morpho, ...(errors.morpho ? { errored: true, note: "Morpho Blue event-log discovery failed on at least one chain — some positions may be missing from totals." } : {}) },
    uniswapV3: { covered: !errors.lp, ...(errors.lp ? { errored: true, note: "Uniswap V3 LP fetch failed — positions not included." } : {}) },
    staking: { covered: !errors.staking, ...(errors.staking ? { errored: true, note: "Staking (Lido/EigenLayer) fetch failed — positions not included." } : {}) },
    ...(tronAddress
      ? {
          tron: errors.tron
            ? { covered: false, errored: true, note: "TRON balance fetch failed (TronGrid) — TRX/TRC-20 not included in totals." }
            : { covered: true },
          tronStaking: errors.tronStaking
            ? { covered: false, errored: true, note: "TRON staking fetch failed (TronGrid getReward/accounts) — frozen + rewards not included in totals." }
            : { covered: true },
        }
      : {}),
    ...(solanaAddress
      ? {
          solana: errors.solana
            ? { covered: false, errored: true, note: "Solana balance fetch failed — SOL/SPL not included in totals. Check SOLANA_RPC_URL or the solanaRpcUrl config." }
            : { covered: true },
        }
      : {}),
    unpricedAssets,
  };

  // Merge balance + staking into a single TRON slice for the breakdown so
  // consumers only see one `tron` block. If balances errored but staking
  // succeeded (or vice versa) we still surface whichever loaded — each is
  // independently coverage-tracked.
  const tronBreakdown: TronPortfolioSlice | undefined =
    tronSlice || tronStakingSlice
      ? {
          address: tronAddress ?? tronSlice?.address ?? tronStakingSlice?.address ?? "",
          native: tronSlice?.native ?? [],
          trc20: tronSlice?.trc20 ?? [],
          walletBalancesUsd: tronSlice?.walletBalancesUsd ?? 0,
          ...(tronStakingSlice ? { staking: tronStakingSlice } : {}),
        }
      : undefined;

  // tronUsd rolls up balances + staking so the single-number view matches the
  // sum a user sees in a block explorer. tronStakingUsd surfaces the staking
  // portion separately for UI.
  const tronUsdTotal = round(tronBalancesUsd + tronStakingUsd, 2);

  return {
    wallet,
    chains,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    totalUsd,
    perChain,
    ...(tronBreakdown ? { tronUsd: tronUsdTotal } : {}),
    ...(tronStakingSlice ? { tronStakingUsd: round(tronStakingUsd, 2) } : {}),
    ...(solanaSlice ? { solanaUsd: round(solanaBalancesUsd, 2) } : {}),
    breakdown: {
      native,
      erc20,
      lending: lendingPositions,
      lp: lp.positions,
      staking: staking.positions,
      ...(tronBreakdown ? { tron: tronBreakdown } : {}),
      ...(solanaSlice ? { solana: solanaSlice } : {}),
    },
    coverage,
  };
}
