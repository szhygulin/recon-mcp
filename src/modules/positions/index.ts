import { getAaveLendingPosition, simulateHealthFactorChange } from "./aave.js";
import { getUniswapPositions } from "./uniswap.js";
import type {
  GetLendingPositionsArgs,
  GetLpPositionsArgs,
  GetHealthAlertsArgs,
  SimulatePositionChangeArgs,
} from "./schemas.js";
import type { LendingPosition, LPPosition, SupportedChain } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function resolveChains(chains?: string[]): SupportedChain[] {
  return (chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS];
}

export async function getLendingPositions(args: GetLendingPositionsArgs): Promise<{
  wallet: string;
  positions: LendingPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const results = await Promise.all(chains.map((c) => getAaveLendingPosition(wallet, c)));
  return { wallet, positions: results.filter((p): p is LendingPosition => p !== null) };
}

export async function getLpPositions(args: GetLpPositionsArgs): Promise<{
  wallet: string;
  positions: LPPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const perChain = await Promise.all(chains.map((c) => getUniswapPositions(wallet, c)));
  return { wallet, positions: perChain.flat() };
}

export async function getHealthAlerts(args: GetHealthAlertsArgs): Promise<{
  wallet: string;
  threshold: number;
  atRisk: Array<{
    chain: SupportedChain;
    healthFactor: number;
    collateralUsd: number;
    debtUsd: number;
    marginToLiquidation: number;
  }>;
}> {
  const threshold = args.threshold ?? 1.5;
  const { positions, wallet } = await getLendingPositions({ wallet: args.wallet, chains: undefined });
  const atRisk = positions
    .filter((p) => p.healthFactor < threshold && p.totalDebtUsd > 0)
    .map((p) => ({
      chain: p.chain,
      healthFactor: p.healthFactor,
      collateralUsd: p.totalCollateralUsd,
      debtUsd: p.totalDebtUsd,
      // Margin is the % HF would need to drop by to hit 1.0.
      marginToLiquidation: Math.max(0, Math.round(((p.healthFactor - 1) / p.healthFactor) * 10000) / 100),
    }));
  return { wallet, threshold, atRisk };
}

export async function simulatePositionChange(args: SimulatePositionChangeArgs): Promise<{
  wallet: string;
  chain: SupportedChain;
  action: string;
  before: { healthFactor: number; collateralUsd: number; debtUsd: number };
  after: { healthFactor: number; collateralUsd: number; debtUsd: number; safe: boolean };
}> {
  const wallet = args.wallet as `0x${string}`;
  const chain = (args.chain ?? "ethereum") as SupportedChain;
  const base = await getAaveLendingPosition(wallet, chain);
  if (!base) {
    throw new Error(`Wallet ${wallet} has no Aave V3 position on ${chain}.`);
  }
  const sim = simulateHealthFactorChange(base, args.action, args.amountUsd);
  return {
    wallet,
    chain,
    action: args.action,
    before: {
      healthFactor: base.healthFactor,
      collateralUsd: base.totalCollateralUsd,
      debtUsd: base.totalDebtUsd,
    },
    after: {
      healthFactor: sim.newHealthFactor,
      collateralUsd: sim.newCollateralUsd,
      debtUsd: sim.newDebtUsd,
      safe: sim.safe,
    },
  };
}
