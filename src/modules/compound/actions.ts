import { encodeFunctionData, parseUnits, maxUint256 } from "viem";
import { cometAbi } from "../../abis/compound-comet.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import type {
  PrepareCompoundSupplyArgs,
  PrepareCompoundWithdrawArgs,
  PrepareCompoundBorrowArgs,
  PrepareCompoundRepayArgs,
} from "./schemas.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

async function resolveMeta(
  chain: SupportedChain,
  asset: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, symbol] = await client.multicall({
    contracts: [
      { address: asset, abi: erc20Abi, functionName: "decimals" },
      { address: asset, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  return { decimals: Number(decimals), symbol: symbol as string };
}

async function resolveBaseToken(
  chain: SupportedChain,
  market: `0x${string}`
): Promise<`0x${string}`> {
  const client = getClient(chain);
  return (await client.readContract({
    address: market,
    abi: cometAbi,
    functionName: "baseToken",
  })) as `0x${string}`;
}

async function ensureApprovalTx(
  chain: SupportedChain,
  wallet: `0x${string}`,
  asset: `0x${string}`,
  spender: `0x${string}`,
  amountWei: bigint,
  symbol: string
): Promise<UnsignedTx | null> {
  const client = getClient(chain);
  const allowance = (await client.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet, spender],
  })) as bigint;
  if (allowance >= amountWei) return null;
  return {
    chain,
    to: asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
    }),
    value: "0",
    from: wallet,
    description: `Approve ${symbol} for Compound V3 market (unlimited)`,
    decoded: { functionName: "approve", args: { spender, amount: "max" } },
  };
}

export async function buildCompoundSupply(p: PrepareCompoundSupplyArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const asset = p.asset as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  const meta = await resolveMeta(chain, asset);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const approval = await ensureApprovalTx(chain, wallet, asset, market, amountWei, meta.symbol);
  const supplyTx: UnsignedTx = {
    chain,
    to: market,
    data: encodeFunctionData({
      abi: cometAbi,
      functionName: "supply",
      args: [asset, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Supply ${p.amount} ${meta.symbol} to Compound V3 ${market} on ${chain}`,
    decoded: { functionName: "supply", args: { asset, amount: p.amount, market } },
  };
  if (approval) {
    approval.next = supplyTx;
    return approval;
  }
  return supplyTx;
}

export async function buildCompoundWithdraw(p: PrepareCompoundWithdrawArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const asset = p.asset as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  const meta = await resolveMeta(chain, asset);
  const amountWei = p.amount === "max" ? maxUint256 : parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: market,
    data: encodeFunctionData({
      abi: cometAbi,
      functionName: "withdraw",
      args: [asset, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Withdraw ${p.amount === "max" ? "all" : p.amount} ${meta.symbol} from Compound V3 ${market} on ${chain}`,
    decoded: { functionName: "withdraw", args: { asset, amount: p.amount, market } },
  };
}

/** Borrow = withdraw of the market's base token beyond the user's supplied balance. */
export async function buildCompoundBorrow(p: PrepareCompoundBorrowArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  const baseToken = await resolveBaseToken(chain, market);
  const meta = await resolveMeta(chain, baseToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: market,
    data: encodeFunctionData({
      abi: cometAbi,
      functionName: "withdraw",
      args: [baseToken, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Borrow ${p.amount} ${meta.symbol} from Compound V3 ${market} on ${chain}`,
    decoded: { functionName: "withdraw(base)", args: { asset: baseToken, amount: p.amount, market } },
  };
}

/** Repay = supply of the market's base token against an outstanding borrow. */
export async function buildCompoundRepay(p: PrepareCompoundRepayArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  const baseToken = await resolveBaseToken(chain, market);
  const meta = await resolveMeta(chain, baseToken);
  const amountWei = p.amount === "max" ? maxUint256 : parseUnits(p.amount, meta.decimals);
  const approval =
    amountWei === maxUint256
      ? null
      : await ensureApprovalTx(chain, wallet, baseToken, market, amountWei, meta.symbol);
  const repayTx: UnsignedTx = {
    chain,
    to: market,
    data: encodeFunctionData({
      abi: cometAbi,
      functionName: "supply",
      args: [baseToken, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Repay ${p.amount === "max" ? "all" : p.amount} ${meta.symbol} on Compound V3 ${market} on ${chain}`,
    decoded: { functionName: "supply(base)", args: { asset: baseToken, amount: p.amount, market } },
  };
  if (approval) {
    approval.next = repayTx;
    return approval;
  }
  return repayTx;
}
