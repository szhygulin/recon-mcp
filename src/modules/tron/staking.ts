import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { TRONGRID_BASE_URL, TRX_DECIMALS, isTronAddress } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import type {
  TronClaimableReward,
  TronFrozenEntry,
  TronPendingUnfreeze,
  TronStakingSlice,
} from "../../types/index.js";

/**
 * Format raw SUN ("12345678") into a human TRX string ("12.345678"). Mirrors
 * the formatter in balances.ts — kept local so the file stands alone.
 */
function formatTrx(sun: bigint): string {
  const s = sun.toString().padStart(TRX_DECIMALS + 1, "0");
  const whole = s.slice(0, s.length - TRX_DECIMALS);
  const frac = s.slice(s.length - TRX_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

interface TrongridV1Account {
  address?: string;
  /**
   * Stake 2.0 frozen entries. TronGrid returns these in the account payload
   * — `frozenV2` is the current-format field; legacy `frozen` is only used
   * pre-Stake-2.0 and isn't surfaced here.
   */
  frozenV2?: Array<{ amount?: number; type?: "BANDWIDTH" | "ENERGY" }>;
  /** Pending unfreezes — TRX locked for the 14-day unbonding window. */
  unfrozenV2?: Array<{
    unfreeze_amount?: number;
    type?: "BANDWIDTH" | "ENERGY";
    unfreeze_expire_time?: number;
  }>;
}

interface TrongridV1AccountResponse {
  data?: TrongridV1Account[];
}

interface TrongridRewardResponse {
  reward?: number;
}

interface LlamaResponse {
  coins: Record<string, { price: number }>;
}

async function fetchTrxPrice(): Promise<number | undefined> {
  const key = "price:coingecko:tron";
  const hit = cache.get<number>(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch("https://coins.llama.fi/prices/current/coingecko:tron");
    if (!res.ok) return undefined;
    const body = (await res.json()) as LlamaResponse;
    const price = body.coins["coingecko:tron"]?.price;
    if (typeof price === "number") {
      cache.set(key, price, CACHE_TTL.PRICE);
      return price;
    }
  } catch {
    // Price misses are non-fatal — caller still returns raw amounts.
  }
  return undefined;
}

async function trongridGet<T>(path: string, apiKey: string | undefined): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetch(`${TRONGRID_BASE_URL}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function trongridPost<T>(
  path: string,
  body: Record<string, unknown>,
  apiKey: string | undefined
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetch(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Read TRON staking state for `address`:
 *   - claimable voting rewards (`/wallet/getReward`)
 *   - frozen TRX under Stake 2.0 (bandwidth + energy, from the v1 account payload)
 *   - pending unfreezes with their unlock timestamps
 *
 * Throws if `address` isn't a valid TRON mainnet shape. Individual TronGrid
 * failures propagate — the portfolio aggregator wraps the call in its
 * catch-and-continue pattern so a staking outage doesn't kill balance reads.
 *
 * Rewards and account data are fetched in parallel. The account `/v1/accounts`
 * endpoint is the same one balances.ts uses, but we don't share the call here:
 * the two readers can be invoked independently (via the dedicated
 * `get_tron_staking` tool) and the portfolio fan-out runs them concurrently.
 */
export async function getTronStaking(address: string): Promise<TronStakingSlice> {
  if (!isTronAddress(address)) {
    throw new Error(
      `"${address}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`
    );
  }

  const apiKey = resolveTronApiKey(readUserConfig());

  const [accountRes, rewardRes, trxPrice] = await Promise.all([
    trongridGet<TrongridV1AccountResponse>(`/v1/accounts/${address}`, apiKey),
    trongridPost<TrongridRewardResponse>(
      "/wallet/getReward",
      { address, visible: true },
      apiKey
    ),
    fetchTrxPrice(),
  ]);

  const acc = accountRes.data?.[0];
  const rewardSun = BigInt(rewardRes.reward ?? 0);

  const frozen: TronFrozenEntry[] = [];
  for (const entry of acc?.frozenV2 ?? []) {
    const amount = BigInt(entry.amount ?? 0);
    if (amount === 0n) continue;
    const type = entry.type === "ENERGY" ? "energy" : "bandwidth";
    const formatted = formatTrx(amount);
    const valueUsd =
      trxPrice !== undefined ? Number(formatted) * trxPrice : undefined;
    frozen.push({
      type,
      amount: amount.toString(),
      formatted,
      ...(valueUsd !== undefined ? { valueUsd } : {}),
    });
  }

  const pendingUnfreezes: TronPendingUnfreeze[] = [];
  for (const entry of acc?.unfrozenV2 ?? []) {
    const amount = BigInt(entry.unfreeze_amount ?? 0);
    if (amount === 0n) continue;
    const type = entry.type === "ENERGY" ? "energy" : "bandwidth";
    const unlockMs = entry.unfreeze_expire_time ?? 0;
    const formatted = formatTrx(amount);
    const valueUsd =
      trxPrice !== undefined ? Number(formatted) * trxPrice : undefined;
    pendingUnfreezes.push({
      type,
      amount: amount.toString(),
      formatted,
      unlockAt: new Date(unlockMs).toISOString(),
      ...(valueUsd !== undefined ? { valueUsd } : {}),
    });
  }

  const rewardFormatted = formatTrx(rewardSun);
  const rewardUsd =
    trxPrice !== undefined ? Number(rewardFormatted) * trxPrice : undefined;
  const claimableRewards: TronClaimableReward = {
    amount: rewardSun.toString(),
    formatted: rewardFormatted,
    ...(rewardUsd !== undefined ? { valueUsd: rewardUsd } : {}),
  };

  const totalSun =
    frozen.reduce((s, f) => s + BigInt(f.amount), 0n) +
    pendingUnfreezes.reduce((s, u) => s + BigInt(u.amount), 0n) +
    rewardSun;
  const totalStakedTrx = formatTrx(totalSun);
  const totalStakedUsd =
    trxPrice !== undefined
      ? Math.round(Number(totalStakedTrx) * trxPrice * 100) / 100
      : 0;

  return {
    address,
    claimableRewards,
    frozen,
    pendingUnfreezes,
    totalStakedTrx,
    totalStakedUsd,
  };
}
