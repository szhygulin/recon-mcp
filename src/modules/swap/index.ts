import { parseUnits, formatUnits } from "viem";
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

export async function getSwapQuote(args: GetSwapQuoteArgs) {
  const chain = args.fromChain as SupportedChain;
  const toChain = args.toChain as SupportedChain;
  const fromDecimals = await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const fromAmountWei = parseUnits(args.amount, fromDecimals).toString();

  // Intra-chain only: 1inch has no cross-chain aggregator. Skip silently when no
  // API key is configured so users without a 1inch portal account still get LiFi.
  const intraChain = args.fromChain === args.toChain;
  const oneInchApiKey = intraChain ? resolveOneInchApiKey(readUserConfig()) : undefined;

  const [quote, oneInchRaw] = await Promise.all([
    fetchQuote({
      fromChain: chain,
      toChain,
      fromToken: args.fromToken as `0x${string}` | "native",
      toToken: args.toToken as `0x${string}` | "native",
      fromAmount: fromAmountWei,
      fromAddress: args.wallet as `0x${string}`,
      slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    }),
    oneInchApiKey
      ? fetchOneInchQuote({
          chain,
          fromToken: args.fromToken as `0x${string}` | "native",
          toToken: args.toToken as `0x${string}` | "native",
          fromAmount: fromAmountWei,
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
  const chain = args.fromChain as SupportedChain;
  const fromDecimals = await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const fromAmountWei = parseUnits(args.amount, fromDecimals).toString();

  const quote = await fetchQuote({
    fromChain: chain,
    toChain: args.toChain as SupportedChain,
    fromToken: args.fromToken as `0x${string}` | "native",
    toToken: args.toToken as `0x${string}` | "native",
    fromAmount: fromAmountWei,
    fromAddress: args.wallet as `0x${string}`,
    slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
  });

  const txRequest = quote.transactionRequest;
  if (!txRequest || !txRequest.to || !txRequest.data) {
    throw new Error("LiFi did not return a transactionRequest for this quote.");
  }

  const fromSym = quote.action.fromToken.symbol;
  const toSym = quote.action.toToken.symbol;
  const crossChain = args.fromChain !== args.toChain;
  const description = crossChain
    ? `Bridge ${args.amount} ${fromSym} from ${args.fromChain} to ${toSym} on ${args.toChain} via ${quote.tool}`
    : `Swap ${args.amount} ${fromSym} → ${toSym} on ${args.fromChain} via ${quote.tool}`;

  return {
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
        from: `${args.amount} ${fromSym}`,
        expectedOut: `${formatUnits(BigInt(quote.estimate.toAmount), quote.action.toToken.decimals)} ${toSym}`,
        minOut: `${formatUnits(BigInt(quote.estimate.toAmountMin), quote.action.toToken.decimals)} ${toSym}`,
      },
    },
    gasEstimate: txRequest.gasLimit ? BigInt(txRequest.gasLimit).toString() : undefined,
  };
}

export async function getSwapStatus(args: { txHash: string; fromChain: SupportedChain; toChain: SupportedChain }) {
  return fetchStatus(args.txHash, args.fromChain, args.toChain);
}
