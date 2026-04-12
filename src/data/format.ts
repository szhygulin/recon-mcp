import { formatUnits, getAddress } from "viem";
import type { TokenAmount, SupportedChain } from "../types/index.js";
import { getTokenPrices } from "./prices.js";

/** Round a number to N decimal places without trailing zeros. */
export function round(n: number, places = 6): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function makeTokenAmount(
  chain: SupportedChain,
  address: `0x${string}`,
  amountWei: bigint,
  decimals: number,
  symbol: string,
  priceUsd?: number
): TokenAmount {
  const formatted = formatUnits(amountWei, decimals);
  const numeric = Number(formatted);
  const valueUsd = priceUsd !== undefined ? round(numeric * priceUsd, 2) : undefined;
  return {
    token: getAddress(address) as `0x${string}`,
    symbol,
    decimals,
    amount: amountWei.toString(),
    formatted,
    priceUsd,
    valueUsd,
  };
}

/** Price up a list of token amounts in one batched call. Mutates in place. */
export async function priceTokenAmounts(
  chain: SupportedChain,
  amounts: TokenAmount[]
): Promise<void> {
  if (amounts.length === 0) return;
  const queries = amounts.map((a) => ({ chain, address: a.token }));
  const prices = await getTokenPrices(queries);
  for (const a of amounts) {
    const key = `${chain}:${a.token.toLowerCase()}`;
    const p = prices.get(key);
    if (p !== undefined) {
      a.priceUsd = p;
      a.valueUsd = round(Number(a.formatted) * p, 2);
    }
  }
}
