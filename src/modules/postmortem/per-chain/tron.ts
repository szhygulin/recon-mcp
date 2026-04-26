/**
 * TRON `explain_tx` implementation.
 *
 * Uses the same TronGrid endpoints as `getTronTransactionStatus`:
 *   - `/wallet/gettransactionbyid` — signed envelope (raw_data.contract,
 *     ret[].contractRet for native txs).
 *   - `/wallet/gettransactioninfobyid` — block number, fee, smart-
 *     contract receipt (SUCCESS / REVERT / OUT_OF_ENERGY), and `log` —
 *     the array of decoded events.
 *
 * Coverage in v1: native TRX transfers (TransferContract), TRC-20
 * transfers (TriggerSmartContract emitting Transfer events on a TRC-20
 * contract). Smart-contract calls beyond TRC-20 (e.g. TRC-721, JustLend
 * actions) surface as a generic "TriggerSmartContract on <addr>" step
 * — the contract type is decoded but per-call event parsing beyond
 * Transfer is out of scope.
 */

import { fetchWithTimeout } from "../../../data/http.js";
import {
  TRONGRID_BASE_URL,
  TRX_DECIMALS,
} from "../../../config/tron.js";
import {
  resolveTronApiKey,
  readUserConfig,
} from "../../../config/user-config.js";
import { formatUnits } from "../../../data/format.js";
import { getDefillamaCoinPrice } from "../../../data/prices.js";
import type {
  ExplainTxApprovalChange,
  ExplainTxBalanceChange,
  ExplainTxResult,
  ExplainTxStep,
} from "../schemas.js";

/**
 * TRON addresses on TronGrid arrive in two shapes: hex (`41` + 20-byte
 * EVM-style address, 42 hex chars) on raw_data fields, and EVM-padded
 * 32-byte topics (64 hex chars, last 20 bytes are the address) in
 * event logs. We normalize everything to the hex form for the
 * post-mortem readout — base58check encoding requires double-sha256 +
 * a base58 alphabet sweep, which adds dep weight for a forensic
 * surface where the agent's user is likely cross-referencing TronScan
 * anyway. Hex with the `41` prefix is unambiguous and decodable both
 * ways.
 */
function topicToTronHex(topic: string): string {
  return `41${topic.slice(-40)}`.toLowerCase();
}

function logAddressToTronHex(addr: string | undefined): string {
  if (!addr) return "";
  // Some TronGrid responses include the leading 41, others don't.
  // Normalize: pad to 42 chars total with 41 prefix.
  const lower = addr.toLowerCase();
  if (lower.length === 42 && lower.startsWith("41")) return lower;
  if (lower.length === 40) return `41${lower}`;
  return lower;
}

function rawAddressToTronHex(addr: string | undefined): string {
  if (!addr) return "";
  return addr.toLowerCase();
}

const TRANSFER_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC =
  "8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
// MAX_UINT256 minus a 0.01% sliver — same threshold as EVM.
const MAX_UINT256 = (1n << 256n) - 1n;
const UNLIMITED_THRESHOLD = MAX_UINT256 - MAX_UINT256 / 10_000n;

interface GetTxByIdResponse {
  txID?: string;
  blockTimeStamp?: number;
  raw_data?: {
    timestamp?: number;
    contract?: Array<{
      type?: string;
      parameter?: {
        value?: {
          owner_address?: string;
          to_address?: string;
          contract_address?: string;
          amount?: number;
          data?: string;
        };
      };
    }>;
  };
  ret?: Array<{ contractRet?: string }>;
}

interface TronLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface GetTxInfoResponse {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  fee?: number;
  receipt?: {
    result?: string;
    energy_usage?: number;
    energy_usage_total?: number;
    net_usage?: number;
  };
  contract_address?: string;
  log?: TronLog[];
  contractResult?: string[];
}

