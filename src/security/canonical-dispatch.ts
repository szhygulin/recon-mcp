/**
 * Invariant #1.a — outer dispatch-target allowlist (MCP-side mirror).
 *
 * The skill (`vaultpilot-preflight/SKILL.md` §1.a) enforces this
 * invariant agent-side as the load-bearing defense against
 * rogue-MCP recipient-substitution attacks (smoke-test b117). This
 * module mirrors the same canonical-contract allowlist on the MCP
 * side as defense-in-depth: if a `prepare_*` flow's internal builder
 * ever generates a tx whose outer `to` is not the canonical target
 * for that tool family on that chain, this guard throws BEFORE the
 * handle is issued — so an internal bug or supply-chain tamper that
 * substitutes the target gets caught here too, not just by the
 * agent's independent check.
 *
 * Source of truth: `src/config/contracts.ts`. Both this module and
 * the skill's table are derived from it; the regression test
 * `test/canonical-dispatch.test.ts` asserts every entry resolves
 * to a real `CONTRACTS` address so the lookup can never silently
 * fall out of sync.
 *
 * Scope: prepare_* tools where the canonical target is unambiguous.
 * Sends (`prepare_native_send`, `prepare_token_send`) target
 * user-supplied addresses or token contracts and have no canonical
 * "expected to" — they are NOT covered. Cross-chain swap
 * (`prepare_swap` via LiFi) has the LiFi diamond as its target on
 * every chain and IS covered.
 */

import { CONTRACTS } from "../config/contracts.js";
import type { SupportedChain, UnsignedTx } from "../types/index.js";

/**
 * Tool families with canonical-target enforcement. Keyed by the
 * common prefix of `prepare_*` tool names; matched by `startsWith`.
 *
 * Per-(family, chain) the value is the SET of acceptable lower-cased
 * outer `to` addresses. Set, not single value, because some families
 * legitimately target multiple canonical contracts on the same chain
 * (Compound has cUSDCv3 / cUSDTv3 / cWETHv3 / etc. — all valid Comet
 * targets; the strict per-market check is left to the tool's own
 * argument validation).
 */
const EXPECTED_TARGETS: Record<string, Partial<Record<SupportedChain, Set<string>>>> = {
  prepare_aave_: chainSet({
    ethereum: [CONTRACTS.ethereum.aave.pool],
    arbitrum: [CONTRACTS.arbitrum.aave.pool],
    polygon: [CONTRACTS.polygon.aave.pool],
    base: [CONTRACTS.base.aave.pool],
    optimism: [CONTRACTS.optimism.aave.pool],
  }),
  prepare_compound_: chainSet({
    ethereum: Object.values(CONTRACTS.ethereum.compound),
    arbitrum: Object.values(CONTRACTS.arbitrum.compound),
    polygon: Object.values(CONTRACTS.polygon.compound),
    base: Object.values(CONTRACTS.base.compound),
    optimism: Object.values(CONTRACTS.optimism.compound),
  }),
  prepare_lido_stake: chainSet({
    ethereum: [CONTRACTS.ethereum.lido.stETH],
  }),
  prepare_lido_unstake: chainSet({
    ethereum: [
      CONTRACTS.ethereum.lido.stETH,
      CONTRACTS.ethereum.lido.withdrawalQueue,
    ],
  }),
  prepare_morpho_: chainSet({
    ethereum: [CONTRACTS.ethereum.morpho.blue],
  }),
  prepare_uniswap_swap: chainSet({
    ethereum: [CONTRACTS.ethereum.uniswap.swapRouter02],
    arbitrum: [CONTRACTS.arbitrum.uniswap.swapRouter02],
    polygon: [CONTRACTS.polygon.uniswap.swapRouter02],
    base: [CONTRACTS.base.uniswap.swapRouter02],
    optimism: [CONTRACTS.optimism.uniswap.swapRouter02],
  }),
  prepare_uniswap_v3_: chainSet({
    ethereum: [CONTRACTS.ethereum.uniswap.positionManager],
    arbitrum: [CONTRACTS.arbitrum.uniswap.positionManager],
    polygon: [CONTRACTS.polygon.uniswap.positionManager],
    base: [CONTRACTS.base.uniswap.positionManager],
    optimism: [CONTRACTS.optimism.uniswap.positionManager],
  }),
  prepare_eigenlayer_deposit: chainSet({
    ethereum: [CONTRACTS.ethereum.eigenlayer.strategyManager],
  }),
};

