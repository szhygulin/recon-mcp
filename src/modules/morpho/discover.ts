import { parseAbiItem } from "viem";
import { getClient } from "../../data/rpc.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Morpho Blue deployment block per chain. We only start the log scan from
 * here — scanning back to genesis is a multi-million-block waste on mainnet.
 */
const MORPHO_DEPLOYMENT_BLOCK: Partial<Record<SupportedChain, bigint>> = {
  ethereum: 18883124n,
};

/**
 * Most public RPC providers (Alchemy/Infura free tier, public nodes) cap
 * `eth_getLogs` at 10k blocks per request. Users on premium endpoints with
 * higher caps can override via MORPHO_DISCOVERY_CHUNK.
 */
const SCAN_CHUNK: bigint = (() => {
  const raw = process.env.MORPHO_DISCOVERY_CHUNK;
  if (!raw) return 10_000n;
  const parsed = BigInt(raw);
  return parsed > 0n ? parsed : 10_000n;
})();

/**
 * Position-opening events: a wallet's set of active markets is a subset of
 * the markets it has ever opened into. Closed positions drop out later when
 * readMarketPosition sees zero shares/collateral. Withdraw/Repay/Liquidate
 * never introduce a fresh market, so we don't scan them.
 *
 * In Morpho Blue, `onBehalf` is indexed on all three, which means the RPC
 * does the filter server-side via topic3 (or topic2 for Borrow — viem maps
 * named args to the correct topic slot automatically).
 */
const supplyEvent = parseAbiItem(
  "event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"
);
const borrowEvent = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"
);
const supplyCollateralEvent = parseAbiItem(
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)"
);

function morphoAddress(chain: SupportedChain): `0x${string}` | null {
  const entry = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]
    ?.morpho;
  const addr = entry?.blue;
  return (addr as `0x${string}` | undefined) ?? null;
}

/**
 * Discover every Morpho Blue marketId the wallet has ever opened a position
 * in (as `onBehalf`) on a single chain. Returns unique ids; callers should
 * treat these as candidates and re-read live state via `readMarketPosition`
 * to filter out closed positions.
 *
 * Returns `[]` for chains with no Morpho Blue deployment.
 *
 * Results are cached for CACHE_TTL.MORPHO_DISCOVERY per `(chain, wallet)`.
 * The event-log scan on mainnet walks ~millions of blocks in 10k-block
 * chunks via `eth_getLogs` — issue #88 traced recurring Infura 429s to
 * repeated discovery calls during a single session's portfolio fan-out,
 * which then collaterally rate-limited other mainnet reads (Lido,
 * cross-chain Compound). Caching discovery is the dominant mitigation.
 * A just-opened Morpho position will appear on the next cache miss; the
 * `marketIds` explicit override in getMorphoPositions stays the
 * always-fresh fast path.
 */
export async function discoverMorphoMarketIds(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<`0x${string}`[]> {
  const cacheKey = `morpho:discovery:${chain}:${wallet.toLowerCase()}`;
  return cache.remember(cacheKey, CACHE_TTL.MORPHO_DISCOVERY, () =>
    scanMorphoMarketIds(wallet, chain),
  );
}

async function scanMorphoMarketIds(
  wallet: `0x${string}`,
  chain: SupportedChain,
): Promise<`0x${string}`[]> {
  const morpho = morphoAddress(chain);
  const deploymentBlock = MORPHO_DEPLOYMENT_BLOCK[chain];
  if (!morpho || deploymentBlock === undefined) return [];

  const client = getClient(chain);
  const latest = await client.getBlockNumber();

  const ids = new Set<`0x${string}`>();

  // The three event queries per chunk were previously run in `Promise.all`,
  // which triples the instantaneous RPC pressure per block range and makes
  // free-tier Infura the bottleneck — issue #88 trace showed HTTP 429 on
  // mainnet event-log scans across multi-wallet portfolio fan-outs.
  // Serializing the three queries cuts peak concurrency without adding a
  // meaningful wall-clock cost per chunk (each chunk's three queries share
  // the same block range, so the inner await is still a tight loop).
  for (let from = deploymentBlock; from <= latest; from += SCAN_CHUNK) {
    const to = from + SCAN_CHUNK - 1n > latest ? latest : from + SCAN_CHUNK - 1n;
    const supplyLogs = await client.getLogs({
      address: morpho,
      event: supplyEvent,
      args: { onBehalf: wallet },
      fromBlock: from,
      toBlock: to,
    });
    const borrowLogs = await client.getLogs({
      address: morpho,
      event: borrowEvent,
      args: { onBehalf: wallet },
      fromBlock: from,
      toBlock: to,
    });
    const collateralLogs = await client.getLogs({
      address: morpho,
      event: supplyCollateralEvent,
      args: { onBehalf: wallet },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of [...supplyLogs, ...borrowLogs, ...collateralLogs]) {
      const id = (log.args as { id?: `0x${string}` }).id;
      if (id) ids.add(id);
    }
  }

  return Array.from(ids);
}