async function trongridPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `TronGrid ${path} returned ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

interface DecodedTransfer {
  contract: string;
  from: string;
  to: string;
  value: bigint;
}

interface DecodedApproval {
  contract: string;
  owner: string;
  spender: string;
  value: bigint;
}

function decodeTransferLog(log: TronLog): DecodedTransfer | null {
  const topics = log.topics ?? [];
  if (topics.length < 3) return null;
  if ((topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!log.data || log.data.length === 0) return null;
  const value = BigInt("0x" + log.data);
  return {
    contract: logAddressToTronHex(log.address),
    from: topicToTronHex(topics[1]),
    to: topicToTronHex(topics[2]),
    value,
  };
}

function decodeApprovalLog(log: TronLog): DecodedApproval | null {
  const topics = log.topics ?? [];
  if (topics.length !== 3) return null;
  if ((topics[0] ?? "").toLowerCase() !== APPROVAL_TOPIC) return null;
  if (!log.data || log.data.length === 0) return null;
  const value = BigInt("0x" + log.data);
  return {
    contract: logAddressToTronHex(log.address),
    owner: topicToTronHex(topics[1]),
    spender: topicToTronHex(topics[2]),
    value,
  };
}

interface TrcMetaCache {
  symbol?: string;
  decimals?: number;
}

/**
 * Fetch TRC-20 metadata via triggerconstantcontract. Best-effort —
 * returns empty object on failure (the post-mortem still functions
 * with a generic "TOKEN" symbol).
 */
async function fetchTrc20Meta(addressBase58: string): Promise<TrcMetaCache> {
  try {
    const symbolRes = await trongridPost<{ constant_result?: string[] }>(
      "/wallet/triggerconstantcontract",
      {
        owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", // burn address — read-only
        contract_address: addressBase58,
        function_selector: "symbol()",
        visible: true,
      },
    );
    const decimalsRes = await trongridPost<{ constant_result?: string[] }>(
      "/wallet/triggerconstantcontract",
      {
        owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        contract_address: addressBase58,
        function_selector: "decimals()",
        visible: true,
      },
    );
    const symbolHex = symbolRes.constant_result?.[0];
    const decimalsHex = decimalsRes.constant_result?.[0];
    return {
      ...(symbolHex ? { symbol: parseSolidityString(symbolHex) } : {}),
      ...(decimalsHex ? { decimals: Number(BigInt(`0x${decimalsHex}`)) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Decode an ABI-encoded `string` returned by a `view` function. The
 * encoding is offset(32) || length(32) || data || padding.
 */
function parseSolidityString(hex: string): string {
  if (hex.length < 128) return "";
  const lengthHex = hex.slice(64, 128);
  const length = Number(BigInt(`0x${lengthHex}`));
  if (length === 0 || length > 64) return "";
  const dataHex = hex.slice(128, 128 + length * 2);
  let out = "";
  for (let i = 0; i < dataHex.length; i += 2) {
    const code = parseInt(dataHex.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out;
}

export interface TronPostmortemArgs {
  hash: string;
  /** Wallet to compute balance-changes from. Defaults to tx sender (owner_address). */
  perspective?: string;
}

export async function tronPostmortem(
  args: TronPostmortemArgs,
): Promise<Omit<ExplainTxResult, "narrative"> & { summary: string }> {
  const normalized = args.hash.replace(/^0x/, "").toLowerCase();

  const [byId, info] = await Promise.all([
    trongridPost<GetTxByIdResponse>("/wallet/gettransactionbyid", {
      value: normalized,
    }),
    trongridPost<GetTxInfoResponse>("/wallet/gettransactioninfobyid", {
      value: normalized,
    }),
  ]);

  if (!byId?.txID && !info?.blockNumber) {
    throw new Error(
      `TRON tx ${normalized} not visible to TronGrid. May be too fresh, or the txID is wrong.`,
    );
  }

  const contractWrap = byId.raw_data?.contract?.[0];
  const contractType = contractWrap?.type ?? "Unknown";
  const cParam = contractWrap?.parameter?.value ?? {};

  const senderHex = rawAddressToTronHex(cParam.owner_address);
  const perspective = (args.perspective ?? senderHex).toLowerCase();

  const receiptResult = info.receipt?.result;
  const contractRet = byId.ret?.[0]?.contractRet;
  const successTag =
    receiptResult === "SUCCESS" ||
    (!receiptResult && contractRet === "SUCCESS");
  const status: "success" | "failed" = successTag ? "success" : "failed";

  // Decode TRON logs (events emitted by smart contracts in TriggerSmartContract).
  const logs = info.log ?? [];
  const transfers = logs
    .map(decodeTransferLog)
    .filter((t): t is DecodedTransfer => t !== null);
  const approvals = logs
    .map(decodeApprovalLog)
    .filter((a): a is DecodedApproval => a !== null);

  // Resolve TRC-20 metadata for unique contracts.
  const uniqueContracts = Array.from(
    new Set([
      ...transfers.map((t) => t.contract),
      ...approvals.map((a) => a.contract),
    ]),
  ).filter((c) => c.length > 0);
  const metaByContract = new Map<string, TrcMetaCache>();
  await Promise.all(
    uniqueContracts.map(async (c) => {
      metaByContract.set(c, await fetchTrc20Meta(c));
    }),
  );

  // Build steps.
  const steps: ExplainTxStep[] = [];
  if (contractType === "TransferContract") {
    const toHex = rawAddressToTronHex(cParam.to_address);
    const amountSun = BigInt(cParam.amount ?? 0);
    steps.push({
      kind: "native_transfer",
      label: "TRX",
      detail: `${formatUnits(amountSun, TRX_DECIMALS)} TRX from ${senderHex} to ${toHex}`,
    });
  } else if (contractType === "TriggerSmartContract") {
    const contractAddrHex = rawAddressToTronHex(cParam.contract_address);
    const dataHex = cParam.data ?? "";
    const selector =
      dataHex && dataHex.length >= 8 ? `0x${dataHex.slice(0, 8)}` : null;
    steps.push({
      kind: "call",
      label: selector ? `selector ${selector}` : "TriggerSmartContract",
      detail: `Smart-contract call to ${contractAddrHex}${selector ? ` (selector ${selector})` : ""}`,
      programOrContract: contractAddrHex,
    });
  } else if (contractType !== "Unknown") {
    steps.push({
      kind: "call",
      label: contractType,
      detail: `${contractType} system contract`,
    });
  }
  for (const t of transfers) {
    const meta = metaByContract.get(t.contract) ?? {};
    const symbol = meta.symbol ?? "TRC20";
    const decimals = meta.decimals ?? 6;
    steps.push({
      kind: "event",
      label: "Transfer",
      detail: `${formatUnits(t.value, decimals)} ${symbol} from ${t.from} to ${t.to}`,
      programOrContract: t.contract,
    });
  }
  for (const a of approvals) {
    const meta = metaByContract.get(a.contract) ?? {};
    const symbol = meta.symbol ?? "TRC20";
    const decimals = meta.decimals ?? 6;
    const isUnlimited = a.value >= UNLIMITED_THRESHOLD;
    const allowanceStr = isUnlimited
      ? "unlimited"
      : formatUnits(a.value, decimals);
    steps.push({
      kind: "event",
      label: "Approval",
      detail: `${a.owner} grants ${a.spender} an allowance of ${allowanceStr} ${symbol}`,
      programOrContract: a.contract,
    });
  }

  // Balance deltas FROM PERSPECTIVE.
  const balanceDeltas = new Map<
    string,
    { delta: bigint; symbol: string; decimals: number }
  >();
  if (contractType === "TransferContract") {
    const toHex = rawAddressToTronHex(cParam.to_address);
    const amountSun = BigInt(cParam.amount ?? 0);
    let nativeDelta = 0n;
    if (senderHex.toLowerCase() === perspective) nativeDelta -= amountSun;
    if (toHex.toLowerCase() === perspective) nativeDelta += amountSun;
    if (nativeDelta !== 0n) {
      balanceDeltas.set("native", {
        delta: nativeDelta,
        symbol: "TRX",
        decimals: TRX_DECIMALS,
      });
    }
  }
  for (const t of transfers) {
    const meta = metaByContract.get(t.contract) ?? {};
    const isFrom = t.from.toLowerCase() === perspective;
    const isTo = t.to.toLowerCase() === perspective;
    if (!isFrom && !isTo) continue;
    const prev = balanceDeltas.get(t.contract) ?? {
      delta: 0n,
      symbol: meta.symbol ?? "TRC20",
      decimals: meta.decimals ?? 6,
    };
    prev.delta += isTo ? t.value : 0n;
    prev.delta -= isFrom ? t.value : 0n;
    balanceDeltas.set(t.contract, prev);
  }

  // Fee math. TronGrid surfaces `fee` in SUN (1e-6 TRX). Subtract from
  // sender's native delta when perspective === sender.
  const feeSun = BigInt(info.fee ?? 0);
  const feeNative = formatUnits(feeSun, TRX_DECIMALS);

  let feeUsd: number | undefined;
  const trxPriceEntry = await getDefillamaCoinPrice("tron").catch(
    () => undefined,
  );
  const trxPrice = trxPriceEntry?.price;
  if (trxPrice !== undefined) {
    feeUsd = round2(Number(feeNative) * trxPrice);
  }

  if (perspective === senderHex.toLowerCase() && feeSun > 0n) {
    const existing = balanceDeltas.get("native");
    if (existing) {
      existing.delta -= feeSun;
    } else {
      balanceDeltas.set("native", {
        delta: -feeSun,
        symbol: "TRX",
        decimals: TRX_DECIMALS,
      });
    }
  }

  const balanceChanges: ExplainTxBalanceChange[] = [];
  for (const [token, info2] of balanceDeltas) {
    const formatted = formatUnits(info2.delta, info2.decimals);
    const num = Number(formatted);
    let priceUsd: number | undefined;
    if (token === "native") {
      priceUsd = trxPrice;
    }
    balanceChanges.push({
      symbol: info2.symbol,
      token,
      delta: formatted,
      deltaApprox: num,
      ...(priceUsd !== undefined && Number.isFinite(num)
        ? { valueUsd: round2(num * priceUsd) }
        : {}),
    });
  }

  // Approval changes from perspective.
  const approvalChanges: ExplainTxApprovalChange[] = [];
  for (const a of approvals) {
    if (a.owner.toLowerCase() !== perspective) continue;
    const meta = metaByContract.get(a.contract) ?? {};
    const isUnlimited = a.value >= UNLIMITED_THRESHOLD;
    const newAllowance = isUnlimited
      ? "unlimited"
      : formatUnits(a.value, meta.decimals ?? 6);
    approvalChanges.push({
      ...(meta.symbol ? { symbol: meta.symbol } : {}),
      token: a.contract,
      spender: a.spender,
      newAllowance,
      isUnlimited,
    });
  }

  // To-field for the response.
  const toField =
    contractType === "TransferContract"
      ? rawAddressToTronHex(cParam.to_address) || undefined
      : contractType === "TriggerSmartContract"
        ? rawAddressToTronHex(cParam.contract_address) || undefined
        : undefined;

  const blockTimeIso = info.blockTimeStamp
    ? new Date(info.blockTimeStamp).toISOString()
    : byId.blockTimeStamp
      ? new Date(byId.blockTimeStamp).toISOString()
      : undefined;

  let summary: string;
  if (status === "failed") {
    summary = `TRON tx FAILED (${receiptResult ?? contractRet ?? "unknown reason"}). ${feeNative} TRX paid as fee.`;
  } else if (contractType === "TransferContract") {
    const toHex = rawAddressToTronHex(cParam.to_address) || "?";
    const amountSun = BigInt(cParam.amount ?? 0);
    summary = `${formatUnits(amountSun, TRX_DECIMALS)} TRX sent from ${senderHex} to ${toHex}.`;
  } else if (contractType === "TriggerSmartContract") {
    summary = `TRON smart-contract call (${transfers.length} transfer event(s), ${approvals.length} approval(s)).`;
  } else {
    summary = `TRON ${contractType} transaction.`;
  }

  return {
    chain: "tron",
    hash: normalized,
    from: senderHex,
    ...(toField ? { to: toField } : {}),
    perspective,
    ...(info.blockNumber !== undefined
      ? { blockNumber: info.blockNumber.toString() }
      : {}),
    ...(blockTimeIso ? { blockTimeIso } : {}),
    status,
    feeNative,
    feeNativeSymbol: "TRX",
    ...(feeUsd !== undefined ? { feeUsd } : {}),
    summary,
    steps,
    balanceChanges,
    approvalChanges,
    heuristics: [],
    notes: [],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
