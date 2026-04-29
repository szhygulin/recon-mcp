import { CONTRACTS } from "../config/contracts.js";
import type { SupportedChain } from "../types/index.js";

/**
 * Resolve a friendly label for a spender address from the canonical
 * `CONTRACTS` table on the given chain. Returns undefined for arbitrary
 * (non-protocol) spender addresses. Shared by `prepare_revoke_approval`,
 * `prepare_token_approve`, and the `prepare_custom_call` approve-redirect
 * gate so labeling stays consistent across the read + revoke + grant
 * surfaces.
 */
export function lookupKnownSpender(
  chain: SupportedChain,
  spender: `0x${string}`,
): string | undefined {
  const c = CONTRACTS[chain] as Record<string, Record<string, string>> | undefined;
  if (!c) return undefined;
  const target = spender.toLowerCase();
  for (const [protocol, addrs] of Object.entries(c)) {
    if (protocol === "tokens") continue;
    if (typeof addrs !== "object" || addrs === null) continue;
    for (const [name, addr] of Object.entries(addrs)) {
      if (typeof addr !== "string" || addr.toLowerCase() !== target) continue;
      const protoLabel = (() => {
        switch (protocol) {
          case "aave":
            return "Aave V3";
          case "uniswap":
            return "Uniswap V3";
          case "lido":
            return "Lido";
          case "eigenlayer":
            return "EigenLayer";
          case "compound":
            return "Compound V3";
          case "morpho":
            return "Morpho Blue";
          default:
            return protocol.charAt(0).toUpperCase() + protocol.slice(1);
        }
      })();
      const niceName = name.charAt(0).toUpperCase() + name.slice(1);
      return `${protoLabel} ${niceName}`;
    }
  }
  return undefined;
}
