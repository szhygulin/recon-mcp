import {
  TRONGRID_BASE_URL,
  TRX_DECIMALS,
  TRON_TOKENS,
  isTronAddress,
} from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { issueTronHandle } from "../../signing/tron-tx-store.js";
import { encodeTrc20TransferParam } from "./address.js";
import type { UnsignedTronTx } from "../../types/index.js";

/**
 * Default fee limit (100 TRX) for TRC-20 transfers. TronGrid's
 * /wallet/triggersmartcontract rejects without a fee_limit. 100 TRX is the
 * Ledger Live / Tronlink default and far above typical energy burn for a
 * USDT-TRC20 transfer (~15 TRX at current mainnet energy price).
 */
const DEFAULT_FEE_LIMIT_SUN = 100_000_000n;

/** Hardcoded TRC-20 decimals for canonical stablecoins (same as balances.ts). */
const TOKEN_DECIMALS: Record<keyof typeof TRON_TOKENS, number> = {
  USDT: 6,
  USDC: 6,
  USDD: 18,
  TUSD: 18,
};
const SYMBOL_BY_CONTRACT: Record<string, keyof typeof TRON_TOKENS> = Object.fromEntries(
  (Object.entries(TRON_TOKENS) as [keyof typeof TRON_TOKENS, string][]).map(
    ([symbol, addr]) => [addr, symbol]
  )
);

/**
 * Parse a human amount ("1.5") into integer base units given `decimals`.
 * Mirrors viem's `parseUnits` but doesn't import viem (keeps the TRON
 * path free of EVM-only helpers).
 */
function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount "${value}" — expected a positive decimal number.`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${value}" has more decimals than token precision (${decimals}). Truncate or round first.`
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole + padded);
}

