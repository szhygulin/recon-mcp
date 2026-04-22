import { isEvmChain } from "../../types/index.js";
import type { AnyChain, SupportedChain } from "../../types/index.js";
import { fetchEvmHistory } from "./evm.js";
import { fetchTronHistory } from "./tron.js";
import { resolveSelectors } from "./decode.js";
import {
  lookupHistoricalPrices,
  nativeCoinKey,
  tokenCoinKey,
  getPrice,
  type PriceRequest,
} from "./prices.js";
import type {
  GetTransactionHistoryArgs,
  HistoryItem,
  HistoryResponse,
} from "./schemas.js";

/**
 * Entry point for `get_transaction_history`. Dispatches to the EVM or TRON
 * fetch layer, merges all item types, sorts desc by timestamp, truncates to
 * `limit`, then fans out a single batched historical-price lookup and a
 * 4byte selector resolution.
 */
export async function getTransactionHistory(
  args: GetTransactionHistoryArgs
): Promise<HistoryResponse> {
  const {
    wallet,
    limit,
    includeExternal,
    includeTokenTransfers,
    includeInternal,
  } = args;
  // `chain` is typed as string after Zod.enum(readonly string[]) narrowing;
  // cast to AnyChain since the schema only admits ALL_CHAINS values.
  const chain = args.chain as AnyChain;

  // Defensively clamp timestamps.
  const nowSec = Math.floor(Date.now() / 1000);
  const endTs =
    args.endTimestamp !== undefined ? Math.min(args.endTimestamp, nowSec) : undefined;
  const startTs =
    args.startTimestamp !== undefined
      ? Math.min(args.startTimestamp, endTs ?? nowSec)
      : undefined;

  // Shape-match wallet against chain (walletSchema accepts both formats —
  // the runtime check lives here, same pattern as get_token_balance).
  const isTronWallet = wallet.startsWith("T");
  const isTronChain = chain === "tron";
  if (isTronWallet && !isTronChain) {
    throw new Error(
      `Wallet ${wallet} is a TRON address but chain is "${chain}". Pass chain: "tron".`
    );
  }
  if (!isTronWallet && isTronChain) {
    throw new Error(
      `Wallet ${wallet} is an EVM address but chain is "tron". Pass a TRON base58 address.`
    );
  }

  let items: HistoryItem[];
  let truncated: boolean;
  const errors: Array<{ source: string; message: string }> = [];

  if (isEvmChain(chain)) {
    const evmChain = chain as SupportedChain;
    const res = await fetchEvmHistory({
      wallet: wallet as `0x${string}`,
      chain: evmChain,
      includeExternal,
      includeTokenTransfers,
      includeInternal,
    });
    items = [...res.external, ...res.tokenTransfers, ...res.internal];
    truncated = res.truncated;
    errors.push(...res.errors);
  } else {
    // TRON. `includeInternal` is silently ignored (no first-class internal txs).
    const res = await fetchTronHistory({
      wallet,
      includeExternal,
      includeTokenTransfers,
    });
    items = [...res.external, ...res.tokenTransfers];
    truncated = res.truncated;
    errors.push(...res.errors);
  }

  // Timestamp filter.
  if (startTs !== undefined) items = items.filter((i) => i.timestamp >= startTs);
  if (endTs !== undefined) items = items.filter((i) => i.timestamp <= endTs);

  // Sort desc by timestamp, stable on hash.
  items.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.hash.localeCompare(b.hash);
  });

  // Truncate to limit.
  if (items.length > limit) {
    items = items.slice(0, limit);
    truncated = true;
  }

  // Batch-resolve method selectors for external items with non-empty input.
  const selectors = items
    .filter((i): i is Extract<HistoryItem, { type: "external" }> => i.type === "external")
    .map((i) => i.methodSelector)
    .filter((s): s is string => typeof s === "string");
  if (selectors.length > 0) {
    const resolved = await resolveSelectors(selectors);
    for (const item of items) {
      if (item.type === "external" && item.methodSelector) {
        const r = resolved.get(item.methodSelector);
        if (r?.methodName) item.methodName = r.methodName;
      }
    }
  }

  // Build price requests.
  const priceRequests: PriceRequest[] = [];
  for (const item of items) {
    if (item.type === "external" || item.type === "internal") {
      if (item.valueNative !== "0") {
        priceRequests.push({ coinKey: nativeCoinKey(chain), timestamp: item.timestamp });
      }
    } else {
      priceRequests.push({
        coinKey: tokenCoinKey(chain, item.tokenAddress),
        timestamp: item.timestamp,
      });
    }
  }

  let priceCoverage: "full" | "partial" | "none" = "full";
  if (priceRequests.length > 0) {
    const { prices, missed } = await lookupHistoricalPrices(priceRequests);
    let priced = 0;
    for (const item of items) {
      if (item.type === "external" || item.type === "internal") {
        if (item.valueNative === "0") continue;
        const p = getPrice(prices, nativeCoinKey(chain), item.timestamp);
        if (p !== undefined) {
          const nativeAmt = Number(item.valueNativeFormatted);
          if (Number.isFinite(nativeAmt)) {
            item.valueUsd = round2(nativeAmt * p);
            priced += 1;
          }
        }
      } else {
        const p = getPrice(prices, tokenCoinKey(chain, item.tokenAddress), item.timestamp);
        if (p !== undefined) {
          const tokenAmt = Number(item.amountFormatted);
          if (Number.isFinite(tokenAmt)) {
            item.valueUsd = round2(tokenAmt * p);
            priced += 1;
          }
        }
      }
    }
    if (priced === 0) priceCoverage = "none";
    else if (missed || priced < priceRequests.length) priceCoverage = "partial";
    else priceCoverage = "full";
  } else {
    priceCoverage = "none";
  }

  const response: HistoryResponse = {
    chain,
    wallet,
    items,
    truncated,
    priceCoverage,
    ...(errors.length > 0 ? { errors } : {}),
  };
  return response;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
