import { encodeFunctionData, parseUnits, maxUint256 } from "viem";
import { morphoBlueAbi, type MorphoMarketParams } from "../../abis/morpho-blue.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import type {
  PrepareMorphoSupplyArgs,
  PrepareMorphoWithdrawArgs,
  PrepareMorphoBorrowArgs,
  PrepareMorphoRepayArgs,
  PrepareMorphoSupplyCollateralArgs,
  PrepareMorphoWithdrawCollateralArgs,
} from "./schemas.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

function morphoAddress(chain: SupportedChain): `0x${string}` {
  const addr = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]?.morpho
    ?.blue;
  if (!addr) throw new Error(`Morpho Blue is not deployed on ${chain}`);
  return addr as `0x${string}`;
}

async function resolveMarketParams(
  chain: SupportedChain,
  marketId: `0x${string}`
): Promise<MorphoMarketParams> {
  const client = getClient(chain);
  const morpho = morphoAddress(chain);
  const result = (await client.readContract({
    address: morpho,
    abi: morphoBlueAbi,
    functionName: "idToMarketParams",
    args: [marketId],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];
  const [loanToken, collateralToken, oracle, irm, lltv] = result;
  if (loanToken === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Unknown Morpho market id ${marketId} on ${chain}`);
  }
  return { loanToken, collateralToken, oracle, irm, lltv };
}

async function tokenMeta(
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
    description: `Approve ${symbol} for Morpho Blue (unlimited)`,
    decoded: { functionName: "approve", args: { spender, amount: "max" } },
  };
}

function paramsTuple(p: MorphoMarketParams) {
  return {
    loanToken: p.loanToken,
    collateralToken: p.collateralToken,
    oracle: p.oracle,
    irm: p.irm,
    lltv: p.lltv,
  };
}

export async function buildMorphoSupply(p: PrepareMorphoSupplyArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.loanToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const approval = await ensureApprovalTx(
    chain,
    wallet,
    params.loanToken,
    morpho,
    amountWei,
    meta.symbol
  );
  const supplyTx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supply",
      args: [paramsTuple(params), amountWei, 0n, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description: `Supply ${p.amount} ${meta.symbol} to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "supply",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
  };
  if (approval) {
    approval.next = supplyTx;
    return approval;
  }
  return supplyTx;
}

export async function buildMorphoWithdraw(p: PrepareMorphoWithdrawArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.loanToken);
  // "max" withdraw is encoded as shares=MaxUint256/2 would exceed position; safer to ask by assets with
  // a very large number. Morpho reverts on overdraw, so callers should read their position first.
  // Here we only support explicit amounts for withdraw.
  if (p.amount === "max") {
    throw new Error(
      `"max" is not supported for Morpho withdraw — read position and pass an explicit amount.`
    );
  }
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "withdraw",
      args: [paramsTuple(params), amountWei, 0n, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Withdraw ${p.amount} ${meta.symbol} from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "withdraw",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
  };
}

export async function buildMorphoBorrow(p: PrepareMorphoBorrowArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.loanToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "borrow",
      args: [paramsTuple(params), amountWei, 0n, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Borrow ${p.amount} ${meta.symbol} from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "borrow",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
  };
}

export async function buildMorphoRepay(p: PrepareMorphoRepayArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.loanToken);
  if (p.amount === "max") {
    throw new Error(
      `"max" is not supported for Morpho repay — read borrowShares and pass an explicit amount.`
    );
  }
  const amountWei = parseUnits(p.amount, meta.decimals);
  const approval = await ensureApprovalTx(
    chain,
    wallet,
    params.loanToken,
    morpho,
    amountWei,
    meta.symbol
  );
  const repayTx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "repay",
      args: [paramsTuple(params), amountWei, 0n, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description: `Repay ${p.amount} ${meta.symbol} to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "repay",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
  };
  if (approval) {
    approval.next = repayTx;
    return approval;
  }
  return repayTx;
}

export async function buildMorphoSupplyCollateral(
  p: PrepareMorphoSupplyCollateralArgs
): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.collateralToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const approval = await ensureApprovalTx(
    chain,
    wallet,
    params.collateralToken,
    morpho,
    amountWei,
    meta.symbol
  );
  const tx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supplyCollateral",
      args: [paramsTuple(params), amountWei, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description: `Supply ${p.amount} ${meta.symbol} as collateral to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "supplyCollateral",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
  };
  if (approval) {
    approval.next = tx;
    return approval;
  }
  return tx;
}

export async function buildMorphoWithdrawCollateral(
  p: PrepareMorphoWithdrawCollateralArgs
): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await tokenMeta(chain, params.collateralToken);
  if (p.amount === "max") {
    throw new Error(
      `"max" is not supported for Morpho withdrawCollateral — read position.collateral and pass an explicit amount.`
    );
  }
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "withdrawCollateral",
      args: [paramsTuple(params), amountWei, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Withdraw ${p.amount} ${meta.symbol} collateral from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "withdrawCollateral",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
  };
}
