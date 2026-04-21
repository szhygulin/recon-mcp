import { parseUnits, formatUnits, encodeFunctionData } from "viem";
import { fetchQuote, fetchStatus } from "./lifi.js";
import { fetchOneInchQuote } from "./oneinch.js";
import type { GetSwapQuoteArgs, PrepareSwapArgs } from "./schemas.js";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { readUserConfig, resolveOneInchApiKey } from "../../config/user-config.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Sum LiFi fee/gas cost entries into a USD number.
 *
 * LiFi's `amountUSD` is unreliable on some bridge routes (notably Polygon PoS): the
 * field has been observed containing raw token units rather than a USD decimal, which
 * inflates the reported fee by ~6 orders of magnitude for stablecoins (a real 0.25 USDC
 * fee shows as ~$250,000). To sidestep this, always prefer deriving USD from the raw
 * `amount` + `token.priceUSD` + `token.decimals`. Fall back to `amountUSD` only when
 * the token price is missing, and sanity-clamp if both are available but disagree by
 * more than 10×.
 */
interface LifiCostLike {
  amount?: string;
  amountUSD?: string;
  token?: { decimals?: number; priceUSD?: string };
}

function sumLifiCostsUsd(items: readonly LifiCostLike[] | undefined): number | undefined {
  if (!items || items.length === 0) return undefined;
  let total = 0;
  for (const item of items) {
    const stated = item.amountUSD !== undefined ? Number(item.amountUSD) : NaN;
    const rawAmt = item.amount !== undefined ? Number(item.amount) : NaN;
    const priceUsd =
      item.token?.priceUSD !== undefined ? Number(item.token.priceUSD) : NaN;
    const decimals = item.token?.decimals ?? 18;

    const derived =
      Number.isFinite(rawAmt) && Number.isFinite(priceUsd)
        ? (rawAmt / 10 ** decimals) * priceUsd
        : NaN;

    if (Number.isFinite(derived)) {
      // Both available: trust derived if they disagree wildly (stated is the known-bad
      // source). 10× threshold catches the "raw-units-as-USD" class of bug.
      if (Number.isFinite(stated) && derived > 0 && stated / derived > 10) {
        total += derived;
      } else if (Number.isFinite(stated) && stated >= 0) {
        total += stated;
      } else {
        total += derived;
      }
    } else if (Number.isFinite(stated) && stated >= 0) {
      total += stated;
    }
  }
  return total;
}

/** Resolve ERC-20 decimals (native = 18). */
async function resolveDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native",
  fallback?: number
): Promise<number> {
  if (token === "native") return 18;
  if (fallback !== undefined) return fallback;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return 18;
  }
}

/**
 * On-chain decimals read with no fallback path. Returns undefined for native (no
 * contract to read) and undefined on RPC failure so callers can distinguish "known
 * to match" from "couldn't verify". Used by prepareSwap to cross-check LiFi's
 * reported token metadata before returning signable calldata.
 */
async function readOnchainDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native"
): Promise<number | undefined> {
  if (token === "native") return undefined;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return undefined;
  }
}

/**
 * Reject slippage configurations that are almost certainly user/agent error.
 * The schema already caps at 500 bps (5%); this adds a soft-cap at 100 bps
 * (1%) that requires an explicit ack. MEV sandwich bots target open-slippage
 * txs, so every unnecessary basis point is paid straight to a searcher.
 */
export function assertSlippageOk(slippageBps: number | undefined, ack: boolean | undefined): void {
  if (slippageBps === undefined) return;
  if (slippageBps > 100 && !ack) {
    throw new Error(
      `Requested slippage is ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%). ` +
        `The default cap is 100 bps (1%) because anything higher is almost always a ` +
        `sandwich-bait misconfiguration. If a thin-liquidity route genuinely needs this, ` +
        `retry with \`acknowledgeHighSlippage: true\` and confirm with the user first.`
    );
  }
}

