import { getClient } from "../../data/rpc.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../../config/contracts.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import { getTokenPrice } from "../../data/prices.js";
import { getLendingPositions, getLpPositions } from "../positions/index.js";
import { getStakingPositions } from "../staking/index.js";
import type { GetPortfolioSummaryArgs } from "./schemas.js";
import type { PortfolioSummary, SupportedChain, TokenAmount } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

async function fetchNativeBalance(wallet: `0x${string}`, chain: SupportedChain): Promise<TokenAmount> {
  const client = getClient(chain);
  const [balance, ethPrice] = await Promise.all([
    client.getBalance({ address: wallet }),
    getTokenPrice(chain, "native"),
  ]);
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    balance,
    18,
    NATIVE_SYMBOL[chain],
    ethPrice
  );
}

async function fetchTopErc20Balances(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<TokenAmount[]> {
  const tokens = CONTRACTS[chain].tokens as Record<string, string>;
  const entries = Object.entries(tokens);
  if (entries.length === 0) return [];

  const client = getClient(chain);
  const calls = entries.flatMap(([, addr]) => [
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet] as const },
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
  ]);
  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const out: TokenAmount[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [symbol, addr] = entries[i];
    const balanceRes = results[i * 2];
    const decimalsRes = results[i * 2 + 1];
    if (balanceRes.status !== "success" || decimalsRes.status !== "success") continue;
    const balance = balanceRes.result as bigint;
    if (balance === 0n) continue;
    const decimals = Number(decimalsRes.result);
    out.push(makeTokenAmount(chain, addr as `0x${string}`, balance, decimals, symbol));
  }

  await priceTokenAmounts(chain, out);
  return out;
}

export async function getPortfolioSummary(args: GetPortfolioSummaryArgs): Promise<PortfolioSummary> {
  const wallet = args.wallet as `0x${string}`;
  const chains = ((args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS]);

  // Run everything in parallel — each is independent.
  const [nativeAmounts, erc20Amounts, lending, lp, staking] = await Promise.all([
    Promise.all(chains.map((c) => fetchNativeBalance(wallet, c))),
    Promise.all(chains.map((c) => fetchTopErc20Balances(wallet, c))),
    getLendingPositions({ wallet, chains }),
    getLpPositions({ wallet, chains }),
    getStakingPositions({ wallet, chains }),
  ]);

  // Filter zero native balances out.
  const native = nativeAmounts.filter((a) => a.amount !== "0");
  const erc20 = erc20Amounts.flat();

  const walletBalancesUsd = round(
    [...native, ...erc20].reduce((sum, t) => sum + (t.valueUsd ?? 0), 0),
    2
  );
  const lendingNetUsd = round(
    lending.positions.reduce((sum, p) => sum + p.netValueUsd, 0),
    2
  );
  const lpUsd = round(lp.positions.reduce((sum, p) => sum + p.totalValueUsd, 0), 2);
  const stakingUsd = round(
    staking.positions.reduce((sum, p) => sum + (p.stakedAmount.valueUsd ?? 0), 0),
    2
  );
  const totalUsd = round(walletBalancesUsd + lendingNetUsd + lpUsd + stakingUsd, 2);

  // Per-chain breakdown (sums everything tagged to each chain).
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;

  for (const t of [...native, ...erc20]) {
    // The token's chain is encoded in the caller context — we know from arrays.
  }
  // Simpler re-walk with index awareness:
  chains.forEach((c, i) => {
    const chainNative = nativeAmounts[i]?.valueUsd ?? 0;
    const chainErc20 = erc20Amounts[i].reduce((s, t) => s + (t.valueUsd ?? 0), 0);
    const chainLending = lending.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.netValueUsd, 0);
    const chainLp = lp.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.totalValueUsd, 0);
    const chainStaking = staking.positions.filter((p) => p.chain === c).reduce((s, p) => s + (p.stakedAmount.valueUsd ?? 0), 0);
    perChain[c] = round(chainNative + chainErc20 + chainLending + chainLp + chainStaking, 2);
  });

  return {
    wallet,
    chains,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    totalUsd,
    perChain,
    breakdown: {
      native,
      erc20,
      lending: lending.positions,
      lp: lp.positions,
      staking: staking.positions,
    },
  };
}
