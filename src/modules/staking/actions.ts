import { encodeFunctionData, parseEther, parseUnits, zeroAddress } from "viem";
import { stETHAbi, wstETHAbi, lidoWithdrawalQueueAbi } from "../../abis/lido.js";
import { eigenStrategyManagerAbi } from "../../abis/eigenlayer-strategy-manager.js";
import { CONTRACTS } from "../../config/contracts.js";
import { buildApprovalTx, chainApproval, resolveApprovalCap } from "../shared/approval.js";
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
  approvalCap?: string;
}

export async function buildLidoUnstake(p: LidoUnstakeParams): Promise<UnsignedTx> {
  const amountWei = parseEther(p.amountStETH);
  const queue = CONTRACTS.ethereum.lido.withdrawalQueue as `0x${string}`;
  const stETH = CONTRACTS.ethereum.lido.stETH as `0x${string}`;

  const { approvalAmount, display } = resolveApprovalCap(p.approvalCap, amountWei, 18);
  const approve = await buildApprovalTx({
    chain: "ethereum",
    wallet: p.wallet,
    asset: stETH,
    spender: queue,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: "stETH",
    spenderLabel: "Lido Withdrawal Queue",
  });

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

  return chainApproval(approve, unstakeTx);
}

export interface LidoWrapParams {
  wallet: `0x${string}`;
  amountStETH: string;
  approvalCap?: string;
}

export async function buildLidoWrap(p: LidoWrapParams): Promise<UnsignedTx> {
  const amountWei = parseEther(p.amountStETH);
  const stETH = CONTRACTS.ethereum.lido.stETH as `0x${string}`;
  const wstETH = CONTRACTS.ethereum.lido.wstETH as `0x${string}`;

  const { approvalAmount, display } = resolveApprovalCap(p.approvalCap, amountWei, 18);
  const approve = await buildApprovalTx({
    chain: "ethereum",
    wallet: p.wallet,
    asset: stETH,
    spender: wstETH,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: "stETH",
    spenderLabel: "Lido wstETH",
  });

  const wrapTx: UnsignedTx = {
    chain: "ethereum",
    to: wstETH,
    data: encodeFunctionData({
      abi: wstETHAbi,
      functionName: "wrap",
      args: [amountWei],
    }),
    value: "0",
    from: p.wallet,
    description: `Wrap ${p.amountStETH} stETH into wstETH`,
    decoded: { functionName: "wrap", args: { amount: p.amountStETH + " stETH" } },
  };

  return chainApproval(approve, wrapTx);
}

export interface LidoUnwrapParams {
  wallet: `0x${string}`;
  amountWstETH: string;
}

export function buildLidoUnwrap(p: LidoUnwrapParams): UnsignedTx {
  const amountWei = parseEther(p.amountWstETH);
  const wstETH = CONTRACTS.ethereum.lido.wstETH as `0x${string}`;
  return {
    chain: "ethereum",
    to: wstETH,
    data: encodeFunctionData({
      abi: wstETHAbi,
      functionName: "unwrap",
      args: [amountWei],
    }),
    value: "0",
    from: p.wallet,
    description: `Unwrap ${p.amountWstETH} wstETH into stETH`,
    decoded: { functionName: "unwrap", args: { amount: p.amountWstETH + " wstETH" } },
  };
}

export interface EigenDepositParams {
  wallet: `0x${string}`;
  strategy: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  decimals: number;
  symbol: string;
  approvalCap?: string;
}

export async function buildEigenLayerDeposit(p: EigenDepositParams): Promise<UnsignedTx> {
  const sm = CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`;
  const amountWei = parseUnits(p.amount, p.decimals);

  const { approvalAmount, display } = resolveApprovalCap(p.approvalCap, amountWei, p.decimals);
  const approve = await buildApprovalTx({
    chain: "ethereum",
    wallet: p.wallet,
    asset: p.token,
    spender: sm,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: p.symbol,
    spenderLabel: "EigenLayer StrategyManager",
  });

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

  return chainApproval(approve, depositTx);
}
