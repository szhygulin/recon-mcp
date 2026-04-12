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
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: http(url, { batch: true, retryCount: 2, retryDelay: 1000 }),
  });
  clients.set(chain, client);
  return client;
}

/** Invalidate the cached clients — useful after the user re-runs setup. */
export function resetClients(): void {
  clients.clear();
}
