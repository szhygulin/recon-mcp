import { encodeFunctionData, parseEther, parseUnits, maxUint256, zeroAddress } from "viem";
import { stETHAbi, lidoWithdrawalQueueAbi } from "../../abis/lido.js";
import { erc20Abi } from "../../abis/erc20.js";
import { eigenStrategyManagerAbi } from "../../abis/eigenlayer-strategy-manager.js";
import { CONTRACTS } from "../../config/contracts.js";
import { getClient } from "../../data/rpc.js";
import type { UnsignedTx } from "../../types/index.js";

export interface LidoStakeParams {
  wallet: `0x${string}`;
  amountEth: string; // e.g. "0.5"
}

export function buildLidoStake(p: LidoStakeParams): UnsignedTx {
  const amountWei = parseEther(p.amountEth);
  return {
    chain: "ethereum",
    to: CONTRACTS.ethereum.lido.stETH as `0x${string}`,
    data: encodeFunctionData({
      abi: stETHAbi,
      functionName: "submit",
      args: [zeroAddress],
    }),
    value: amountWei.toString(),
    from: p.wallet,
    description: `Stake ${p.amountEth} ETH with Lido`,
    decoded: { functionName: "submit", args: { referral: zeroAddress, value: p.amountEth + " ETH" } },
  };
}

export interface LidoUnstakeParams {
  wallet: `0x${string}`;
  amountStETH: string;
}

export async function buildLidoUnstake(p: LidoUnstakeParams): Promise<UnsignedTx> {
  const amountWei = parseEther(p.amountStETH);
  const queue = CONTRACTS.ethereum.lido.withdrawalQueue as `0x${string}`;
  const stETH = CONTRACTS.ethereum.lido.stETH as `0x${string}`;

  const client = getClient("ethereum");
  const allowance = (await client.readContract({
    address: stETH,
    abi: erc20Abi,
    functionName: "allowance",
    args: [p.wallet, queue],
  })) as bigint;

  const unstakeTx: UnsignedTx = {
    chain: "ethereum",
    to: queue,
    data: encodeFunctionData({
      abi: lidoWithdrawalQueueAbi,
      functionName: "requestWithdrawals",
      args: [[amountWei], p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Request withdrawal of ${p.amountStETH} stETH via Lido Withdrawal Queue`,
    decoded: { functionName: "requestWithdrawals", args: { amount: p.amountStETH, owner: p.wallet } },
  };

  if (allowance < amountWei) {
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: stETH,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [queue, maxUint256] }),
      value: "0",
      from: p.wallet,
      description: "Approve stETH for Lido Withdrawal Queue (unlimited)",
      decoded: { functionName: "approve", args: { spender: queue, amount: "max" } },
      next: unstakeTx,
    };
    return approve;
  }

  return unstakeTx;
}

export interface EigenDepositParams {
  wallet: `0x${string}`;
  strategy: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  decimals: number;
  symbol: string;
}

export async function buildEigenLayerDeposit(p: EigenDepositParams): Promise<UnsignedTx> {
  const sm = CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`;
  const amountWei = parseUnits(p.amount, p.decimals);
  const client = getClient("ethereum");

  const allowance = (await client.readContract({
    address: p.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [p.wallet, sm],
  })) as bigint;

  const depositTx: UnsignedTx = {
    chain: "ethereum",
    to: sm,
    data: encodeFunctionData({
      abi: eigenStrategyManagerAbi,
      functionName: "depositIntoStrategy",
      args: [p.strategy, p.token, amountWei],
    }),
    value: "0",
    from: p.wallet,
    description: `Deposit ${p.amount} ${p.symbol} into EigenLayer strategy ${p.strategy}`,
    decoded: {
      functionName: "depositIntoStrategy",
      args: { strategy: p.strategy, token: p.token, amount: p.amount },
    },
  };

  if (allowance < amountWei) {
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: p.token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sm, maxUint256] }),
      value: "0",
      from: p.wallet,
      description: `Approve ${p.symbol} for EigenLayer StrategyManager (unlimited)`,
      decoded: { functionName: "approve", args: { spender: sm, amount: "max" } },
      next: depositTx,
    };
    return approve;
  }

  return depositTx;
}
