import { encodeFunctionData, parseUnits, maxUint256, formatUnits } from "viem";
import { aavePoolAbi } from "../../abis/aave-pool.js";
import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { getAavePoolAddress } from "./aave.js";
import { buildApprovalTx, resolveApprovalCap } from "../shared/approval.js";
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
 * Aave V3 ReserveConfiguration bitmap — the bits we read on the prepare path.
 * Docs: https://docs.aave.com/developers/core-contracts/pool#getconfiguration
 *   bit 56: ACTIVE — false means the reserve is disabled entirely.
 *   bit 57: FROZEN — existing withdraws/repays allowed, new supply/borrow blocked.
 *   bit 60: PAUSED — all supply/withdraw/borrow/repay disabled.
 */
const BIT_ACTIVE = 56n;
const BIT_FROZEN = 57n;
const BIT_PAUSED = 60n;

function readBit(data: bigint, bit: bigint): boolean {
  return ((data >> bit) & 1n) === 1n;
}

/**
 * Refuse to build a tx when the reserve's pause/frozen/inactive state would
 * cause the action to revert on send. One `getReserveData` read per prepare.
 *
 * Paused → every action blocked. Frozen → only supply/borrow blocked (users
 * can still wind down existing positions via withdraw/repay). Inactive is a
 * hard stop for everything.
 */
async function assertAaveActionAllowed(
  chain: SupportedChain,
  asset: `0x${string}`,
  action: "supply" | "withdraw" | "borrow" | "repay"
): Promise<void> {
  const pool = await getAavePoolAddress(chain);
  const client = getClient(chain);
  const reserve = (await client.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getReserveData",
    args: [asset],
  })) as { configuration: { data: bigint } };
  const data = reserve.configuration.data;
  const active = readBit(data, BIT_ACTIVE);
  const frozen = readBit(data, BIT_FROZEN);
  const paused = readBit(data, BIT_PAUSED);
  if (!active) {
    throw new Error(
      `Aave V3 reserve ${asset} on ${chain} is not active. Refusing to prepare ${action}; it would revert on send.`
    );
  }
  if (paused) {
    throw new Error(
      `Aave V3 reserve ${asset} on ${chain} is paused by governance. All supply/withdraw/borrow/repay are blocked until Aave governance unpauses. Refusing to prepare ${action}.`
    );
  }
  if (frozen && (action === "supply" || action === "borrow")) {
    throw new Error(
      `Aave V3 reserve ${asset} on ${chain} is frozen. New supplies and borrows are blocked (withdraws and repays still work). Refusing to prepare ${action}.`
    );
  }
}

interface AaveActionParams {
  wallet: `0x${string}`;
  chain: SupportedChain;
  asset: `0x${string}`;
  amount: string; // human-readable amount ("100.5")
  decimals: number;
  symbol: string;
  /** Optional ERC-20 approval cap — see resolveApprovalCap for semantics. */
  approvalCap?: string;
}

function parseAmountFriendly(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

export async function buildAaveSupply(p: AaveActionParams): Promise<UnsignedTx> {
  assertNotNativePseudoaddr(p.asset, "supply");
  await assertAaveActionAllowed(p.chain, p.asset, "supply");
  const pool = await getAavePoolAddress(p.chain);
  const amountWei = parseAmountFriendly(p.amount, p.decimals);
  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    amountWei,
    p.decimals
  );
  const approval = await buildApprovalTx({
    chain: p.chain,
    wallet: p.wallet,
    asset: p.asset,
    spender: pool,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: p.symbol,
    spenderLabel: "Aave V3 Pool",
  });

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
  await assertAaveActionAllowed(p.chain, p.asset, "withdraw");
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
  await assertAaveActionAllowed(p.chain, p.asset, "borrow");
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
  await assertAaveActionAllowed(p.chain, p.asset, "repay");
  const pool = await getAavePoolAddress(p.chain);
  let amountWei: bigint;
  let neededForApproval: bigint;
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
    neededForApproval = (debt * 101n) / 100n;
  } else {
    amountWei = parseAmountFriendly(p.amount, p.decimals);
    neededForApproval = amountWei;
  }

  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    neededForApproval,
    p.decimals
  );
  const approval = await buildApprovalTx({
    chain: p.chain,
    wallet: p.wallet,
    asset: p.asset,
    spender: pool,
    amountWei: neededForApproval,
    approvalAmount,
    approvalDisplay: display,
    symbol: p.symbol,
    spenderLabel: "Aave V3 Pool",
  });

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
