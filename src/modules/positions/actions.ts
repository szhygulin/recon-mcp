import { encodeFunctionData, parseUnits, maxUint256, formatUnits } from "viem";
import { aavePoolAbi } from "../../abis/aave-pool.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { getAavePoolAddress } from "./aave.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * "Native" pseudo-addresses some UIs pass to mean "the chain's native coin".
 * Aave V3 Pool does NOT accept these — supply()/repay() expect a real ERC-20.
 * Native ETH must be wrapped (WETH) first, or routed through Aave's
 * WrappedTokenGateway contract, which we don't wire up here.
 */
const NATIVE_PSEUDOADDRS = new Set<string>([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

function assertNotNativePseudoaddr(asset: `0x${string}`, op: string): void {
  if (NATIVE_PSEUDOADDRS.has(asset.toLowerCase())) {
    throw new Error(
      `Aave V3 Pool.${op} does not accept the native coin pseudoaddress ${asset}. ` +
        "Pass the wrapped-token address (e.g. WETH on Ethereum: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2) " +
        "instead, or wrap native → WETH in a separate tx first."
    );
  }
}

/**
 * Build an approve(spender, amount) tx, optionally preceded by approve(0).
 * Some ERC-20s (notably USDT on Ethereum) revert on approve(nonzero) when the
 * current allowance is already nonzero — the caller must zero it out first.
 * We always emit the reset when prior allowance is nonzero; it's a few-thousand-
 * gas no-op on well-behaved tokens and avoids maintaining an allowlist.
 */
async function ensureApproval(
  chain: SupportedChain,
  owner: `0x${string}`,
  spender: `0x${string}`,
  asset: `0x${string}`,
  amount: bigint,
  symbol: string,
  _decimals: number
): Promise<UnsignedTx | null> {
  const client = getClient(chain);
  const allowance = (await client.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (allowance >= amount) return null;

  const approveTx: UnsignedTx = {
    chain,
    to: asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: "0",
    from: owner,
    description: `Approve ${symbol} for Aave V3 Pool (exact amount)`,
    decoded: {
      functionName: "approve",
      args: { spender, amount: formatUnits(amount, _decimals) },
    },
  };

  if (allowance > 0n) {
    // USDT-style reset: chain approve(0) → approve(amount).
    const resetTx: UnsignedTx = {
      chain,
      to: asset,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, 0n],
      }),
      value: "0",
      from: owner,
      description: `Reset ${symbol} allowance to 0 (required by USDT-style tokens before re-approval)`,
      decoded: { functionName: "approve", args: { spender, amount: "0" } },
      next: approveTx,
    };
    return resetTx;
  }

  return approveTx;
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
  assertNotNativePseudoaddr(p.asset, "supply");
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
    // Walk to the tail of the approval chain (may be reset→approve) and attach supply.
    let tail = approval;
    while (tail.next) tail = tail.next;
    tail.next = supplyTx;
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

/** Aave V3 stable-rate borrowing is disabled on all production markets. We only support variable. */
const VARIABLE_RATE_MODE = 2n;

export async function buildAaveBorrow(p: AaveActionParams): Promise<UnsignedTx> {
  const pool = await getAavePoolAddress(p.chain);
  const amountWei = parseAmountFriendly(p.amount, p.decimals);
  return {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "borrow",
      args: [p.asset, amountWei, VARIABLE_RATE_MODE, 0, p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Borrow ${p.amount} ${p.symbol} from Aave V3 on ${p.chain} (variable rate)`,
    decoded: {
      functionName: "borrow",
      args: {
        asset: p.asset,
        amount: p.amount,
        rate: "variable",
        onBehalfOf: p.wallet,
      },
    },
  };
}

/**
 * Look up the user's current variable debt for an asset by querying the
 * variableDebtToken.balanceOf(wallet). Used for repay-max so we can size an
 * approval that covers the actual debt (plus a buffer for interest that
 * accrues between preparing and signing).
 */
async function getCurrentVariableDebt(
  chain: SupportedChain,
  wallet: `0x${string}`,
  asset: `0x${string}`
): Promise<{ debt: bigint; variableDebtToken: `0x${string}` }> {
  const pool = await getAavePoolAddress(chain);
  const client = getClient(chain);
  const reserve = (await client.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getReserveData",
    args: [asset],
  })) as { variableDebtTokenAddress: `0x${string}` };
  const variableDebtToken = reserve.variableDebtTokenAddress;
  const debt = (await client.readContract({
    address: variableDebtToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;
  return { debt, variableDebtToken };
}

export async function buildAaveRepay(p: AaveActionParams): Promise<UnsignedTx> {
  assertNotNativePseudoaddr(p.asset, "repay");
  const pool = await getAavePoolAddress(p.chain);
  let amountWei: bigint;
  let approvalAmount: bigint;
  if (p.amount === "max") {
    amountWei = maxUint256;
    // Aave caps the repay at the user's actual debt internally, but transferFrom
    // still needs allowance to cover it. Size the approval to current debt + 1%
    // buffer so we don't revert because interest accrued between prepare and sign.
    const { debt } = await getCurrentVariableDebt(p.chain, p.wallet, p.asset);
    if (debt === 0n) {
      throw new Error(
        `No variable-rate debt for ${p.symbol} on Aave V3 ${p.chain} — nothing to repay. ` +
          "If you borrowed at stable rate historically, repay via the Aave UI (legacy flow)."
      );
    }
    approvalAmount = (debt * 101n) / 100n;
  } else {
    amountWei = parseAmountFriendly(p.amount, p.decimals);
    approvalAmount = amountWei;
  }

  const approval = await ensureApproval(
    p.chain,
    p.wallet,
    pool,
    p.asset,
    approvalAmount,
    p.symbol,
    p.decimals
  );

  const repayTx: UnsignedTx = {
    chain: p.chain,
    to: pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [p.asset, amountWei, VARIABLE_RATE_MODE, p.wallet],
    }),
    value: "0",
    from: p.wallet,
    description: `Repay ${p.amount === "max" ? "all" : p.amount} ${p.symbol} on Aave V3 ${p.chain} (variable rate)`,
    decoded: {
      functionName: "repay",
      args: {
        asset: p.asset,
        amount: p.amount,
        rate: "variable",
        onBehalfOf: p.wallet,
      },
    },
  };

  if (approval) {
    let tail = approval;
    while (tail.next) tail = tail.next;
    tail.next = repayTx;
    return approval;
  }
  return repayTx;
}

export { parseAmountFriendly, formatUnits };