function chainSet(
  perChain: Partial<Record<SupportedChain, readonly string[]>>,
): Partial<Record<SupportedChain, Set<string>>> {
  const out: Partial<Record<SupportedChain, Set<string>>> = {};
  for (const [chain, addrs] of Object.entries(perChain) as [
    SupportedChain,
    readonly string[],
  ][]) {
    out[chain] = new Set(addrs.map((a) => a.toLowerCase()));
  }
  return out;
}

function lookupExpected(toolName: string): Partial<Record<SupportedChain, Set<string>>> | null {
  // Most-specific match first (e.g. `prepare_lido_stake` before
  // `prepare_lido_`). Iterate keys sorted by descending length.
  const keys = Object.keys(EXPECTED_TARGETS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (toolName === key || toolName.startsWith(key)) {
      return EXPECTED_TARGETS[key]!;
    }
  }
  return null;
}

/**
 * Throws if `to` is not in the canonical-target allowlist for the
 * `(toolName, chain)` tuple. No-op when `toolName` is not in the
 * allowlist map (sends, swaps to user-supplied tokens, etc.).
 *
 * Error message mirrors the skill's `✗ DISPATCH-TARGET MISMATCH`
 * prose so an operator reading either side gets the same diagnostic.
 */
export function assertCanonicalDispatchTarget(
  toolName: string,
  chain: SupportedChain,
  to: string,
): void {
  const expected = lookupExpected(toolName);
  if (!expected) return;
  const allowlist = expected[chain];
  if (!allowlist) {
    throw new Error(
      `[INV_1A] ${toolName}: chain '${chain}' has no canonical target in the allowlist — refusing to issue an unsigned tx whose dispatch target cannot be verified.`,
    );
  }
  if (!allowlist.has(to.toLowerCase())) {
    const allowed = Array.from(allowlist).join(", ");
    throw new Error(
      `[INV_1A] ✗ DISPATCH-TARGET MISMATCH for ${toolName} on ${chain}: builder produced to=${to}, but the canonical target(s) for this tool family are: ${allowed}. Refusing to issue handle.`,
    );
  }
}

/**
 * Walk to the action leg of a prepared `UnsignedTx` chain and assert its
 * dispatch target against the canonical-target allowlist for `toolName`.
 *
 * Approval legs sit ahead of the action and target the ERC-20 token
 * contract (never in the allowlist) — the canonical-target check applies
 * to the protocol action at the tail of the chain. Wired into `txHandler`
 * (src/index.ts) so every prepare_* handler runs through this guard
 * before handles are issued.
 */
export function assertCanonicalDispatchOnTxChain(
  toolName: string,
  tx: UnsignedTx,
): void {
  let tail: UnsignedTx = tx;
  while (tail.next) tail = tail.next;
  assertCanonicalDispatchTarget(toolName, tail.chain, tail.to);
}

/**
 * Test-only: enumerate every (toolFamily, chain) the allowlist
 * covers. Used by the regression test to assert every entry resolves
 * to a real `CONTRACTS` address.
 */
export function _enumerateAllowlistForTests(): Array<{
  family: string;
  chain: SupportedChain;
  addresses: string[];
}> {
  const out: Array<{ family: string; chain: SupportedChain; addresses: string[] }> = [];
  for (const [family, perChain] of Object.entries(EXPECTED_TARGETS)) {
    for (const [chain, addrs] of Object.entries(perChain) as [
      SupportedChain,
      Set<string>,
    ][]) {
      out.push({ family, chain, addresses: Array.from(addrs) });
    }
  }
  return out;
}
