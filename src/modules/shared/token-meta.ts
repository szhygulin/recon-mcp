import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Read an ERC-20's `decimals` and `symbol` in one multicall. Used by every
 * `prepare_*` handler that needs to convert a human amount → wei and stamp a
 * human-readable description. Kept in one place so the caching and error
 * semantics stay aligned across protocols.
 */
export async function resolveTokenMeta(
  chain: SupportedChain,
  asset: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, symbol] = await client.multicall({
    contracts: [
      { address: asset, abi: erc20Abi, functionName: "decimals" },
      { address: asset, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  return { decimals: Number(decimals), symbol: symbol as string };
}
