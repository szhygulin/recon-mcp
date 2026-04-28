import { encodeFunctionData, formatEther, parseEther, parseUnits, zeroAddress } from "viem";
import { stETHAbi, wstETHAbi, lidoWithdrawalQueueAbi } from "../../abis/lido.js";
import { eigenStrategyManagerAbi } from "../../abis/eigenlayer-strategy-manager.js";
import { rocketDepositPoolAbi, rocketTokenRETHAbi } from "../../abis/rocketpool.js";
import { CONTRACTS } from "../../config/contracts.js";
import { getClient } from "../../data/rpc.js";
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

export interface RocketPoolStakeParams {
  wallet: `0x${string}`;
  amountEth: string;
}

/**
 * Build an unsigned RocketDepositPool.deposit() payable tx that mints rETH at
 * the current exchange rate. Preflight reads `getMaximumDepositAmount()`: if 0
 * the pool is disabled or full and the on-chain tx would revert with
 * "Deposits into Rocket Pool are currently disabled" / "The deposit pool size
 * after depositing exceeds the maximum size"; if the requested amount exceeds
 * it we refuse here to surface a clean error before the user signs.
 *
 * Min-deposit (~0.01 ETH per RocketDAOProtocolSettingsDeposit) is intentionally
 * not preflight-checked — the on-chain revert message is clear enough and the
 * extra RocketStorage lookup adds a transitive dep on the upgradeable settings
 * contract that is not worth the complexity for an edge that the smallest UI
 * already prevents.
 */
export async function buildRocketPoolStake(p: RocketPoolStakeParams): Promise<UnsignedTx> {
  const amountWei = parseEther(p.amountEth);
  const depositPool = CONTRACTS.ethereum.rocketpool.depositPool as `0x${string}`;

  const client = getClient("ethereum");
  const maxAmount = (await client.readContract({
    address: depositPool,
    abi: rocketDepositPoolAbi,
    functionName: "getMaximumDepositAmount",
  })) as bigint;
  if (maxAmount === 0n) {
    throw new Error(
      "Rocket Pool deposits are currently disabled or the deposit pool is at capacity. Try again later or stake via Lido (`prepare_lido_stake`).",
    );
  }
  if (amountWei > maxAmount) {
    throw new Error(
      `Rocket Pool deposit pool can currently accept at most ${formatEther(maxAmount)} ETH; requested ${p.amountEth} ETH would revert. Reduce the amount or wait for capacity.`,
    );
  }

  return {
    chain: "ethereum",
    to: depositPool,
    data: encodeFunctionData({
      abi: rocketDepositPoolAbi,
      functionName: "deposit",
      args: [],
    }),
    value: amountWei.toString(),
    from: p.wallet,
    description: `Stake ${p.amountEth} ETH with Rocket Pool (mints rETH at current exchange rate)`,
    decoded: { functionName: "deposit", args: { value: p.amountEth + " ETH" } },
  };
}

export interface RocketPoolUnstakeParams {
  wallet: `0x${string}`;
  amountReth: string;
}

/**
 * Build an unsigned rETH.burn(uint256) tx that redeems rETH for ETH from the
 * rETH contract's collateral (its own balance + RocketDepositPool excess).
 * No ERC-20 approve is needed — `burn` operates on `msg.sender`'s balance.
 *
 * Two preflight reverts the on-chain code throws are surfaced here so we
 * don't burn user gas:
 *   - "Insufficient rETH balance"           — wallet doesn't hold enough rETH
 *   - "Insufficient ETH balance for exchange" — `getTotalCollateral()` < ETH
 *     value of the burn. When this hits, the user can either burn a smaller
 *     amount or unwind on the rETH/ETH Uniswap V3 pool — we surface both
 *     options in the error string.
 */
export async function buildRocketPoolUnstake(p: RocketPoolUnstakeParams): Promise<UnsignedTx> {
  const amountWei = parseEther(p.amountReth);
  const reth = CONTRACTS.ethereum.rocketpool.rETH as `0x${string}`;

  const client = getClient("ethereum");
  const [balance, ethValue, totalCollateral] = await client.multicall({
    contracts: [
      { address: reth, abi: rocketTokenRETHAbi, functionName: "balanceOf", args: [p.wallet] },
      { address: reth, abi: rocketTokenRETHAbi, functionName: "getEthValue", args: [amountWei] },
      { address: reth, abi: rocketTokenRETHAbi, functionName: "getTotalCollateral" },
    ],
    allowFailure: false,
  });
  const balanceBn = balance as bigint;
  const ethValueBn = ethValue as bigint;
  const collateralBn = totalCollateral as bigint;
  if (balanceBn < amountWei) {
    throw new Error(
      `Insufficient rETH balance: wallet holds ${formatEther(balanceBn)} rETH but the burn requested ${p.amountReth} rETH.`,
    );
  }
  if (collateralBn < ethValueBn) {
    throw new Error(
      `Rocket Pool burn would revert: on-protocol ETH collateral is ${formatEther(collateralBn)} but ${p.amountReth} rETH redeems to ${formatEther(ethValueBn)} ETH. Burn a smaller amount, wait for liquidity to refill, or unwind via the rETH/ETH Uniswap V3 pool (prepare_uniswap_swap).`,
    );
  }

  return {
    chain: "ethereum",
    to: reth,
    data: encodeFunctionData({
      abi: rocketTokenRETHAbi,
      functionName: "burn",
      args: [amountWei],
    }),
    value: "0",
    from: p.wallet,
    description: `Burn ${p.amountReth} rETH for ${formatEther(ethValueBn)} ETH via Rocket Pool`,
    decoded: {
      functionName: "burn",
      args: { rethAmount: p.amountReth + " rETH", ethReceived: formatEther(ethValueBn) + " ETH" },
    },
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
