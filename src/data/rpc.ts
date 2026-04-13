import { createPublicClient, http, type PublicClient } from "viem";
import { resolveRpcUrl, VIEM_CHAINS } from "../config/chains.js";
import { readUserConfig } from "../config/user-config.js";
import type { SupportedChain } from "../types/index.js";

const clients = new Map<SupportedChain, PublicClient>();

/**
 * Get (or lazily create) a viem PublicClient for the given chain.
 * Throws RpcConfigError if the chain has no RPC configured.
 */
export function getClient(chain: SupportedChain): PublicClient {
  const cached = clients.get(chain);
  if (cached) return cached;

  const userConfig = readUserConfig();
  const url = resolveRpcUrl(chain, userConfig);
  // Do NOT set `batch: true` by default. JSON-RPC batching works on Infura/Alchemy but is
  // silently mis-handled by many public endpoints — we saw calls like getUserAccountData,
  // NPM.balanceOf, Multicall3.aggregate3 return 0x under load, purely because they were
  // coalesced into a batched POST the provider couldn't fulfill. Individual eth_call
  // requests are slower but never ghost-fail. Users on premium endpoints can opt back in
  // via RPC_BATCH=1. Multicall3 still batches at the contract layer regardless.
  const batchEnabled = process.env.RPC_BATCH === "1";
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: http(url, {
      batch: batchEnabled,
      retryCount: 3,
      retryDelay: 500,
    }),
  });
  clients.set(chain, client);
  return client;
}

/** Invalidate the cached clients — useful after the user re-runs setup. */
export function resetClients(): void {
  clients.clear();
}
