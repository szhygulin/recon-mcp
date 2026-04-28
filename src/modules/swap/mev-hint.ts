/**
 * Sandwich-MEV exposure hint for Ethereum-mainnet swaps. The slippage
 * tolerance directly bounds an attacker's profit from a sandwich — a
 * 1% slippage on a $10k swap means up to ~$100 is extractable before
 * the swap reverts. The user's actionable choices are to lower
 * slippage or split the swap; private-relay routing is not actionable
 * because Ledger Live broadcasts via public RPC.
 *
 * Mainnet-only for v1: L2s have sequencer-side ordering and aren't
 * sandwich targets at the same scale. L2 expansion deferred (see
 * `claude-work/plan-mev-hint-l2-expansion.md`).
 *
 * The threshold is conservative — 0.5% catches the common
 * misconfigured-aggregator-default case (some wallets default to 1%
 * or higher). Below it, sandwich extraction is small enough relative
 * to gas cost on mainnet that the warning would be more noise than
 * signal.
 */
export const MEV_SLIPPAGE_BPS_THRESHOLD = 50;

export function mevExposureNote(
  chain: string,
  slippageBps: number,
  notionalUsd: number | undefined,
): string | undefined {
  if (chain !== "ethereum") return undefined;
  if (slippageBps <= MEV_SLIPPAGE_BPS_THRESHOLD) return undefined;
  const slippagePct = slippageBps / 100;
  if (
    typeof notionalUsd === "number" &&
    Number.isFinite(notionalUsd) &&
    notionalUsd > 0
  ) {
    const exposureUsd = notionalUsd * (slippageBps / 10_000);
    return (
      `up to ~$${exposureUsd.toFixed(2)} extractable via sandwich at ` +
      `${slippagePct.toFixed(2)}% slippage on Ethereum mainnet — ` +
      `consider lowering slippage or splitting the swap`
    );
  }
  return (
    `up to ${slippagePct.toFixed(2)}% of swap value extractable via ` +
    `sandwich on Ethereum mainnet — consider lowering slippage or ` +
    `splitting the swap`
  );
}