export async function getSwapQuote(args: GetSwapQuoteArgs) {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  const chain = args.fromChain as SupportedChain;
  const toChain = args.toChain as SupportedChain;
  const amountSide = args.amountSide ?? "from";
  const isExactOut = amountSide === "to";

  const sideDecimals = isExactOut
    ? await resolveDecimals(toChain, args.toToken as `0x${string}` | "native", args.toTokenDecimals)
    : await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const amountWei = parseUnits(args.amount, sideDecimals).toString();

  // Intra-chain only: 1inch has no cross-chain aggregator. Skip silently when no
  // API key is configured so users without a 1inch portal account still get LiFi.
  // Also skip for exact-out: 1inch v6 has no toAmount/exact-out endpoint, so a
  // fromAmount comparison would be against a different quantity entirely.
  const intraChain = args.fromChain === args.toChain;
  const oneInchApiKey =
    intraChain && !isExactOut ? resolveOneInchApiKey(readUserConfig()) : undefined;

  const lifiReq = {
    fromChain: chain,
    toChain,
    fromToken: args.fromToken as `0x${string}` | "native",
    toToken: args.toToken as `0x${string}` | "native",
    fromAddress: args.wallet as `0x${string}`,
    slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    ...(isExactOut ? { toAmount: amountWei } : { fromAmount: amountWei }),
  } as Parameters<typeof fetchQuote>[0];

  const [quote, oneInchRaw] = await Promise.all([
    fetchQuote(lifiReq),
    oneInchApiKey
      ? fetchOneInchQuote({
          chain,
          fromToken: args.fromToken as `0x${string}` | "native",
          toToken: args.toToken as `0x${string}` | "native",
          fromAmount: amountWei,
          apiKey: oneInchApiKey,
        }).catch((err: unknown) => ({ __error: (err as Error).message }) as const)
      : Promise.resolve(undefined),
  ]);

  const fromTokenDecimals = quote.action.fromToken.decimals;
  const toTokenDecimals = quote.action.toToken.decimals;
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);

  const fromAmountFormatted = formatUnits(BigInt(quote.action.fromAmount), fromTokenDecimals);
  const rawToAmount = formatUnits(BigInt(quote.estimate.toAmount), toTokenDecimals);
  const rawToAmountMin = formatUnits(BigInt(quote.estimate.toAmountMin), toTokenDecimals);

  const fromAmountUsd = Number.isFinite(fromPriceUsd)
    ? Number(fromAmountFormatted) * fromPriceUsd
    : undefined;
  const statedToAmountUsd = Number.isFinite(toPriceUsd)
    ? Number(rawToAmount) * toPriceUsd
    : undefined;

  // Sanity-check the output amount. LiFi has been observed returning toAmount scaled
  // wrong for some aggregator integrations (100 USDC → supposedly 1288 WBTC). When
  // priced out, the implied output USD vastly exceeds the input USD — no rational
  // route pays >10× the input. When that happens, we re-derive the displayed amount
  // from prices and attach a warning so the caller doesn't sign a malformed tx.
  let toAmountExpected = rawToAmount;
  let toAmountMin = rawToAmountMin;
  let toAmountUsd = statedToAmountUsd;
  let warning: string | undefined;

  if (
    fromAmountUsd !== undefined &&
    statedToAmountUsd !== undefined &&
    fromAmountUsd > 0 &&
    statedToAmountUsd / fromAmountUsd > 10
  ) {
    // Derive what the output *should* be from prices.
    const impliedToAmount = fromAmountUsd / toPriceUsd;
    // Preserve the route's stated slippage ratio when re-deriving the min.
    const rawRatio =
      Number(rawToAmount) > 0 ? Number(rawToAmountMin) / Number(rawToAmount) : 1;
    toAmountExpected = impliedToAmount.toString();
    toAmountMin = (impliedToAmount * rawRatio).toString();
    toAmountUsd = fromAmountUsd;
    warning =
      `LiFi returned toAmount=${rawToAmount} ${quote.action.toToken.symbol} (~$${statedToAmountUsd.toFixed(2)}) ` +
      `which is >10× the input value ($${fromAmountUsd.toFixed(2)}). Displayed output re-derived from ` +
      `token prices. Do NOT sign a prepared tx using this quote — fetch a fresh one.`;
  }

  // Intra-chain comparison against 1inch. Quote in the same token, so a direct
  // numeric comparison of output amounts is meaningful. USD is derived from the
  // LiFi-provided toToken price (1inch doesn't return priceUSD) so both sides
  // use the same reference price and only the route differs.
  let alternatives: Array<
    | { source: "1inch"; toAmountExpected: string; toAmountUsd?: number; gasEstimate?: number }
    | { source: "1inch"; error: string }
  > | undefined;
  let bestSource: "lifi" | "1inch" | "tie" | undefined;
  let savingsVsLifi: { source: "1inch"; outputDeltaPct: number; outputDeltaUsd?: number } | undefined;

  if (intraChain && oneInchRaw) {
    if ("__error" in oneInchRaw) {
      alternatives = [{ source: "1inch", error: oneInchRaw.__error }];
    } else {
      const oiDecimals = oneInchRaw.dstToken?.decimals ?? toTokenDecimals;
      const oiFormatted = formatUnits(BigInt(oneInchRaw.dstAmount), oiDecimals);
      const oiOut = Number(oiFormatted);
      const oiUsd = Number.isFinite(toPriceUsd) ? oiOut * toPriceUsd : undefined;
      alternatives = [
        {
          source: "1inch",
          toAmountExpected: oiFormatted,
          toAmountUsd: oiUsd,
          gasEstimate: oneInchRaw.gas,
        },
      ];

      // Compare against the *raw* LiFi toAmount (not the re-derived one). If LiFi's
      // quote was flagged by the >10× sanity check, the raw number is the one the
      // aggregator actually advertised — that's what we're comparing route quality on.
      const lifiOut = Number(rawToAmount);
      if (lifiOut > 0 && oiOut > 0) {
        const delta = (oiOut - lifiOut) / lifiOut;
        if (Math.abs(delta) < 0.0005) bestSource = "tie";
        else bestSource = delta > 0 ? "1inch" : "lifi";
        savingsVsLifi = {
          source: "1inch",
          outputDeltaPct: delta * 100,
          outputDeltaUsd: Number.isFinite(toPriceUsd) ? (oiOut - lifiOut) * toPriceUsd : undefined,
        };
      }
    }
  }

  return {
    fromChain: args.fromChain,
    toChain: args.toChain,
    fromToken: quote.action.fromToken,
    toToken: quote.action.toToken,
    fromAmount: fromAmountFormatted,
    toAmountMin,
    toAmountExpected,
    fromAmountUsd,
    toAmountUsd,
    tool: quote.tool,
    executionDurationSeconds: quote.estimate.executionDuration,
    feeCostsUsd: sumLifiCostsUsd(quote.estimate.feeCosts),
    gasCostsUsd: sumLifiCostsUsd(quote.estimate.gasCosts),
    crossChain: args.fromChain !== args.toChain,
    ...(alternatives ? { alternatives } : {}),
    ...(bestSource ? { bestSource } : {}),
    ...(savingsVsLifi ? { savingsVsLifi } : {}),
    ...(warning ? { warning } : {}),
  };
}

