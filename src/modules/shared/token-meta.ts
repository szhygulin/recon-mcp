import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { sanitizeContractName } from "../../data/apis/etherscan.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Read an ERC-20's `decimals` and `symbol` in one multicall. Used by every
 * `prepare_*` handler that needs to convert a human amount → wei and stamp a
 * human-readable description. Kept in one place so the caching and error
 * semantics stay aligned across protocols.
 *
 * **Symbol is sanitized.** The token contract's owner controls what `symbol()`
 * returns — a malicious ERC-20 can return newlines + markdown + prompt-
 * injection prose. That string flows into UnsignedTx.description and into the
 * VERIFY-BEFORE-SIGNING block the agent renders for the user, so unsanitized
 * input is a narrow-injection surface. `sanitizeContractName` applies the
 * same strict allowlist we use for Etherscan-returned contract names
 * (alphanumeric + `._-`, capped at 64 chars). Rendering falls back to
 * `UNKNOWN` when nothing survives, which is both safe and actionable for the
 * user.
 */
export async function resolveTokenMeta(
  chain: SupportedChain,
  asset: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, rawSymbol] = await client.multicall({
    contracts: [
      { address: asset, abi: erc20Abi, functionName: "decimals" },
      { address: asset, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  const symbol = sanitizeContractName(rawSymbol as string) ?? "UNKNOWN";
  return { decimals: Number(decimals), symbol };
}
