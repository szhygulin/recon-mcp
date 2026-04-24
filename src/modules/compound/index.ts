import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
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
export type CometPausedAction =
  | "supply"
  | "transfer"
  | "withdraw"
  | "absorb"
  | "buy";

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
  /**
   * Governance-paused actions on this Comet market. Omitted when nothing is
   * paused so the JSON shape of healthy positions doesn't change. Catches
   * situations like Apr-2026 cUSDCv3 where withdraw was frozen in response to
   * the rsETH exploit — the user's funds were still there but unable to be
   * withdrawn, and there was no previous way to surface that without a failed
   * prepare_compound_withdraw.
   */
  pausedActions?: CometPausedAction[];
  /**
   * True when the pause-flags multicall could not be resolved confidently
   * (whole-call failure, or one of the five per-slot reads failed). When this
   * is set, `pausedActions` is a LOWER BOUND — callers MUST treat it as
   * "state unknown" rather than "confirmed unpaused". Issue #71 traced a
   * silent false-negative to callers treating `pausedActions: []` as
   * confirmation that nothing was paused when in reality the read had
   * failed under concurrency pressure.
   */
  pausedActionsUnknown?: boolean;
}

/**
 * Discriminated result of a Comet pause-flag read. `unknown: true` means the
 * caller CANNOT treat `pausedActions: []` as "confirmed nothing paused" —
 * either the multicall failed entirely, or at least one per-slot read came
 * back as failure. `pausedActions` is always a lower bound on what's paused
 * (slots that successfully returned `true`), never a false positive.
 */
export interface CometPauseRead {
  pausedActions: CometPausedAction[];
  unknown: boolean;
}

/**
 * Reads all five Comet pause flags in a single multicall and returns them
 * as `{ pausedActions, unknown }`.
 *
 *  - `pausedActions` is always a LOWER BOUND on what's paused — only slots
 *    that successfully returned `true` land in it. Never a false positive.
 *  - `unknown` is `true` when the caller cannot trust an empty list as
 *    "confirmed not paused": either the whole multicall threw (network
 *    flake, RPC timeout under the `get_market_incident_status` 12-way
 *    concurrency fan-out — issue #71), or at least one per-slot read
 *    returned failure.
 *
 * Split out from readMarketPosition so (a) the incident-scan and the
 * single-market info tools reuse one ABI list, (b) the decision of how to
 * treat an unknown read (flag it, propagate, throw) lives with the caller.
 * Never throws — failures are folded into `unknown: true` so the caller
 * doesn't need a try/catch around every call site.
 */
export async function readCometPausedActions(
  client: ReturnType<typeof getClient>,
  comet: `0x${string}`
): Promise<CometPauseRead> {
  const pauseSlots: [string, CometPausedAction][] = [
    ["isSupplyPaused", "supply"],
    ["isTransferPaused", "transfer"],
    ["isWithdrawPaused", "withdraw"],
    ["isAbsorbPaused", "absorb"],
    ["isBuyPaused", "buy"],
  ];
  let results;
  try {
    results = await client.multicall({
      contracts: pauseSlots.map(([fn]) => ({
        address: comet,
        abi: cometAbi,
        functionName: fn as
          | "isSupplyPaused"
          | "isTransferPaused"
          | "isWithdrawPaused"
          | "isAbsorbPaused"
          | "isBuyPaused",
      })),
      allowFailure: true,
    });
  } catch {
    // Whole-call failure — RPC dropped the request, rate-limited, or the
    // client itself errored. Treat as unknown rather than confirmed-clean.
    return { pausedActions: [], unknown: true };
  }
  const paused: CometPausedAction[] = [];
  let perSlotFailure = false;
  results.forEach((r, i) => {
    if (r.status === "success") {
      if (r.result === true) paused.push(pauseSlots[i][1]);
    } else {
      perSlotFailure = true;
    }
  });
  return { pausedActions: paused, unknown: perSlotFailure };
}

/**
 * Extract a short human-readable message from a viem multicall failure
 * entry. viem's failure shape is `{ status: "failure", error: Error, result:
 * unknown }` where `error.shortMessage` / `error.message` carry the
 * underlying cause (e.g. "HTTP request failed. Status: 429", "execution
 * reverted", "Failed to decode output data"). Truncate to keep the thrown
 * message readable at the aggregator level.
 */