export async function prepareSwap(args: PrepareSwapArgs): Promise<UnsignedTx> {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  const chain = args.fromChain as SupportedChain;
  const toChain = args.toChain as SupportedChain;
  const amountSide = args.amountSide ?? "from";
  const isExactOut = amountSide === "to";

  const sideDecimals = isExactOut
    ? await resolveDecimals(toChain, args.toToken as `0x${string}` | "native", args.toTokenDecimals)
    : await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const amountWei = parseUnits(args.amount, sideDecimals).toString();

  const lifiReq = {
    fromChain: chain,
    toChain,
    fromToken: args.fromToken as `0x${string}` | "native",
    toToken: args.toToken as `0x${string}` | "native",
    fromAddress: args.wallet as `0x${string}`,
    slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    ...(isExactOut ? { toAmount: amountWei } : { fromAmount: amountWei }),
  } as Parameters<typeof fetchQuote>[0];
  const quote = await fetchQuote(lifiReq);

  const txRequest = quote.transactionRequest;
  if (!txRequest || !txRequest.to || !txRequest.data) {
    throw new Error("LiFi did not return a transactionRequest for this quote.");
  }

  // Cross-check LiFi's reported token decimals against on-chain reads. A mismatch
  // would mean either LiFi has stale metadata or the route targets a token different
  // from what we asked for — in either case, the formatted expectedOut/minOut shown
  // to the user would be wrong, so refuse. Native assets are skipped (no contract).
  const fromToken = args.fromToken as `0x${string}` | "native";
  const toToken = args.toToken as `0x${string}` | "native";
  const [fromDecimalsOnchain, toDecimalsOnchain] = await Promise.all([
    readOnchainDecimals(chain, fromToken),
    readOnchainDecimals(args.toChain as SupportedChain, toToken),
  ]);
  if (
    fromDecimalsOnchain !== undefined &&
    fromDecimalsOnchain !== quote.action.fromToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for fromToken ${quote.action.fromToken.symbol} (${quote.action.fromToken.address}): ` +
        `LiFi reports ${quote.action.fromToken.decimals}, on-chain says ${fromDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }
  if (
    toDecimalsOnchain !== undefined &&
    toDecimalsOnchain !== quote.action.toToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for toToken ${quote.action.toToken.symbol} (${quote.action.toToken.address}): ` +
        `LiFi reports ${quote.action.toToken.decimals}, on-chain says ${toDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }

  // Exact-in invariant: the approval amount and the swap tx's transferFrom target
  // are both derived from `quote.action.fromAmount`, while the preview text
  // (description, decoded.args) echoes the user's `args.amount`. If LiFi returns
  // a `fromAmount` different from what we asked for, those two values drift and
  // the user signs bytes that pull more (or less) than the MCP preview shows.
  // The existing `toUsd / fromUsd > 10` gate is asymmetric and does not catch
  // proportional inflation. Refuse on any drift — we literally passed
  // `fromAmount` in, any different value in the response is hostile or buggy.
  if (!isExactOut) {
    const quotedFromWei = BigInt(quote.action.fromAmount);
    if (quotedFromWei !== BigInt(amountWei)) {
      throw new Error(
        `LiFi returned fromAmount=${quotedFromWei} for an exact-in quote of ${amountWei} ` +
          `(${args.amount} ${quote.action.fromToken.symbol}). The approval and swap bytes ` +
          `would pull a different amount than the MCP preview displays — refusing to return ` +
          `calldata. Re-run get_swap_quote.`
      );
    }
  }

  // Sanity-check the quote before returning signable calldata. LiFi has been observed
  // returning toAmount scaled wrong on certain aggregator integrations (e.g. 10 USDC →
  // ~4500 ETH). The calldata embeds the bogus minOut and won't execute, but we refuse
  // up front so the user doesn't waste a signature on a broken quote. Mirrors the
  // warning path in getSwapQuote.
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);
  const fromAmountFormatted = Number(
    formatUnits(BigInt(quote.action.fromAmount), quote.action.fromToken.decimals)
  );
  const toAmountFormatted = Number(
    formatUnits(BigInt(quote.estimate.toAmount), quote.action.toToken.decimals)
  );
  if (
    Number.isFinite(fromPriceUsd) &&
    Number.isFinite(toPriceUsd) &&
    fromPriceUsd > 0 &&
    toPriceUsd > 0
  ) {
    const fromUsd = fromAmountFormatted * fromPriceUsd;
    const toUsd = toAmountFormatted * toPriceUsd;
    if (fromUsd > 0 && toUsd / fromUsd > 10) {
      throw new Error(
        `LiFi returned a malformed quote: toAmount=${toAmountFormatted} ${quote.action.toToken.symbol} ` +
          `(~$${toUsd.toFixed(2)}) for input ~$${fromUsd.toFixed(2)} (route: ${quote.tool}). ` +
          `Output is >10× the input value, so the calldata is not safe to sign. ` +
          `Re-run get_swap_quote to fetch a fresh route.`
      );
    }
  }

  const fromSym = quote.action.fromToken.symbol;
  const toSym = quote.action.toToken.symbol;
  const crossChain = args.fromChain !== args.toChain;
  const quotedFromAmount = formatUnits(
    BigInt(quote.action.fromAmount),
    quote.action.fromToken.decimals
  );
  const quotedToAmount = formatUnits(
    BigInt(quote.estimate.toAmount),
    quote.action.toToken.decimals
  );
  const fromDisplay = isExactOut ? `~${quotedFromAmount}` : args.amount;
  const toDisplay = isExactOut ? args.amount : `~${quotedToAmount}`;
  const description = crossChain
    ? `Bridge ${fromDisplay} ${fromSym} from ${args.fromChain} to ${toDisplay} ${toSym} on ${args.toChain} via ${quote.tool}`
    : `Swap ${fromDisplay} ${fromSym} → ${toDisplay} ${toSym} on ${args.fromChain} via ${quote.tool}`;

  const swapTx: UnsignedTx = {
    chain,
    to: txRequest.to as `0x${string}`,
    data: txRequest.data as `0x${string}`,
    value: txRequest.value ? BigInt(txRequest.value).toString() : "0",
    from: args.wallet as `0x${string}`,
    description,
    decoded: {
      functionName: "lifi",
      args: {
        tool: quote.tool,
        from: `${fromDisplay} ${fromSym}`,
        expectedOut: `${quotedToAmount} ${toSym}`,
        minOut: `${formatUnits(BigInt(quote.estimate.toAmountMin), quote.action.toToken.decimals)} ${toSym}`,
      },
    },
    gasEstimate: txRequest.gasLimit ? BigInt(txRequest.gasLimit).toString() : undefined,
  };

  // ERC-20 inputs require an allowance on `approvalAddress` (LiFi Diamond for most
  // routes, but some tools use a different executor). Without this, the swap reverts
  // on the Diamond's transferFrom — Ledger Live shows "Continue" disabled with $0
  // estimated cost because eth_estimateGas fails. Native inputs skip this step.
  if (fromToken !== "native") {
    const approvalAddress = (quote.estimate.approvalAddress ??
      (txRequest.to as `0x${string}`)) as `0x${string}`;
    const client = getClient(chain);
    const allowance = (await client.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.wallet as `0x${string}`, approvalAddress],
    })) as bigint;

    // Approval sizing:
    //  - exact-in: `quote.action.fromAmount` is exactly what the router will pull.
    //  - exact-out: the router may need up to ~fromAmount*(1+slippage) if the pool
    //    state drifts between quote and execution (inverse of toAmountMin protection
    //    on the exact-in side). LiFi does not expose a fromAmountMax field, so we
    //    derive the cap from the same slippageBps that was passed into the quote.
    //    Under-approving here means the swap reverts on transferFrom for any pool
    //    move against the user, even by 1 wei.
    const slippageBpsEffective = args.slippageBps ?? 50; // LiFi default is 0.5% (50 bps)
    const quotedFromWei = BigInt(quote.action.fromAmount);
    const amountWeiBig = isExactOut
      ? (quotedFromWei * BigInt(10_000 + slippageBpsEffective) + 9_999n) / 10_000n
      : quotedFromWei;
    const approvalDisplay = isExactOut
      ? `≤${formatUnits(amountWeiBig, quote.action.fromToken.decimals)}`
      : fromDisplay;
    const approvalQualifier = isExactOut
      ? `(covers up to ${slippageBpsEffective / 100}% input drift)`
      : "(exact amount)";
    if (allowance < amountWeiBig) {
      const approveTx: UnsignedTx = {
        chain,
        to: fromToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [approvalAddress, amountWeiBig],
        }),
        value: "0",
        from: args.wallet as `0x${string}`,
        description: `Approve ${approvalDisplay} ${fromSym} for ${quote.tool} via LiFi ${approvalQualifier}`,
        decoded: {
          functionName: "approve",
          args: { spender: approvalAddress, amount: `${approvalDisplay} ${fromSym}` },
        },
        next: swapTx,
      };
      if (allowance > 0n) {
        // USDT-style reset: tokens like USDT revert on approve(nonzero→nonzero).
        // Chain approve(0) → approve(amount) → swap so we don't silently fail on
        // the first tx of the triple.
        const resetTx: UnsignedTx = {
          chain,
          to: fromToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [approvalAddress, 0n],
          }),
          value: "0",
          from: args.wallet as `0x${string}`,
          description: `Reset ${fromSym} allowance to 0 (required by USDT-style tokens before re-approval)`,
          decoded: {
            functionName: "approve",
            args: { spender: approvalAddress, amount: "0" },
          },
          next: approveTx,
        };
        return resetTx;
      }
      return approveTx;
    }
  }

  return swapTx;
}

export async function getSwapStatus(args: { txHash: string; fromChain: SupportedChain; toChain: SupportedChain }) {
  return fetchStatus(args.txHash, args.fromChain, args.toChain);
}
