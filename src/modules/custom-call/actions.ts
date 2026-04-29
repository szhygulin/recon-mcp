import { encodeFunctionData, type Abi } from "viem";
import { getContractInfo } from "../../data/apis/etherscan.js";
import { lookupKnownSpender } from "../../security/known-spenders.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";
import { assertNotUnlimitedBurnApproval } from "../shared/approval.js";

export interface BuildCustomCallParams {
  wallet: `0x${string}`;
  chain: SupportedChain;
  contract: `0x${string}`;
  fn: string;
  args: readonly unknown[];
  value: string;
  abi?: readonly unknown[];
  acknowledgeBurnApproval?: boolean;
  acknowledgeRawApproveBypass?: boolean;
}

const APPROVE_SELECTOR = "0x095ea7b3";

// Issue #556 — when prepare_custom_call is invoked with an `approve(address,uint256)`
// selector, refuse and route the agent to `prepare_token_approve` (or a
// protocol-specific `prepare_*` when the spender is a known protocol contract).
// The dedicated tools carry burn-address gates, friendly spender labels, and the
// structured (token, spender, amount) interface that custom_call's raw-args path
// erases. `acknowledgeRawApproveBypass` is the escape hatch for the rare
// non-ERC-20 contract that exposes its own `approve(address,uint256)` for an
// unrelated purpose.
function assertApproveRoutedToDedicatedTool(
  data: `0x${string}`,
  spender: string | undefined,
  knownProtocolLabel: string | undefined,
  ack: boolean | undefined,
): void {
  if (ack === true) return;
  if (!data.toLowerCase().startsWith(APPROVE_SELECTOR)) return;
  const spenderHint = spender ? ` (spender=${spender})` : "";
  if (knownProtocolLabel) {
    throw new Error(
      `APPROVE_ROUTE_VIA_DEDICATED_TOOL: refusing to encode approve(...) via ` +
        `prepare_custom_call${spenderHint}. The spender resolves to ${knownProtocolLabel} — use the ` +
        `protocol-specific prepare_* (e.g. prepare_aave_supply / prepare_compound_supply / ` +
        `prepare_lido_stake) which bundles approve+action and applies protocol-tier safety ` +
        `checks. If you genuinely need a raw approve through this escape hatch, retry with ` +
        `\`acknowledgeRawApproveBypass: true\`.`,
    );
  }
  throw new Error(
    `APPROVE_ROUTE_VIA_DEDICATED_TOOL: refusing to encode approve(...) via ` +
      `prepare_custom_call${spenderHint}. Use \`prepare_token_approve\` instead — the dedicated ` +
      `tool applies the burn-address gate, friendly spender labeling, and the structured ` +
      `(token, spender, amount) interface that this escape hatch loses. If you genuinely need ` +
      `a raw approve through this escape hatch (e.g. a non-ERC-20 contract that exposes ` +
      `\`approve(address,uint256)\` for an unrelated purpose), retry with ` +
      `\`acknowledgeRawApproveBypass: true\`.`,
  );
}

/**
 * Resolve the ABI to use for encoding. Caller-supplied `abi` wins; otherwise
 * fetch via Etherscan V2 (`getsourcecode`, already wrapped + cached). Refuses
 * on unverified contracts, on parse failures, and on proxies whose
 * implementation ABI we can't reach — the user can always pass `abi` inline
 * to bypass any of those refusals when they have a trusted ABI source.
 *
 * Why we never fall back to raw-bytecode encoding: the whole point of
 * `prepare_custom_call` is that the user is bypassing the canonical-dispatch
 * allowlist; the verified-ABI gate is the agent-side anchor that the
 * function selector + args actually correspond to a real, source-published
 * function rather than arbitrary bytes the caller hopes will work.
 */
