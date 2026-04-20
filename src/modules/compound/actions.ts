import { encodeFunctionData, parseUnits, maxUint256 } from "viem";
import { cometAbi } from "../../abis/compound-comet.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { buildApprovalTx, resolveApprovalCap } from "../shared/approval.js";
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

/**
 * Refuse to build a tx when the Comet pause-guardian has disabled the relevant
 * action. The prior behavior was to happily encode the calldata and let the
 * revert surface downstream during simulation or (worse) signing — that's the
 * failure mode that bit cUSDCv3 on 2026-04-20. We read one flag per action (not
 * all five) so this is a single extra eth_call on the prepare path.
 *
 * Only the "unambiguous" direction is checked per action: supply/repay need
 * isSupplyPaused; withdraw/borrow need isWithdrawPaused. Transfer/absorb/buy
 * aren't reachable through these four prepare_* tools.
 */
async function assertCometActionAllowed(
  chain: SupportedChain,
  market: `0x${string}`,
  action: "supply" | "withdraw"
): Promise<void> {
  const fn = action === "supply" ? "isSupplyPaused" : "isWithdrawPaused";
  const client = getClient(chain);
  const paused = (await client.readContract({
    address: market,
    abi: cometAbi,
    functionName: fn,
  })) as boolean;
  if (paused) {
    throw new Error(
      `Compound V3 market ${market} on ${chain} has ${action} paused by governance (${fn}=true). ` +
        `Refusing to prepare the transaction — it would revert with Paused() on send. ` +
        `Wait for governance to flip the pause flag off before retrying.`
    );
  }
}

export async function buildCompoundSupply(p: PrepareCompoundSupplyArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const asset = p.asset as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  await assertCometActionAllowed(chain, market, "supply");
  const meta = await resolveMeta(chain, asset);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    amountWei,
    meta.decimals
  );
  const approval = await buildApprovalTx({
    chain,
    wallet,
    asset,
    spender: market,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: meta.symbol,
    spenderLabel: `Compound V3 market ${market}`,
  });
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
    let tail = approval;
    while (tail.next) tail = tail.next;
    tail.next = supplyTx;
    return approval;
  }
  return supplyTx;
}

export async function buildCompoundWithdraw(p: PrepareCompoundWithdrawArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const market = p.market as `0x${string}`;
  const asset = p.asset as `0x${string}`;
  const wallet = p.wallet as `0x${string}`;
  await assertCometActionAllowed(chain, market, "withdraw");
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
  await assertCometActionAllowed(chain, market, "withdraw");
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
  await assertCometActionAllowed(chain, market, "supply");
  const baseToken = await resolveBaseToken(chain, market);
  const meta = await resolveMeta(chain, baseToken);
  const amountWei = p.amount === "max" ? maxUint256 : parseUnits(p.amount, meta.decimals);
  let approval: UnsignedTx | null = null;
  if (amountWei !== maxUint256) {
    const { approvalAmount, display } = resolveApprovalCap(
      p.approvalCap,
      amountWei,
      meta.decimals
    );
    approval = await buildApprovalTx({
      chain,
      wallet,
      asset: baseToken,
      spender: market,
      amountWei,
      approvalAmount,
      approvalDisplay: display,
      symbol: meta.symbol,
      spenderLabel: `Compound V3 market ${market}`,
    });
  }
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
    let tail = approval;
    while (tail.next) tail = tail.next;
    tail.next = repayTx;
    return approval;
  }
  return repayTx;
}
