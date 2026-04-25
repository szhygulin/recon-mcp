import { createConfig, getQuote, getStatus, ChainId as LifiChainId } from "@lifi/sdk";
import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";

let initialized = false;

/** Initialize the LiFi SDK once. Safe to call repeatedly. */
export function initLifi(): void {
  if (initialized) return;
  createConfig({
    integrator: "vaultpilot-mcp",
    // We don't execute routes through LiFi — we just fetch tx data and hand it to WalletConnect.
  });
  initialized = true;
}

/**
 * LiFi numeric chain ID for Solana. Authoritative value from
 * `@lifi/types/chains/base.ChainId.SOL` (= 1151111081099710 — derived from
 * the bytes "sol" interpreted as ASCII codes appended to a marker prefix).
 * Hoisted to a constant here so callers passing through the EVM-only
 * `toLifiChain` helper aren't forced to reach into the SDK.
 */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710 as const;

/**
 * LiFi numeric chain ID for TRON. Same value as TRON's standard chain ID
 * (728126428), since TRON uses an EVM-compatible chain ID — but LiFi's
 * routing graph still labels it as a TVM chain (chainType: "TVM"). Probe:
 * GET https://li.quest/v1/chains?chainTypes=TVM returns id=728126428.
 */
export const LIFI_TRON_CHAIN_ID = 728126428 as const;

/** Map our chain name to LiFi's numeric chain ID. */
function toLifiChain(chain: SupportedChain): number {
  return CHAIN_IDS[chain];
}

interface LifiQuoteRequestBase {
  fromChain: SupportedChain;
  /**
   * Destination chain. EVM `SupportedChain` (intra-EVM + EVM-cross), or
   * `"solana"` / `"tron"` (cross-chain bridge to a non-EVM chain). LiFi's
   * API itself accepts any numeric chain ID; we constrain to chains we've
   * validated end-to-end in this server.
   */
  toChain: SupportedChain | "solana" | "tron";
  /** Use "native" or "0x0000000000000000000000000000000000000000" for native token. */
  fromToken: `0x${string}` | "native";
  /**
   * Destination token. EVM hex when `toChain` is EVM; SPL mint (base58)
   * when `toChain === "solana"`; TRC-20 contract address (T-prefixed
   * base58) when `toChain === "tron"`. `"native"` resolves to the chain's
   * native sentinel (`0x0…0` for EVM, wSOL mint for Solana, TRX
   * contract address for TRON — handled inside `fetchQuote`).
   */
  toToken: string | "native";
  fromAddress: `0x${string}`;
  /**
   * Destination wallet. Defaults to `fromAddress` for intra-EVM swaps
   * (LiFi behavior). REQUIRED when `toChain` is `"solana"` or `"tron"`
   * because the source EVM hex wallet isn't a valid recipient on those
   * chains.
   */
  toAddress?: string;
  /** Optional slippage override — LiFi default is 0.5% (0.005). */
  slippage?: number;
}

export type LifiQuoteRequest =
  | (LifiQuoteRequestBase & {
      /** Raw integer amount as string (e.g. "1000000" for 1 USDC). */
      fromAmount: string;
      toAmount?: undefined;
    })
  | (LifiQuoteRequestBase & {
      /** Raw integer output amount as string — exact-out quote. */
      toAmount: string;
      fromAmount?: undefined;
    });

const NATIVE = "0x0000000000000000000000000000000000000000";

// LiFi's canonical native-token handles per non-EVM chain. Source: the
// `nativeToken.address` field in `https://li.quest/v1/chains` for each chain.
const SOLANA_WSOL_NATIVE = "So11111111111111111111111111111111111111112";
const TRON_NATIVE = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

export async function fetchQuote(req: LifiQuoteRequest) {
  initLifi();
  const fromChain = toLifiChain(req.fromChain);
  const toIsSolana = req.toChain === "solana";
  const toIsTron = req.toChain === "tron";
  const toChain = toIsSolana
    ? LIFI_SOLANA_CHAIN_ID
    : toIsTron
      ? LIFI_TRON_CHAIN_ID
      : toLifiChain(req.toChain as SupportedChain);
  const fromToken = req.fromToken === "native" ? NATIVE : req.fromToken;
  // Destination native sentinel depends on the chain family — wSOL for
  // Solana, TRX contract for TRON, 0x0…0 for EVM. LiFi's routing graph
  // treats each of these as the canonical native handle for that chain.
  const toToken =
    req.toToken === "native"
      ? toIsSolana
        ? SOLANA_WSOL_NATIVE
        : toIsTron
          ? TRON_NATIVE
          : NATIVE
      : req.toToken;

  if (req.toAmount !== undefined) {
    return getQuote({
      fromChain: fromChain as LifiChainId,
      toChain: toChain as LifiChainId,
      fromToken,
      toToken,
      toAmount: req.toAmount,
      fromAddress: req.fromAddress,
      ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
      slippage: req.slippage,
    });
  }
  return getQuote({
    fromChain: fromChain as LifiChainId,
    toChain: toChain as LifiChainId,
    fromToken,
    toToken,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
    slippage: req.slippage,
  });
}

