import { createConfig, getQuote, getStatus, ChainId as LifiChainId } from "@lifi/sdk";
import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";

let initialized = false;

/** Initialize the LiFi SDK once. Safe to call repeatedly. */
export function initLifi(): void {
  if (initialized) return;
  createConfig({
    integrator: "recon-crypto-mcp",
    // We don't execute routes through LiFi — we just fetch tx data and hand it to WalletConnect.
  });
  initialized = true;
}

/** Map our chain name to LiFi's numeric chain ID. */
function toLifiChain(chain: SupportedChain): number {
  return CHAIN_IDS[chain];
}

export interface LifiQuoteRequest {
  fromChain: SupportedChain;
  toChain: SupportedChain;
  /** Use "native" or "0x0000000000000000000000000000000000000000" for native token. */
  fromToken: `0x${string}` | "native";
  toToken: `0x${string}` | "native";
  /** Raw integer amount as string (e.g. "1000000" for 1 USDC). */
  fromAmount: string;
  fromAddress: `0x${string}`;
  /** Optional slippage override — LiFi default is 0.5% (0.005). */
  slippage?: number;
}

const NATIVE = "0x0000000000000000000000000000000000000000";

export async function fetchQuote(req: LifiQuoteRequest) {
  initLifi();
  const fromChain = toLifiChain(req.fromChain);
  const toChain = toLifiChain(req.toChain);
  const fromToken = req.fromToken === "native" ? NATIVE : req.fromToken;
  const toToken = req.toToken === "native" ? NATIVE : req.toToken;

  const quote = await getQuote({
    fromChain: fromChain as LifiChainId,
    toChain: toChain as LifiChainId,
    fromToken,
    toToken,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    slippage: req.slippage,
  });
  return quote;
}

export async function fetchStatus(txHash: string, fromChain: SupportedChain, toChain: SupportedChain) {
  initLifi();
  return getStatus({
    txHash,
    fromChain: toLifiChain(fromChain) as LifiChainId,
    toChain: toLifiChain(toChain) as LifiChainId,
  });
}
