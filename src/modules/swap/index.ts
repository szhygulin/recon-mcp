import { parseUnits, formatUnits } from "viem";
import { fetchQuote, fetchStatus } from "./lifi.js";
import type { GetSwapQuoteArgs, PrepareSwapArgs } from "./schemas.js";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

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

  return {
    fromChain: args.fromChain,
    toChain: args.toChain,
    fromToken: quote.action.fromToken,
    toToken: quote.action.toToken,
    fromAmount: formatUnits(BigInt(quote.action.fromAmount), quote.action.fromToken.decimals),
    toAmountMin: formatUnits(BigInt(quote.estimate.toAmountMin), quote.action.toToken.decimals),
    toAmountExpected: formatUnits(BigInt(quote.estimate.toAmount), quote.action.toToken.decimals),
    tool: quote.tool,
    executionDurationSeconds: quote.estimate.executionDuration,
    feeCostsUsd: quote.estimate.feeCosts?.reduce((s, f) => s + Number(f.amountUSD ?? 0), 0),
    gasCostsUsd: quote.estimate.gasCosts?.reduce((s, g) => s + Number(g.amountUSD ?? 0), 0),
    crossChain: args.fromChain !== args.toChain,
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