export async function fetchStatus(txHash: string, fromChain: SupportedChain, toChain: SupportedChain) {
  initLifi();
  return getStatus({
    txHash,
    fromChain: toLifiChain(fromChain) as LifiChainId,
    toChain: toLifiChain(toChain) as LifiChainId,
  });
}

/**
 * Solana-source LiFi quote. Distinct shape from `LifiQuoteRequest` because
 * Solana addresses are base58 (not 0x-prefixed hex) and the destination can
 * be EVM (cross-chain bridge) or Solana (in-chain swap; LiFi will internally
 * route through Jupiter / similar). Output is a LiFi `Quote` whose
 * `transactionRequest.data` field carries the base64-encoded
 * `VersionedTransaction` for the source chain (= Solana) — see
 * `@lifi/sdk/src/_esm/core/Solana/SolanaStepExecutor.js`.
 *
 * `fromToken` accepts either:
 *   - a base58 SPL mint (e.g. USDC mint EPjFW...Dt1v)
 *   - the literal string "native" — interpreted as wrapped-SOL
 *     (So11111111111111111111111111111111111111112), the canonical token
 *     for SOL value transfer in LiFi's API
 *
 * `toToken` accepts:
 *   - base58 SPL mint (when toChain is "solana")
 *   - 0x-prefixed EVM token address (when toChain is an EVM chain)
 *   - "native" for native-asset on either chain (mapped to the chain's
 *     conventional native sentinel by LiFi)
 */
export interface LifiSolanaQuoteRequest {
  /** Solana base58 wallet — funds the swap, signs the source tx. */
  fromAddress: string;
  /** Source token: SPL mint (base58) or "native" for SOL. */
  fromToken: string | "native";
  /** Raw integer base units to sell (e.g. "1000000000" for 1 SOL @ 9 decimals). */
  fromAmount: string;
  /** Destination chain — either "solana" (in-chain swap) or an EVM chain (bridge). */
  toChain: SupportedChain | "solana";
  /** Destination token; format depends on toChain (see jsdoc on the type). */
  toToken: string | "native";
  /** Optional explicit destination wallet (defaults to fromAddress for same-chain). */
  toAddress?: string;
  /** Slippage as a fraction — e.g. 0.005 = 50 bps. LiFi default is 0.005. */
  slippage?: number;
}

const SOLANA_NATIVE_SENTINEL = "11111111111111111111111111111111";
const SOLANA_WSOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE_SENTINEL = NATIVE; // 0x0…0

/**
 * Fetch a LiFi quote with Solana as the source chain. Wraps the SDK's
 * `getQuote` (which is chain-agnostic — it accepts numeric chain IDs and
 * `string`-typed addresses + tokens, so this isn't a separate API endpoint).
 *
 * Native-token coercion:
 *   - Source: "native" → wrapped-SOL mint (LiFi treats wSOL as the canonical
 *     SOL handle in its routing graph; the Solana step builds in the wrap
 *     ix when needed).
 *   - Destination: "native" → 0x0…0 if EVM destination, else wrapped-SOL.
 */
export async function fetchSolanaQuote(req: LifiSolanaQuoteRequest) {
  initLifi();
  const fromTokenResolved =
    req.fromToken === "native" ? SOLANA_WSOL_MINT : req.fromToken;
  const toIsSolana = req.toChain === "solana";
  let toTokenResolved: string;
  if (req.toToken === "native") {
    toTokenResolved = toIsSolana ? SOLANA_WSOL_MINT : EVM_NATIVE_SENTINEL;
  } else {
    toTokenResolved = req.toToken;
  }
  const toChainId = toIsSolana
    ? LIFI_SOLANA_CHAIN_ID
    : CHAIN_IDS[req.toChain as SupportedChain];

  return getQuote({
    fromChain: LIFI_SOLANA_CHAIN_ID as LifiChainId,
    toChain: toChainId as LifiChainId,
    fromToken: fromTokenResolved,
    toToken: toTokenResolved,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
    ...(req.slippage !== undefined ? { slippage: req.slippage } : {}),
  });
}

// Re-export so the Solana wrapper module can use the wSOL constant without
// re-defining it (single source of truth).
export { SOLANA_WSOL_MINT, SOLANA_NATIVE_SENTINEL };