async function resolveCallAbi(
  contract: `0x${string}`,
  chain: SupportedChain,
): Promise<Abi> {
  const info = await getContractInfo(contract, chain);
  if (!info.isVerified) {
    throw new Error(
      `Contract ${contract} on ${chain} is not Etherscan-verified — refusing to encode calldata against unverified bytecode. Pass the ABI inline via the \`abi\` arg if you have it from another trusted source (e.g. the project's published artifacts).`,
    );
  }
  if (info.isProxy && info.implementation) {
    const impl = await getContractInfo(info.implementation, chain);
    if (impl.isVerified && impl.abi && impl.abi.length > 0) {
      return impl.abi as Abi;
    }
    throw new Error(
      `Contract ${contract} on ${chain} is a proxy whose implementation ${info.implementation} couldn't be ABI-fetched (unverified or parse failure). Pass the ABI inline via the \`abi\` arg.`,
    );
  }
  if (!info.abi || info.abi.length === 0) {
    throw new Error(
      `Etherscan returned no parseable ABI for ${contract} on ${chain} (verified, but ABI was empty or invalid). Pass the ABI inline via the \`abi\` arg.`,
    );
  }
  return info.abi as Abi;
}

export async function buildCustomCall(p: BuildCustomCallParams): Promise<UnsignedTx> {
  const abi: Abi = p.abi
    ? (p.abi as Abi)
    : await resolveCallAbi(p.contract, p.chain);

  let data: `0x${string}`;
  try {
    data = encodeFunctionData({
      abi,
      functionName: p.fn,
      args: p.args as readonly unknown[],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to encode calldata for ${p.fn} on ${p.contract} (${p.chain}): ${msg}. ` +
        `Check that \`fn\` matches an ABI entry (use the full signature like ` +
        `"schedule(address,uint256,bytes,bytes32,bytes32,uint256)" to disambiguate ` +
        `overloads) and that \`args\` types match the function's inputs in order.`,
    );
  }

  // value is a raw wei decimal string; reject anything that isn't.
  if (!/^\d+$/.test(p.value)) {
    throw new Error(
      `\`value\` must be a non-negative wei integer as a decimal string (e.g. "0" or "1000000000000000000" for 1 ETH). Got: ${p.value}`,
    );
  }

  // Issue #556 — refuse approve(...) via the escape hatch and route the
  // agent to the dedicated tool. Burn-address gate stays as defense in
  // depth on the override path (`acknowledgeRawApproveBypass: true`).
  if (data.toLowerCase().startsWith(APPROVE_SELECTOR)) {
    const spender = p.args.length > 0 ? String(p.args[0]) : undefined;
    let knownProtocolLabel: string | undefined;
    if (spender && /^0x[0-9a-fA-F]{40}$/.test(spender)) {
      knownProtocolLabel = lookupKnownSpender(p.chain, spender as `0x${string}`);
    }
    assertApproveRoutedToDedicatedTool(
      data,
      spender,
      knownProtocolLabel,
      p.acknowledgeRawApproveBypass,
    );
    if (p.args.length >= 2) {
      let amount: bigint | null = null;
      try {
        amount = BigInt(p.args[1] as string | number | bigint);
      } catch {
        amount = null;
      }
      if (amount !== null && spender) {
        assertNotUnlimitedBurnApproval(spender, amount, p.acknowledgeBurnApproval);
      }
    }
  }

  // Stringify args for the decoded preview. Caller-supplied shapes are
  // arbitrary (struct tuples, address arrays, decimal strings); the JSON
  // form is the most faithful agent-readable rendering without losing
  // structural detail. Caps at 4KB so a pathological bytes argument
  // doesn't blow up the prepare-receipt block.
  const argsJson = JSON.stringify(p.args, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const argsPreview = argsJson.length > 4096 ? `${argsJson.slice(0, 4096)}…` : argsJson;

  return {
    chain: p.chain,
    to: p.contract,
    data,
    value: p.value,
    from: p.wallet,
    description: `Custom call: ${p.fn} on ${p.contract} (${p.chain})`,
    decoded: {
      functionName: p.fn,
      args: { args: argsPreview },
    },
  };
}