const MULTICALL_ERR_MAX = 120;
function multicallErrorMessage(entry: { status: "failure"; error?: unknown }): string {
  const err = entry.error as { shortMessage?: string; message?: string } | undefined;
  const raw = err?.shortMessage ?? err?.message ?? "unknown";
  return raw.length > MULTICALL_ERR_MAX
    ? `${raw.slice(0, MULTICALL_ERR_MAX)}…`
    : raw;
}

/**
 * Cheap exposure probe for all Compound V3 markets on a chain in a single
 * multicall. Asks only `balanceOf` + `borrowBalanceOf` per market (2 calls
 * per market, all batched into one RPC). For any market where both come
 * back zero, the full position read is skipped entirely — a ~4x reduction
 * in RPC work for the common case where a wallet has no exposure on most
 * chains (issue #88 follow-up: Compound L2 markets were 429ing because
 * every market got a full read regardless of whether the wallet had ever
 * touched it).
 *
 * Trade-off: a wallet with ONLY collateral (baseSupplied == baseBorrowed ==
 * 0, nonzero collateral balance) is undetectable by base-balance probing
 * alone. This is rare — Compound V3 collateral is only useful when
 * there's an active borrow, and repaying the borrow without withdrawing
 * collateral is an unusual state. Users hitting this case can set
 * `VAULTPILOT_COMPOUND_FULL_READ=1` to bypass the probe and always do
 * full reads (the pre-#88 behavior).
 *
 * Returns `active` (markets worth reading fully) plus `errored` (markets
 * whose probe multicall entry failed — same per-call-error propagation
 * as `readMarketPosition` for consistency with the coverage note).
 */
async function probeCompoundMarkets(
  wallet: `0x${string}`,
  chain: SupportedChain,
): Promise<{
  active: { name: string; address: `0x${string}` }[];
  errored: { name: string; error: string }[];
}> {
  const cacheKey = `compound-probe:${chain}:${wallet.toLowerCase()}`;
  return cache.remember(cacheKey, CACHE_TTL.POSITION, () =>
    runCompoundProbe(wallet, chain),
  );
}

/**
 * Cross-wallet batch prefetch for Compound exposure probes. Issues ONE
 * multicall per chain containing `balanceOf` + `borrowBalanceOf` for
 * every (wallet × market) pair; results are split per-wallet and
 * stored in the probe cache. Called by the portfolio aggregator before
 * the per-wallet fan-out so each per-wallet `getCompoundPositions`
 * hits the cache instead of firing its own probe.
 *
 * Issue #88 retest at cap=2 concurrency still 429'd because N-wallets
 * × M-chains probe multicalls saturated the free-tier key even with
 * the limiter queuing them. This batch collapses `wallets × chains`
 * probe multicalls to `chains` probe multicalls (one per chain,
 * regardless of wallet count) — a 4× reduction on a 4-wallet call and
 * more for bigger sets. Whole-multicall rejection populates the cache
 * with errored entries for every wallet on that chain so the per-
 * wallet reads see the failure signal.
 */
export async function prefetchCompoundProbes(
  wallets: `0x${string}`[],
  chains: SupportedChain[],
): Promise<void> {
  if (wallets.length === 0 || chains.length === 0) return;
  await Promise.all(chains.map((chain) => prefetchChainProbes(wallets, chain)));
}

