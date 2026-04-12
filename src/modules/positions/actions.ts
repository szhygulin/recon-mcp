import { encodeFunctionData, parseUnits, maxUint256, formatUnits } from "viem";
import { aavePoolAbi } from "../../abis/aave-pool.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { getAavePoolAddress } from "./aave.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Ensure `owner` has granted `spender` at least `amount` of `asset`.
 * If not, returns an ERC-20 approve() tx. Returns null if allowance is already enough.
 */
async function ensureApproval(
  chain: SupportedChain,
  owner: `0x${string}`,
  spender: `0x${string}`,
  asset: `0x${string}`,
  amount: bigint,
  symbol: string,
  decimals: number
): Promise<UnsignedTx | null> {
  const client = getClient(chain);
  const allowance = (await client.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (allowance >= amount) return null;

  return {
    chain,
    to: asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
    }),
    value: "0",
    from: owner,
    description: `Approve ${symbol} for Aave V3 Pool (unlimited)`,
    decoded: {
      functionName: "approve",
      args: { spender, amount: "max" },
    },
  };
}

interface AaveActionParams {
  wallet: `0x${string}`;
  chain: SupportedChain;
  asset: `0x${string}`;
  amount: string; // human-readable amount ("100.5")
  decimals: number;
  symbol: string;
}

function parseAmountFriendly(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

export async function buildAaveSupply(p: AaveActionParams): Promise<UnsignedTx> {
  const pool = await getAavePoolAddress(p.chain);
  const amountWei = parseAmountFriendly(p.amount, p.decimals);
  const approval = await ensureApproval(p.chain, p.wallet, pool, p.asset, amountWei, p.symbol, p.decimals);

  const supplyTx: UnsignedTx = {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [p.asset, amountWei, p.wallet, 0],
    }),
    value: "0",
    from: p.wallet,
    description: `Supply ${p.amount} ${p.symbol} to Aave V3 on ${p.chain}`,
    decoded: {
      functionName: "supply",
      args: { asset: p.asset, amount: p.amount, onBehalfOf: p.wallet, referralCode: "0" },
    },
  };

  if (approval) {
    approval.next = supplyTx;
    return approval;
  }
  return supplyTx;
}

export async function buildAaveWithdraw(p: AaveActionParams): Promise<UnsignedTx> {
  const pool = await getAavePoolAddress(p.chain);
  // Special case: passing max uint means "withdraw all" in Aave V3.
  const amountWei =
    p.amount === "max" ? maxUint256 : parseAmountFriendly(p.amount, p.decimals);
  return {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "withdraw",
      args: [p.asset, amountWei, p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Withdraw ${p.amount === "max" ? "all" : p.amount} ${p.symbol} from Aave V3 on ${p.chain}`,
    decoded: {
      functionName: "withdraw",
      args: { asset: p.asset, amount: p.amount, to: p.wallet },
    },
  };
}

export async function buildAaveBorrow(
  p: AaveActionParams & { interestRateMode: "stable" | "variable" }
): Promise<UnsignedTx> {
  const pool = await getAavePoolAddress(p.chain);
  const amountWei = parseAmountFriendly(p.amount, p.decimals);
  const rate = p.interestRateMode === "stable" ? 1n : 2n;
  return {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "borrow",
      args: [p.asset, amountWei, rate, 0, p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Borrow ${p.amount} ${p.symbol} from Aave V3 on ${p.chain} (${p.interestRateMode} rate)`,
    decoded: {
      functionName: "borrow",
      args: {
        asset: p.asset,
        amount: p.amount,
        rate: p.interestRateMode,
        onBehalfOf: p.wallet,
      },
    },
  };
}

export async function buildAaveRepay(
  p: AaveActionParams & { interestRateMode: "stable" | "variable" }
): Promise<UnsignedTx> {
  const pool = await getAavePoolAddress(p.chain);
  const amountWei =
    p.amount === "max" ? maxUint256 : parseAmountFriendly(p.amount, p.decimals);
  const rate = p.interestRateMode === "stable" ? 1n : 2n;
  const approval = amountWei === maxUint256
    ? null
    : await ensureApproval(p.chain, p.wallet, pool, p.asset, amountWei, p.symbol, p.decimals);

  const repayTx: UnsignedTx = {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [p.asset, amountWei, rate, p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Repay ${p.amount === "max" ? "all" : p.amount} ${p.symbol} on Aave V3 ${p.chain}`,
    decoded: {
      functionName: "repay",
      args: {
        asset: p.asset,
        amount: p.amount,
        rate: p.interestRateMode,
        onBehalfOf: p.wallet,
      },
    },
  };

  if (approval) {
    approval.next = repayTx;
    return approval;
  }
  return repayTx;
}

export { parseAmountFriendly, formatUnits };