async function trongridPost<T>(
  path: string,
  body: Record<string, unknown>,
  apiKey: string | undefined
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetch(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * TronGrid surfaces errors in two shapes depending on endpoint:
 *   - /wallet/createtransaction and /wallet/withdrawbalance: `{Error: "..."}`
 *     at the top level on failure.
 *   - /wallet/triggersmartcontract: always returns 200; look at
 *     `result.result === true` and `result.message`.
 * Normalizing both to exceptions keeps the tx builders uniform.
 */
interface TrongridDirectTx {
  Error?: string;
  txID?: string;
  raw_data?: unknown;
  raw_data_hex?: string;
  visible?: boolean;
}

interface TrongridTriggerResponse {
  result?: { result?: boolean; message?: string; code?: string };
  transaction?: {
    txID?: string;
    raw_data?: unknown;
    raw_data_hex?: string;
    visible?: boolean;
  };
}

// ----- Native TRX send -----

export interface BuildTronNativeSendArgs {
  from: string;
  to: string;
  amount: string;
}

export async function buildTronNativeSend(
  args: BuildTronNativeSendArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  if (!isTronAddress(args.to)) {
    throw new Error(`"to" is not a valid TRON mainnet address: ${args.to}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    to_address: args.to,
    amount: Number(amountSun),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/createtransaction",
    body,
    apiKey
  );
  if (res.Error) {
    throw new Error(`TronGrid createtransaction failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid createtransaction returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "native_send",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Send ${args.amount} TRX to ${args.to}`,
    decoded: {
      functionName: "TransferContract",
      args: { to: args.to, amount: args.amount, symbol: "TRX" },
    },
  };
  return issueTronHandle(tx);
}

// ----- TRC-20 send -----

export interface BuildTronTokenSendArgs {
  from: string;
  to: string;
  /** Base58 TRC-20 contract address. */
  token: string;
  amount: string;
  /** Override fee limit in TRX (default: 100 TRX). */
  feeLimitTrx?: string;
}

export async function buildTronTokenSend(
  args: BuildTronTokenSendArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  if (!isTronAddress(args.to)) {
    throw new Error(`"to" is not a valid TRON mainnet address: ${args.to}`);
  }
  if (!isTronAddress(args.token)) {
    throw new Error(`"token" is not a valid TRC-20 base58 address: ${args.token}`);
  }

  // Resolve decimals + symbol from the canonical table. Unknown TRC-20s
  // are rejected here in Phase 2 — a proper `trc20.decimals()` on-chain
  // read can land later, but for now we only prepare sends for tokens we
  // can name in the preview (no user-confusing "UNKNOWN token" previews).
  const symbol = SYMBOL_BY_CONTRACT[args.token];
  if (!symbol) {
    throw new Error(
      `Token ${args.token} is not in the canonical TRC-20 set (USDT/USDC/USDD/TUSD). ` +
        `Preparing a send for unknown TRC-20s is not supported in Phase 2 — file a capability ` +
        `request if you need this.`
    );
  }
  const decimals = TOKEN_DECIMALS[symbol];
  const amountBase = parseUnits(args.amount, decimals);
  if (amountBase <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const feeLimitSun = args.feeLimitTrx
    ? parseUnits(args.feeLimitTrx, TRX_DECIMALS)
    : DEFAULT_FEE_LIMIT_SUN;

  const parameter = encodeTrc20TransferParam(args.to, amountBase);
  const body = {
    owner_address: args.from,
    contract_address: args.token,
    function_selector: "transfer(address,uint256)",
    parameter,
    fee_limit: Number(feeLimitSun),
    call_value: 0,
    visible: true,
  };
  const apiKey = resolveTronApiKey(readUserConfig());
  const res = await trongridPost<TrongridTriggerResponse>(
    "/wallet/triggersmartcontract",
    body,
    apiKey
  );
  if (!res.result?.result) {
    throw new Error(
      `TronGrid triggersmartcontract failed: ${res.result?.message ?? "unknown error"}`
    );
  }
  const ttx = res.transaction;
  if (!ttx?.txID || !ttx.raw_data_hex) {
    throw new Error("TronGrid triggersmartcontract returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "trc20_send",
    from: args.from,
    txID: ttx.txID,
    rawData: ttx.raw_data,
    rawDataHex: ttx.raw_data_hex,
    description: `Send ${args.amount} ${symbol} to ${args.to}`,
    decoded: {
      functionName: "transfer(address,uint256)",
      args: {
        to: args.to,
        amount: args.amount,
        symbol,
        contract: args.token,
      },
    },
    feeLimitSun: feeLimitSun.toString(),
  };
  return issueTronHandle(tx);
}

// ----- Stake 2.0: Freeze / Unfreeze / WithdrawExpireUnfreeze -----

/**
 * TRON Stake 2.0 resource types. Lowercase on our API surface for consistency
 * with the staking reader (`get_tron_staking` returns `type: "bandwidth"|"energy"`).
 * TronGrid expects uppercase, so we uppercase at the edge.
 */
export type TronResource = "bandwidth" | "energy";

export interface BuildTronFreezeArgs {
  from: string;
  amount: string;
  resource: TronResource;
}

export async function buildTronFreeze(
  args: BuildTronFreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    frozen_balance: Number(amountSun),
    resource: args.resource.toUpperCase(),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/freezebalancev2",
    body,
    apiKey
  );
  if (res.Error) {
    throw new Error(`TronGrid freezebalancev2 failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid freezebalancev2 returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "freeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Freeze ${args.amount} TRX for ${args.resource} (Stake 2.0)`,
    decoded: {
      functionName: "FreezeBalanceV2Contract",
      args: { owner: args.from, amount: args.amount, resource: args.resource },
    },
  };
  return issueTronHandle(tx);
}

export interface BuildTronUnfreezeArgs {
  from: string;
  amount: string;
  resource: TronResource;
}

export async function buildTronUnfreeze(
  args: BuildTronUnfreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    unfreeze_balance: Number(amountSun),
    resource: args.resource.toUpperCase(),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/unfreezebalancev2",
    body,
    apiKey
  );
  if (res.Error) {
    // Common failure: "less than frozen balance" when the caller asks to
    // unfreeze more than they've frozen for that resource type. Surface
    // TronGrid's message verbatim so the agent can relay it.
    throw new Error(`TronGrid unfreezebalancev2 failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid unfreezebalancev2 returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "unfreeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Unfreeze ${args.amount} TRX from ${args.resource} — 14-day unstaking cooldown begins`,
    decoded: {
      functionName: "UnfreezeBalanceV2Contract",
      args: { owner: args.from, amount: args.amount, resource: args.resource },
    },
  };
  return issueTronHandle(tx);
}

export interface BuildTronWithdrawExpireUnfreezeArgs {
  from: string;
}

export async function buildTronWithdrawExpireUnfreeze(
  args: BuildTronWithdrawExpireUnfreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/withdrawexpireunfreeze",
    { owner_address: args.from, visible: true },
    apiKey
  );
  if (res.Error) {
    // Common: "no expire unfreeze" when no unfrozenV2 slices have matured.
    // Pair with get_tron_staking to check pendingUnfreezes[].unlockAt first.
    throw new Error(`TronGrid withdrawexpireunfreeze failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid withdrawexpireunfreeze returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "withdraw_expire_unfreeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Withdraw all expired unfreezes back to liquid TRX for ${args.from}`,
    decoded: {
      functionName: "WithdrawExpireUnfreezeContract",
      args: { owner: args.from },
    },
  };
  return issueTronHandle(tx);
}

// ----- Claim voting rewards (WithdrawBalance) -----

export interface BuildTronClaimRewardsArgs {
  from: string;
}

export async function buildTronClaimRewards(
  args: BuildTronClaimRewardsArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/withdrawbalance",
    { owner_address: args.from, visible: true },
    apiKey
  );
  if (res.Error) {
    // Common case: "WithdrawBalance not allowed, need 24 hours since last Withdraw"
    // — TRON enforces a 24h rate limit on claims. Surface TronGrid's message verbatim.
    throw new Error(`TronGrid withdrawbalance failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid withdrawbalance returned no transaction — unexpected shape.");
  }

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "claim_rewards",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Claim accumulated TRON voting rewards to ${args.from}`,
    decoded: {
      functionName: "WithdrawBalanceContract",
      args: { owner: args.from },
    },
  };
  return issueTronHandle(tx);
}
