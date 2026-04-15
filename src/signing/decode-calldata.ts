import {
  decodeFunctionData,
  formatUnits,
  getAddress,
  type Abi,
  type AbiFunction,
} from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { aavePoolAbi } from "../abis/aave-pool.js";
import { cometAbi } from "../abis/compound-comet.js";
import { morphoBlueAbi } from "../abis/morpho-blue.js";
import { stETHAbi, lidoWithdrawalQueueAbi } from "../abis/lido.js";
import { eigenStrategyManagerAbi } from "../abis/eigenlayer-strategy-manager.js";
import { uniswapPositionManagerAbi } from "../abis/uniswap-position-manager.js";
import { CONTRACTS, NATIVE_SYMBOL, TOKEN_META } from "../config/contracts.js";
import type {
  DecodedArg,
  HumanDecode,
  SupportedChain,
  UnsignedTronTx,
} from "../types/index.js";

/**
 * Local ABI-based calldata decoder. Never touches the network — uses only
 * the static ABI registry under `src/abis/` and the curated destination map
 * in `CONTRACTS`. Any destination we don't recognize produces a
 * `source: "none"` result, which the chat render translates into a "unknown
 * contract — rely on swiss-knife" nudge. This matches the conservative
 * failure mode: when we can't locally decode, we still hand the user the
 * raw calldata and a decoder URL.
 */

const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

type DestinationKind =
  | "aave-v3-pool"
  | "compound-v3-comet"
  | "morpho-blue"
  | "lido-stETH"
  | "lido-withdrawalQueue"
  | "eigenlayer-strategyManager"
  | "uniswap-v3-npm"
  | "known-erc20"
  | "lifi-diamond";

interface Destination {
  kind: DestinationKind;
  /** ABI to use for decoding. `null` means we recognize the contract but have no ABI for decode (LiFi). */
  abi: Abi | null;
}

/**
 * Synchronous destination classifier — shares its allowlist with
 * `pre-sign-check.classifyDestination` but does NOT await anything. Both
 * classifiers walk the same `CONTRACTS` map so the two lists stay in
 * lockstep: anything the pre-sign check accepts, the decoder can at least
 * attempt to decode.
 */
function classifyDestination(chain: SupportedChain, to: `0x${string}`): Destination | null {
  const lo = to.toLowerCase();

  if (lo === CONTRACTS[chain].aave.pool.toLowerCase()) {
    return { kind: "aave-v3-pool", abi: aavePoolAbi as Abi };
  }

  const compound = (CONTRACTS[chain] as { compound?: Record<string, string> }).compound;
  if (compound) {
    for (const addr of Object.values(compound)) {
      if (lo === addr.toLowerCase()) return { kind: "compound-v3-comet", abi: cometAbi as Abi };
    }
  }

  if (chain === "ethereum") {
    if (lo === CONTRACTS.ethereum.morpho.blue.toLowerCase()) {
      return { kind: "morpho-blue", abi: morphoBlueAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.lido.stETH.toLowerCase()) {
      return { kind: "lido-stETH", abi: stETHAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase()) {
      return { kind: "lido-withdrawalQueue", abi: lidoWithdrawalQueueAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase()) {
      return { kind: "eigenlayer-strategyManager", abi: eigenStrategyManagerAbi as Abi };
    }
  }

  if (lo === CONTRACTS[chain].uniswap.positionManager.toLowerCase()) {
    return { kind: "uniswap-v3-npm", abi: uniswapPositionManagerAbi as Abi };
  }

  if (lo === LIFI_DIAMOND) return { kind: "lifi-diamond", abi: null };

  const tokens = (CONTRACTS[chain] as { tokens?: Record<string, string> }).tokens;
  if (tokens) {
    for (const addr of Object.values(tokens)) {
      if (lo === addr.toLowerCase()) return { kind: "known-erc20", abi: erc20Abi as Abi };
    }
  }

  return null;
}

function nativeDecode(chain: SupportedChain, value: string): HumanDecode {
  let valueHuman: string;
  try {
    valueHuman = `${formatUnits(BigInt(value), 18)} ${NATIVE_SYMBOL[chain]}`;
  } catch {
    valueHuman = `${value} wei`;
  }
  return {
    functionName: "nativeTransfer",
    args: [{ name: "value", type: "uint256", value, valueHuman }],
    source: "native",
  };
}

function stringifyArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stringifyArg).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${stringifyArg(v)}`).join(", ")}}`;
  }
  return String(value);
}