async function prefetchChainProbes(
  wallets: `0x${string}`[],
  chain: SupportedChain,
): Promise<void> {
  const markets = listMarkets(chain);
  if (markets.length === 0) return;
  const client = getClient(chain);
  const contracts = wallets.flatMap((wallet) =>
    markets.flatMap((m) => [
      { address: m.address, abi: cometAbi, functionName: "balanceOf" as const, args: [wallet] as const },
      { address: m.address, abi: cometAbi, functionName: "borrowBalanceOf" as const, args: [wallet] as const },
    ]),
  );
  try {
    const results = await client.multicall({ contracts, allowFailure: true });
    // Walk results and split per-wallet. Each wallet occupies a
    // contiguous `markets.length * 2` slice in the same order we built
    // `contracts`.
    let i = 0;
    for (const wallet of wallets) {
      const active: { name: string; address: `0x${string}` }[] = [];
      const errored: { name: string; error: string }[] = [];
      for (const market of markets) {
        const supply = results[i++];
        const borrow = results[i++];
        if (supply.status !== "success") {
          errored.push({
            name: market.name,
            error: `probe balanceOf(${multicallErrorMessage(supply)}) — RPC issue, full position read skipped`,
          });
          continue;
        }
        if (borrow.status !== "success") {
          errored.push({
            name: market.name,
            error: `probe borrowBalanceOf(${multicallErrorMessage(borrow)}) — RPC issue, full position read skipped`,
          });
          continue;
        }
        const supplied = supply.result as bigint;
        const borrowed = borrow.result as bigint;
        if (supplied > 0n || borrowed > 0n) {
          active.push({ name: market.name, address: market.address });
        }
      }
      cache.set(
        `compound-probe:${chain}:${wallet.toLowerCase()}`,
        { active, errored },
        CACHE_TTL.POSITION,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const error = `probe multicall rejected (${reason}) — no exposure signal available`;
    for (const wallet of wallets) {
      const errored = markets.map((m) => ({ name: m.name, error }));
      cache.set(
        `compound-probe:${chain}:${wallet.toLowerCase()}`,
        { active: [], errored },
        CACHE_TTL.POSITION,
      );
    }
  }
}

async function runCompoundProbe(
  wallet: `0x${string}`,
  chain: SupportedChain,
): Promise<{
  active: { name: string; address: `0x${string}` }[];
  errored: { name: string; error: string }[];
}> {
  const markets = listMarkets(chain);
  if (markets.length === 0) return { active: [], errored: [] };
  const client = getClient(chain);
  const results = await client.multicall({
    contracts: markets.flatMap((m) => [
      { address: m.address, abi: cometAbi, functionName: "balanceOf" as const, args: [wallet] as const },
      { address: m.address, abi: cometAbi, functionName: "borrowBalanceOf" as const, args: [wallet] as const },
    ]),
    allowFailure: true,
  });
  const active: { name: string; address: `0x${string}` }[] = [];
  const errored: { name: string; error: string }[] = [];
  markets.forEach((m, i) => {
    const supply = results[i * 2];
    const borrow = results[i * 2 + 1];
    if (supply.status !== "success") {
      errored.push({
        name: m.name,
        error: `probe balanceOf(${multicallErrorMessage(supply)}) — RPC issue, full position read skipped`,
      });
      return;
    }
    if (borrow.status !== "success") {
      errored.push({
        name: m.name,
        error: `probe borrowBalanceOf(${multicallErrorMessage(borrow)}) — RPC issue, full position read skipped`,
      });
      return;
    }
    const supplied = supply.result as bigint;
    const borrowed = borrow.result as bigint;
    if (supplied > 0n || borrowed > 0n) {
      active.push({ name: m.name, address: m.address });
    }
  });
  return { active, errored };
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
  const failed: { name: string; error: string }[] = [];
  // Include the per-call error message from viem's multicall result — issue
  // #88 flagged the previous "read failed on a curated-registry market"
  // string as unactionable because it didn't distinguish "contract reverted"
  // from "RPC rate-limited" from "wrong ABI shape". viem populates `error`
  // on `{ status: "failure" }` entries with the underlying cause (HTTP
  // status, revert reason, or decode error). Propagating that makes the
  // residual L2 failures diagnosable without another round-trip.
  if (results[0].status !== "success") {
    failed.push({ name: "baseToken", error: multicallErrorMessage(results[0]) });
  }
  if (results[2].status !== "success") {
    failed.push({ name: "balanceOf", error: multicallErrorMessage(results[2]) });
  }
  if (results[3].status !== "success") {
    failed.push({ name: "borrowBalanceOf", error: multicallErrorMessage(results[3]) });
  }
  if (failed.length > 0) {
    const detail = failed
      .map((f) => `${f.name}(${f.error})`)
      .join(", ");
    throw new Error(
      `Compound V3 ${chain}:${market.name} — ${detail} read failed on a curated-registry market`,
    );
  }
  const baseToken = results[0].result;
  const supplied = results[2].result;
  const borrowed = results[3].result;
  const baseAddr = baseToken as `0x${string}`;
  const n = results[1].status === "success" ? Number(results[1].result) : 0;

  // Pause-flag reads are best-effort and completely detached from the
  // position-critical reads above. `readCometPausedActions` never throws;
  // on failure it returns `{ unknown: true }` which we propagate so the
  // caller can tell "pause state unknown" (silent false negative — issue
  // #71) from "confirmed not paused".
  const pauseRead = await readCometPausedActions(client, comet);

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
    ...(pauseRead.pausedActions.length > 0 ? { pausedActions: pauseRead.pausedActions } : {}),
    ...(pauseRead.unknown ? { pausedActionsUnknown: true } : {}),
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
  const positions: CompoundPosition[] = [];
  const erroredMarkets: { chain: SupportedChain; market: string; error: string }[] = [];

  // Escape hatch: if the user has a pure-collateral position (rare — Comet
  // collateral without an active borrow), the probe-first flow would miss
  // it because the probe only checks base balance. Setting
  // VAULTPILOT_COMPOUND_FULL_READ=1 reverts to the pre-#88 behavior of
  // doing a full read against every market regardless.
  const fullReadOverride =
    process.env.VAULTPILOT_COMPOUND_FULL_READ === "1";

  let marketsToRead: { chain: SupportedChain; market: { name: string; address: `0x${string}` } }[];

  if (fullReadOverride) {
    marketsToRead = chains.flatMap((chain) =>
      listMarkets(chain).map((market) => ({ chain, market })),
    );
  } else {
    // Probe-first: one multicall per chain asks balanceOf +
    // borrowBalanceOf across every market on that chain. Markets where
    // both come back zero are skipped — no full read fired. Dramatic
    // savings for wallets with no Compound exposure on most chains
    // (~4x fewer RPC multicalls for the empty-wallet common case, and
    // peaks drop further because the burst of parallel reads is gated
    // on the probe completing first). Rate-limit pressure drops
    // proportionally; the #88 trace showed L2 Compound multicalls
    // being collateral-damaged by Morpho's now-off event-log scans,
    // and with both hotspots gone the residual 429s should vanish.
    const probeResults = await Promise.allSettled(
      chains.map((chain) =>
        probeCompoundMarkets(wallet, chain).then((r) => ({ chain, ...r })),
      ),
    );
    const active: { chain: SupportedChain; market: { name: string; address: `0x${string}` } }[] = [];
    probeResults.forEach((r, i) => {
      const chain = chains[i];
      if (r.status === "fulfilled") {
        for (const m of r.value.active) {
          active.push({ chain, market: { name: m.name, address: m.address } });
        }
        for (const e of r.value.errored) {
          erroredMarkets.push({ chain, market: e.name, error: e.error });
        }
      } else {
        // Whole probe multicall rejected for this chain (e.g. network
        // error, endpoint down). Mark every market on the chain as
        // errored — we have no signal about the wallet's exposure
        // there, so coverage must report it.
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        for (const m of listMarkets(chain)) {
          erroredMarkets.push({
            chain,
            market: m.name,
            error: `probe multicall rejected (${reason}) — no exposure signal available`,
          });
        }
      }
    });
    marketsToRead = active;
  }

  // Use allSettled so one unhealthy market read doesn't nuke the others
  // (e.g. Multicall3 returning 0x, rate-limit, …). Rejections are counted
  // and surfaced via the `errored` flag — #34 traced a flaky cUSDCv3 read
  // dropping a live six-figure supply to silent `.catch(() => null)`.
  const settled = await Promise.allSettled(
    marketsToRead.map(({ chain, market }) => readMarketPosition(wallet, chain, market)),
  );
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value !== null) positions.push(r.value);
    } else {
      erroredMarkets.push({
        chain: marketsToRead[i].chain,
        market: marketsToRead[i].market.name,
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
