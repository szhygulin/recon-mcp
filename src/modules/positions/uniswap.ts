import { getAddress, getContractAddress, keccak256, encodePacked, formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { uniswapPositionManagerAbi } from "../../abis/uniswap-position-manager.js";
import { uniswapPoolAbi } from "../../abis/uniswap-pool.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getTokenPrices } from "../../data/prices.js";
import { round, makeTokenAmount } from "../../data/format.js";
import type { LPPosition, SupportedChain, TokenAmount } from "../../types/index.js";

const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

/** Deterministically compute the Uniswap V3 pool address from (factory, token0, token1, fee). */
export function computePoolAddress(
  factory: `0x${string}`,
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
  fee: number
): `0x${string}` {
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = keccak256(
    encodePacked(["address", "address", "uint24"], [token0, token1, fee])
  );
  // CREATE2: address = keccak256(0xff ++ factory ++ salt ++ keccak256(init_code))[12:]
  const packed = `0xff${factory.slice(2)}${salt.slice(2)}${POOL_INIT_CODE_HASH.slice(2)}` as `0x${string}`;
  const hash = keccak256(packed);
  return getAddress(`0x${hash.slice(26)}`) as `0x${string}`;
}

/** 1.0001^tick — price of token1 per token0 in raw (not decimal-adjusted) terms. */
function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * Compute amounts of token0 / token1 held in a concentrated-liquidity position
 * given current sqrtPrice (Q96) and the tick bounds.
 *
 * Reference: https://blog.uniswap.org/uniswap-v3-math-primer
 */
function computeAmountsFromLiquidity(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number
): { amount0: bigint; amount1: bigint } {
  const Q96 = 2n ** 96n;
  const sqrtLower = BigInt(Math.floor(Math.sqrt(tickToPrice(tickLower)) * Number(Q96)));
  const sqrtUpper = BigInt(Math.floor(Math.sqrt(tickToPrice(tickUpper)) * Number(Q96)));
  const sqrtP = sqrtPriceX96;

  let amount0 = 0n;
  let amount1 = 0n;

  if (currentTick < tickLower) {
    amount0 = (liquidity * (sqrtUpper - sqrtLower) * Q96) / (sqrtUpper * sqrtLower);
  } else if (currentTick >= tickUpper) {
    amount1 = (liquidity * (sqrtUpper - sqrtLower)) / Q96;
  } else {
    amount0 = (liquidity * (sqrtUpper - sqrtP) * Q96) / (sqrtUpper * sqrtP);
    amount1 = (liquidity * (sqrtP - sqrtLower)) / Q96;
  }

  return { amount0, amount1 };
}

/** Approximate IL vs. HODL, using the geometric mean of the tick range as entry price proxy. */
function estimateIL(tickLower: number, tickUpper: number, currentTick: number): number {
  const entryPrice = tickToPrice((tickLower + tickUpper) / 2);
  const currentPrice = tickToPrice(currentTick);
  const ratio = currentPrice / entryPrice;
  // Standard full-range IL formula.
  const il = (2 * Math.sqrt(ratio)) / (1 + ratio) - 1;
  return round(il, 6);
}

interface PositionRaw {
  tokenId: bigint;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export async function getUniswapPositions(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<LPPosition[]> {
  const client = getClient(chain);
  const npm = CONTRACTS[chain].uniswap.positionManager as `0x${string}`;
  const factory = CONTRACTS[chain].uniswap.factory as `0x${string}`;

  const balance = (await client.readContract({
    address: npm,
    abi: uniswapPositionManagerAbi,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;

  const count = Number(balance);
  if (count === 0) return [];

  // 1) Batch fetch all tokenIds
  const idCalls = Array.from({ length: count }, (_, i) => ({
    address: npm,
    abi: uniswapPositionManagerAbi,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [wallet, BigInt(i)] as const,
  }));
  const idResults = await client.multicall({ contracts: idCalls, allowFailure: true });
  const tokenIds = idResults
    .map((r) => (r.status === "success" ? (r.result as bigint) : null))
    .filter((x): x is bigint => x !== null);

  // 2) Batch fetch position details
  const posCalls = tokenIds.map((id) => ({
    address: npm,
    abi: uniswapPositionManagerAbi,
    functionName: "positions" as const,
    args: [id] as const,
  }));
  const posResults = await client.multicall({ contracts: posCalls, allowFailure: true });

  const raw: PositionRaw[] = [];
  for (let i = 0; i < posResults.length; i++) {
    const r = posResults[i];
    if (r.status !== "success") continue;
    const tuple = r.result as readonly [bigint, `0x${string}`, `0x${string}`, `0x${string}`, number, number, number, bigint, bigint, bigint, bigint, bigint];
    // positions() returns: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, fgi0, fgi1, owed0, owed1
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = tuple;
    // Skip empty positions (closed / burned)
    if (liquidity === 0n && owed0 === 0n && owed1 === 0n) continue;
    raw.push({
      tokenId: tokenIds[i],
      token0,
      token1,
      fee: Number(fee),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      liquidity,
      tokensOwed0: owed0,
      tokensOwed1: owed1,
    });
  }

  if (raw.length === 0) return [];

  // 3) For each position, resolve pool address and fetch slot0 + token metadata
  const poolAddrs = raw.map((p) => computePoolAddress(factory, p.token0, p.token1, p.fee));
  const slot0Calls = poolAddrs.map((p) => ({
    address: p,
    abi: uniswapPoolAbi,
    functionName: "slot0" as const,
  }));
  // We also want decimals + symbol for both tokens.
  const tokenMetaCalls = raw.flatMap((p) => [
    { address: p.token0, abi: erc20Abi, functionName: "decimals" as const },
    { address: p.token0, abi: erc20Abi, functionName: "symbol" as const },
    { address: p.token1, abi: erc20Abi, functionName: "decimals" as const },
    { address: p.token1, abi: erc20Abi, functionName: "symbol" as const },
  ]);

  const [slot0Results, metaResults] = await Promise.all([
    client.multicall({ contracts: slot0Calls, allowFailure: true }),
    client.multicall({ contracts: tokenMetaCalls, allowFailure: true }),
  ]);

  // 4) Batch price fetch for every token involved
  const uniqueTokens = new Set<string>();
  raw.forEach((p) => {
    uniqueTokens.add(p.token0.toLowerCase());
    uniqueTokens.add(p.token1.toLowerCase());
  });
  const prices = await getTokenPrices(
    [...uniqueTokens].map((addr) => ({ chain, address: addr as `0x${string}` }))
  );

  const positions: LPPosition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const slotRes = slot0Results[i];
    if (slotRes.status !== "success") continue;
    const slot0 = slotRes.result as readonly [bigint, number, number, number, number, number, boolean];
    const sqrtPriceX96 = slot0[0];
    const currentTick = Number(slot0[1]);

    const dec0 = Number(metaResults[i * 4]?.status === "success" ? (metaResults[i * 4].result as number) : 18);
    const sym0 = metaResults[i * 4 + 1]?.status === "success" ? (metaResults[i * 4 + 1].result as string) : "?";
    const dec1 = Number(metaResults[i * 4 + 2]?.status === "success" ? (metaResults[i * 4 + 2].result as number) : 18);
    const sym1 = metaResults[i * 4 + 3]?.status === "success" ? (metaResults[i * 4 + 3].result as string) : "?";

    const { amount0, amount1 } = computeAmountsFromLiquidity(
      p.liquidity,
      sqrtPriceX96,
      p.tickLower,
      p.tickUpper,
      currentTick
    );

    const price0 = prices.get(`${chain}:${p.token0.toLowerCase()}`);
    const price1 = prices.get(`${chain}:${p.token1.toLowerCase()}`);

    const token0 = makeTokenAmount(chain, p.token0, amount0, dec0, sym0, price0);
    const token1 = makeTokenAmount(chain, p.token1, amount1, dec1, sym1, price1);
    const totalValueUsd = round((token0.valueUsd ?? 0) + (token1.valueUsd ?? 0), 2);

    const fees0 = makeTokenAmount(chain, p.token0, p.tokensOwed0, dec0, sym0, price0);
    const fees1 = makeTokenAmount(chain, p.token1, p.tokensOwed1, dec1, sym1, price1);

    positions.push({
      protocol: "uniswap-v3",
      chain,
      tokenId: p.tokenId.toString(),
      token0,
      token1,
      feeTier: p.fee,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      currentTick,
      inRange: p.tickLower <= currentTick && currentTick < p.tickUpper,
      liquidity: p.liquidity.toString(),
      unclaimedFees0: fees0,
      unclaimedFees1: fees1,
      totalValueUsd,
      impermanentLossEstimate: estimateIL(p.tickLower, p.tickUpper, currentTick),
    });
  }

  return positions;
}