/**
 * Apply ERC-20 decimals + symbol when the arg's type is uint256 and we
 * recognize the destination as a known token. This is the only
 * human-formatting we do on generic ERC-20 args — anything else (aave
 * `supply(asset, amount, ...)` where `asset` is the token arg) would need
 * the caller to identify which specific arg is the "asset" field, which we
 * don't currently wire through. A future refinement could walk `supply`'s
 * args to look up the asset arg and format the amount arg accordingly.
 */
function formatErc20ArgHuman(
  chain: SupportedChain,
  to: `0x${string}`,
  argName: string,
  argType: string,
  raw: unknown,
): string | undefined {
  if (argType !== "uint256" || typeof raw !== "bigint") return undefined;
  if (argName !== "amount" && argName !== "value") return undefined;
  const meta = TOKEN_META[chain][to.toLowerCase()];
  if (!meta) return undefined;
  return `${formatUnits(raw, meta.decimals)} ${meta.symbol}`;
}

function signatureOf(item: AbiFunction): string {
  const inputs = item.inputs.map((i) => i.type).join(",");
  return `${item.name}(${inputs})`;
}

export function decodeCalldata(
  chain: SupportedChain,
  to: `0x${string}`,
  data: `0x${string}`,
  value: string,
): HumanDecode {
  if (data === "0x" || data === "0x0" || data === "0x00") {
    return nativeDecode(chain, value);
  }

  const dest = classifyDestination(chain, to);
  if (!dest || !dest.abi) {
    return {
      functionName: "unknown",
      args: [],
      source: "none",
    };
  }

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: dest.abi, data });
  } catch {
    return { functionName: "unknown", args: [], source: "none" };
  }

  const abiItem = dest.abi.find(
    (item): item is AbiFunction => item.type === "function" && item.name === decoded.functionName,
  );
  if (!abiItem) return { functionName: decoded.functionName, args: [], source: "local-abi" };

  const rawArgs = decoded.args ?? [];
  const args: DecodedArg[] = abiItem.inputs.map((input, idx) => {
    const raw = rawArgs[idx];
    const base: DecodedArg = {
      name: input.name ?? `arg${idx}`,
      type: input.type,
      value: stringifyArg(raw),
    };
    const human =
      dest.kind === "known-erc20"
        ? formatErc20ArgHuman(chain, to, base.name, input.type, raw)
        : undefined;
    if (input.type === "address" && typeof raw === "string") {
      // Re-apply checksum casing on address args so the chat output
      // matches the form swiss-knife renders.
      try {
        base.value = getAddress(raw);
      } catch {
        // Keep raw string if checksum fails (shouldn't happen for well-formed calldata).
      }
    }
    if (human) base.valueHuman = human;
    return base;
  });

  return {
    functionName: decoded.functionName,
    signature: signatureOf(abiItem),
    args,
    source: "local-abi",
  };
}

/**
 * TRON's `rawData` isn't ABI-encoded calldata — it's a protobuf-ish envelope
 * with a typed contract. The prepare_tron_* builders already populate
 * `tx.decoded` with a structured function name + args tailored to each
 * action type (native_send, trc20_send, vote, freeze, etc.). We reuse that
 * here rather than re-decoding raw_data_hex, so the verification decode
 * stays trivially consistent with what the preparer itself reported.
 */
export function decodeTronCall(tx: UnsignedTronTx): HumanDecode {
  const args: DecodedArg[] = Object.entries(tx.decoded.args).map(([name, value]) => ({
    name,
    type: "string",
    value,
  }));
  return {
    functionName: tx.decoded.functionName,
    args,
    source: "local-abi",
  };
}
