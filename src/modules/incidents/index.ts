import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { cometAbi } from "../../abis/compound-comet.js";
import { erc20Abi } from "../../abis/erc20.js";
import { readCometPausedActions, type CometPausedAction } from "../compound/index.js";
import { round } from "../../data/format.js";
import type { SupportedChain } from "../../types/index.js";
import type { GetMarketIncidentStatusArgs } from "./schemas.js";

/**
 * "Is anything on fire right now in protocol X on chain Y."
 *
 * Emerged from the 2026-04-20 session: the agent spent two separate
 * diagnostic passes to establish that cUSDCv3 had withdraws paused AND the
 * adjacent cWETHv3 was at 95% utilization AND they shared the rsETH collateral
 * that was at the root of the incident. This tool folds all three signals into
 * one call so the "am I in a broader problem" judgment doesn't require hand-
 * rolled multicalls per market.
 */
export interface CompoundMarketIncidentEntry {
  chain: SupportedChain;
  market: string;
  address: `0x${string}`;
  baseToken: { symbol: string; address: `0x${string}` };
  pausedActions: CometPausedAction[];
  utilization: number;
  totalSupply: string;
  totalBorrow: string;
  /** True when any pause flag is set OR utilization ≥ 0.95 (borrowers can't exit). */
  flagged: boolean;
}

export interface MarketIncidentStatus {
  protocol: "compound-v3";
  chain: SupportedChain;
  /** Block number at which reads were performed. Useful for incident reports. */
  blockNumber: string;
  /** True if any market in the registry is flagged. */
  incident: boolean;
  markets: CompoundMarketIncidentEntry[];
}

const HIGH_UTILIZATION_FLAG = 0.95;

export async function getMarketIncidentStatus(
  args: GetMarketIncidentStatusArgs
): Promise<MarketIncidentStatus> {
  const chain = args.chain as SupportedChain;
  if (args.protocol !== "compound-v3") {
    throw new Error(
      `get_market_incident_status currently supports protocol="compound-v3" only. Requested ${args.protocol}.`
    );
  }

  const registry = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[
    chain
  ]?.compound;
  if (!registry) {
    throw new Error(`Compound V3 is not registered on ${chain}.`);
  }
  const markets = Object.entries(registry).map(([name, address]) => ({
    name,
    address: address as `0x${string}`,
  }));

  const client = getClient(chain);
  const blockNumber = await client.getBlockNumber();

  const entries: CompoundMarketIncidentEntry[] = await Promise.all(
    markets.map(async (m) => {
      const core = await client.multicall({
        contracts: [
          { address: m.address, abi: cometAbi, functionName: "baseToken" },
          { address: m.address, abi: cometAbi, functionName: "getUtilization" },
          { address: m.address, abi: cometAbi, functionName: "totalSupply" },
          { address: m.address, abi: cometAbi, functionName: "totalBorrow" },
        ],
        allowFailure: false,
      });
      const baseAddr = core[0] as `0x${string}`;
      const utilization = core[1] as bigint;
      const totalSupplyWei = core[2] as bigint;
      const totalBorrowWei = core[3] as bigint;

      const [decimals, symbol] = await client.multicall({
        contracts: [
          { address: baseAddr, abi: erc20Abi, functionName: "decimals" },
          { address: baseAddr, abi: erc20Abi, functionName: "symbol" },
        ],
        allowFailure: false,
      });
      const baseDecimals = Number(decimals);
      const baseSymbol = symbol as string;

      const pausedActions = await readCometPausedActions(client, m.address).catch(
        () => [] as CometPausedAction[]
      );

      const utilFraction = Number(formatUnits(utilization, 18));
      const flagged = pausedActions.length > 0 || utilFraction >= HIGH_UTILIZATION_FLAG;

      return {
        chain,
        market: m.name,
        address: m.address,
        baseToken: { symbol: baseSymbol, address: baseAddr },
        pausedActions,
        utilization: round(utilFraction, 6),
        totalSupply: formatUnits(totalSupplyWei, baseDecimals),
        totalBorrow: formatUnits(totalBorrowWei, baseDecimals),
        flagged,
      };
    })
  );

  return {
    protocol: "compound-v3",
    chain,
    blockNumber: blockNumber.toString(),
    incident: entries.some((e) => e.flagged),
    markets: entries,
  };
}
