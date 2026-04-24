import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { resolveRpcUrl, VIEM_CHAINS } from "../config/chains.js";
import { readUserConfig, onRpcConfigChange } from "../config/user-config.js";
import { CHAIN_IDS, type SupportedChain } from "../types/index.js";

const clients = new Map<SupportedChain, PublicClient>();
const verifiedChains = new Set<SupportedChain>();

/**
 * Default per-chain concurrency cap — the hard ceiling on how many RPC
 * requests can be in flight against a single chain's endpoint at once.
 * Free-tier Infura / Alchemy typically tolerate ~25 req/s per key; a
 * cap of 4 at ~500ms per request keeps us well under that while still
 * letting a single portfolio subsystem (e.g. Compound markets) pipeline
 * in parallel. Users on premium endpoints can raise via
 * VAULTPILOT_RPC_CONCURRENCY. Separate limiter per chain so a saturated
 * mainnet queue doesn't back-pressure independent arbitrum reads.
 */
const RPC_CONCURRENCY_DEFAULT = 4;
const RPC_CONCURRENCY = (() => {
  const raw = process.env.VAULTPILOT_RPC_CONCURRENCY;
  if (!raw) return RPC_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RPC_CONCURRENCY_DEFAULT;
})();

/**
 * Minimal FIFO semaphore. `acquire()` resolves as soon as a slot is free;
 * callers must call `release()` exactly once per acquire to avoid deadlock.
 * Kept tiny — no timeouts, no cancellation — because the only call sites
 * are inside the transport wrapper below and always run to completion via
 * a try/finally.
 */
class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }
  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const limiters = new Map<SupportedChain, Semaphore>();
function getLimiter(chain: SupportedChain): Semaphore {
  let l = limiters.get(chain);
  if (!l) {
    l = new Semaphore(RPC_CONCURRENCY);
    limiters.set(chain, l);
  }
  return l;
}

// Invalidate cached clients + the verified-chains memo whenever the user
// rewrites their rpc config, so the next call re-resolves URLs and re-runs
// chain-id verification. `onRpcConfigChange` accepts a single hook; rpc.ts
// owns it because it owns the cache.
// Also clear the per-chain limiters — stale in-flight counts from a
// previous URL shouldn't throttle reads against the new one.
onRpcConfigChange(() => {
  clients.clear();
  verifiedChains.clear();
  limiters.clear();
});

/**
 * Wrap viem's `http` transport with a per-chain concurrency limiter.
 * Every outbound RPC request acquires a slot from the chain's semaphore
 * before hitting the wire and releases after — bounding instantaneous
 * pressure regardless of how the caller fanned out (multi-wallet ×
 * multi-subsystem × multi-market produces the highest burst; that was
 * the #88 trigger). viem doesn't expose a custom-fetch hook on its http
 * transport, so we wrap the transport's `request` method at the point
 * where every call funnels through it.
 */
function limitedHttp(chain: SupportedChain, url: string, httpOpts: {
  batch: boolean;
  retryCount: number;
  retryDelay: number;
}): Transport {
  const base = http(url, httpOpts);
  const limiter = getLimiter(chain);
  const wrapped: Transport = ((config) => {
    const inner = base(config);
    const originalRequest = inner.request.bind(inner);
    return {
      ...inner,
      request: (async (args: Parameters<typeof originalRequest>[0]) => {
        await limiter.acquire();
        try {
          return await originalRequest(args);
        } finally {
          limiter.release();
        }
      }) as typeof inner.request,
    };
  }) as Transport;
  return wrapped;
}

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
  // retryCount/retryDelay: viem's http transport retries on 429 (and
  // other transient 4xx/5xx) with exponential backoff `retryDelay *
  // 2^attempt`. An earlier iteration bumped these to 5/600ms to ride out
  // sustained Infura saturation; live testing (#88 trace, 6-minute hangs
  // on multi-wallet portfolio fan-outs) showed that aggressive retry
  // multiplies wall-clock pain under rate-limit — each retry attempt adds
  // 600ms-10s of blocked time, and when hundreds of calls retry in
  // parallel, the user watches the tool "think" for minutes before any
  // coverage fails. Correct direction: REDUCE requests at the source
  // (Morpho discovery is now opt-in, the dominant hotspot) rather than
  // retry harder. Original `3/500` stays — worst-case ~3.5s is a sane
  // bound for a request that's going to fail anyway.
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: limitedHttp(chain, url, {
      batch: batchEnabled,
      retryCount: 3,
      retryDelay: 500,
    }),
  });
  clients.set(chain, client);
  return client;
}

/**
 * Verify the RPC endpoint actually speaks the chain we think it does. A wrong-
 * chain RPC would happily sign "ETH" txs against (say) a fork or BSC — values
 * and addresses overlap but token semantics don't, and the user would end up
 * sending real ETH against what they thought was a testnet. We do this on the
 * first live call per chain, memoize it, and throw loud if it mismatches.
 */
export async function verifyChainId(chain: SupportedChain): Promise<void> {
  if (verifiedChains.has(chain)) return;
  const client = getClient(chain);
  const actual = await client.getChainId();
  const expected = CHAIN_IDS[chain];
  if (actual !== expected) {
    throw new Error(
      `RPC for ${chain} returned chainId ${actual}, expected ${expected}. ` +
        `The configured endpoint does NOT point at ${chain} — refusing to proceed. ` +
        `Fix via \`vaultpilot-mcp-setup\` or the relevant env var.`
    );
  }
  verifiedChains.add(chain);
}

/** Invalidate the cached clients — useful after the user re-runs setup. */
export function resetClients(): void {
  clients.clear();
  verifiedChains.clear();
}
