#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  getLendingPositions,
  getLpPositions,
  getHealthAlerts,
  simulatePositionChange,
} from "./modules/positions/index.js";
import {
  getLendingPositionsInput,
  getLpPositionsInput,
  getHealthAlertsInput,
  simulatePositionChangeInput,
} from "./modules/positions/schemas.js";

import {
  checkContractSecurityHandler,
  checkPermissionRisksHandler,
  getProtocolRiskScoreHandler,
} from "./modules/security/index.js";
import {
  checkContractSecurityInput,
  checkPermissionRisksInput,
  getProtocolRiskScoreInput,
} from "./modules/security/schemas.js";

import {
  getStakingPositions,
  getStakingRewards,
  estimateStakingYield,
} from "./modules/staking/index.js";
import {
  getStakingPositionsInput,
  getStakingRewardsInput,
  estimateStakingYieldInput,
} from "./modules/staking/schemas.js";

import { getPortfolioSummary } from "./modules/portfolio/index.js";
import { getPortfolioSummaryInput } from "./modules/portfolio/schemas.js";

import { getSwapQuote, prepareSwap } from "./modules/swap/index.js";
import { getSwapQuoteInput, prepareSwapInput } from "./modules/swap/schemas.js";

import {
  pairLedgerLive,
  getLedgerStatus,
  prepareAaveSupply,
  prepareAaveWithdraw,
  prepareAaveBorrow,
  prepareAaveRepay,
  prepareLidoStake,
  prepareLidoUnstake,
  prepareEigenLayerDeposit,
  prepareNativeSend,
  prepareTokenSend,
  sendTransaction,
  getTransactionStatus,
} from "./modules/execution/index.js";
import {
  pairLedgerLiveInput,
  getLedgerStatusInput,
  prepareAaveSupplyInput,
  prepareAaveWithdrawInput,
  prepareAaveBorrowInput,
  prepareAaveRepayInput,
  prepareLidoStakeInput,
  prepareLidoUnstakeInput,
  prepareEigenLayerDepositInput,
  prepareNativeSendInput,
  prepareTokenSendInput,
  sendTransactionInput,
  getTransactionStatusInput,
} from "./modules/execution/schemas.js";

import { getTokenBalance, resolveName, reverseResolve } from "./modules/balances/index.js";
import {
  getTokenBalanceInput,
  resolveNameInput,
  reverseResolveInput,
} from "./modules/balances/schemas.js";

import { getBitcoinBalance, getBitcoinPortfolio } from "./modules/bitcoin/index.js";
import { prepareBitcoinSend, broadcastBitcoinTx } from "./modules/bitcoin/send.js";
import {
  getBitcoinBalanceInput,
  getBitcoinPortfolioInput,
  prepareBitcoinSendInput,
  broadcastBitcoinTxInput,
} from "./modules/bitcoin/schemas.js";

import { getCompoundPositions } from "./modules/compound/index.js";
import {
  buildCompoundSupply,
  buildCompoundWithdraw,
  buildCompoundBorrow,
  buildCompoundRepay,
} from "./modules/compound/actions.js";
import {
  getCompoundPositionsInput,
  prepareCompoundSupplyInput,
  prepareCompoundWithdrawInput,
  prepareCompoundBorrowInput,
  prepareCompoundRepayInput,
} from "./modules/compound/schemas.js";

import { getMorphoPositions } from "./modules/morpho/index.js";
import {
  buildMorphoSupply,
  buildMorphoWithdraw,
  buildMorphoBorrow,
  buildMorphoRepay,
  buildMorphoSupplyCollateral,
  buildMorphoWithdrawCollateral,
} from "./modules/morpho/actions.js";
import {
  getMorphoPositionsInput,
  prepareMorphoSupplyInput,
  prepareMorphoWithdrawInput,
  prepareMorphoBorrowInput,
  prepareMorphoRepayInput,
  prepareMorphoSupplyCollateralInput,
  prepareMorphoWithdrawCollateralInput,
} from "./modules/morpho/schemas.js";

import { readUserConfig } from "./config/user-config.js";

/**
 * Wrap a plain async function into the shape MCP expects.
 * Returns `{ content: [{ type: "text", text }] }` on success,
 * `{ content, isError: true }` on failure.
 */
function handler<T, R>(fn: (args: T) => Promise<R> | R) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, bigintReplacer, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/** JSON.stringify replacer that converts bigint to decimal string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  // Check for at least one configured RPC path early. We don't hard-fail — the
  // user may only use read-only tools with per-chain env vars. We just warn.
  const cfg = readUserConfig();
  const hasEnvChain = process.env.ETHEREUM_RPC_URL || process.env.ARBITRUM_RPC_URL;
  const hasEnvProvider = process.env.RPC_PROVIDER && process.env.RPC_API_KEY;
  if (!cfg && !hasEnvChain && !hasEnvProvider) {
    console.error(
      "[recon-mcp] warning: no RPC provider configured. Run `recon-mcp-setup` or set RPC_PROVIDER + RPC_API_KEY."
    );
  }

  const server = new McpServer({ name: "recon-mcp", version: "0.1.0" });

  // ---- Module 1: Positions ----
  server.registerTool(
    "get_lending_positions",
    {
      description:
        "Fetch all Aave V3 lending/borrowing positions for a wallet. Returns collateral, debt (both in USD and per-asset), health factor, LTV, and liquidation threshold across Ethereum and Arbitrum.",
      inputSchema: getLendingPositionsInput.shape,
    },
    handler(getLendingPositions)
  );

  server.registerTool(
    "get_lp_positions",
    {
      description:
        "Fetch all Uniswap V3 liquidity-provider positions for a wallet. Returns token pair, current token amounts, fee tier, in-range status, uncollected fees (lower bound), and an approximate impermanent-loss estimate.",
      inputSchema: getLpPositionsInput.shape,
    },
    handler(getLpPositions)
  );

  server.registerTool(
    "get_health_alerts",
    {
      description:
        "Check for Aave V3 lending positions approaching liquidation. Returns positions whose health factor is below the given threshold (default 1.5).",
      inputSchema: getHealthAlertsInput.shape,
    },
    handler(getHealthAlerts)
  );

  server.registerTool(
    "simulate_position_change",
    {
      description:
        "Simulate the effect of adding or removing collateral, or borrowing/repaying debt on an Aave V3 position. Returns the projected health factor and collateral/debt totals. No transaction is sent.",
      inputSchema: simulatePositionChangeInput.shape,
    },
    handler(simulatePositionChange)
  );

  // ---- Module 2: Security ----
  server.registerTool(
    "check_contract_security",
    {
      description:
        "Check Etherscan verification status, EIP-1967 proxy pattern, implementation/admin slots, and the presence of dangerous admin functions (mint, pause, upgradeTo, etc.) for a given contract.",
      inputSchema: checkContractSecurityInput.shape,
    },
    handler((a) => checkContractSecurityHandler(a))
  );

  server.registerTool(
    "check_permission_risks",
    {
      description:
        "Enumerate privileged roles on a contract (Ownable.owner, AccessControl hints) and classify holders as EOA, Gnosis Safe multisig, or TimelockController.",
      inputSchema: checkPermissionRisksInput.shape,
    },
    handler((a) => checkPermissionRisksHandler(a))
  );

  server.registerTool(
    "get_protocol_risk_score",
    {
      description:
        "Return a 0-100 risk score for a DeFi protocol, combining TVL size, 30-day TVL trend, contract age, audit count (DefiLlama), and Immunefi bug-bounty status. Higher = safer.",
      inputSchema: getProtocolRiskScoreInput.shape,
    },
    handler((a) => getProtocolRiskScoreHandler(a))
  );

  // ---- Module 3: Staking ----
  server.registerTool(
    "get_staking_positions",
    {
      description:
        "Fetch Lido (stETH/wstETH) and EigenLayer staking positions for a wallet across supported chains. Returns per-protocol staked amounts, USD value, APR, and EigenLayer delegation target.",
      inputSchema: getStakingPositionsInput.shape,
    },
    handler(getStakingPositions)
  );

  server.registerTool(
    "get_staking_rewards",
    {
      description:
        "Estimate staking rewards earned over a given period (7d/30d/90d/1y) using the current APR as a proxy. This is an estimate, not an on-chain rewards query.",
      inputSchema: getStakingRewardsInput.shape,
    },
    handler(getStakingRewards)
  );

  server.registerTool(
    "estimate_staking_yield",
    {
      description:
        "Project annual yield on a hypothetical staking amount for a given protocol (Lido or EigenLayer) using current APRs.",
      inputSchema: estimateStakingYieldInput.shape,
    },
    handler(estimateStakingYield)
  );

  // ---- Module 4: Portfolio ----
  server.registerTool(
    "get_portfolio_summary",
    {
      description:
        "Aggregate a complete portfolio view: native balances, top ERC-20 holdings, Aave V3 positions, Uniswap V3 LP positions, and staking — with USD totals and per-chain breakdown. Pass `bitcoinAddresses` to also include Bitcoin holdings (via mempool.space).",
      inputSchema: getPortfolioSummaryInput.shape,
    },
    handler(getPortfolioSummary)
  );

  // ---- Module 5: Swap/Bridge (LiFi) ----
  server.registerTool(
    "get_swap_quote",
    {
      description:
        "Get a LiFi aggregator quote for a token swap (same-chain) or bridge (cross-chain). Returns expected output, fees, execution time, and the underlying tool selected. No transaction is built.",
      inputSchema: getSwapQuoteInput.shape,
    },
    handler(getSwapQuote)
  );

  server.registerTool(
    "prepare_swap",
    {
      description:
        "Prepare an unsigned swap or bridge transaction via LiFi aggregator. Same-chain swaps use the best DEX route; cross-chain swaps use a bridge + DEX combo. The returned tx can be sent via `send_transaction`.",
      inputSchema: prepareSwapInput.shape,
    },
    handler(prepareSwap)
  );

  // ---- Module 6: Execution (Ledger Live) ----
  server.registerTool(
    "pair_ledger_live",
    {
      description:
        "Initiate a WalletConnect v2 pairing session with Ledger Live. Returns a URI and ASCII QR code — paste into Ledger Live's WalletConnect screen to complete pairing. The session persists for future transactions.",
      inputSchema: pairLedgerLiveInput.shape,
    },
    handler(pairLedgerLive)
  );

  server.registerTool(
    "get_ledger_status",
    {
      description:
        "Report whether a WalletConnect session with Ledger Live is active, which wallet it's connected to, and which accounts are exposed.",
      inputSchema: getLedgerStatusInput.shape,
    },
    handler(getLedgerStatus)
  );

  server.registerTool(
    "prepare_aave_supply",
    {
      description:
        "Build an unsigned Aave V3 supply transaction. If an ERC-20 approve() is required first, it is returned as the outer tx and the supply tx is embedded in `.next`. Both must be signed for the supply to succeed.",
      inputSchema: prepareAaveSupplyInput.shape,
    },
    handler(prepareAaveSupply)
  );

  server.registerTool(
    "prepare_aave_withdraw",
    {
      description:
        "Build an unsigned Aave V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the entire aToken balance.",
      inputSchema: prepareAaveWithdrawInput.shape,
    },
    handler(prepareAaveWithdraw)
  );

  server.registerTool(
    "prepare_aave_borrow",
    {
      description:
        "Build an unsigned Aave V3 borrow transaction (stable or variable rate). The borrower must already have sufficient collateral supplied.",
      inputSchema: prepareAaveBorrowInput.shape,
    },
    handler(prepareAaveBorrow)
  );

  server.registerTool(
    "prepare_aave_repay",
    {
      description:
        "Build an unsigned Aave V3 repay transaction. If an ERC-20 approve() is required first, it is returned as the outer tx and repay is in `.next`. Pass `amount: \"max\"` to repay the full debt.",
      inputSchema: prepareAaveRepayInput.shape,
    },
    handler(prepareAaveRepay)
  );

  server.registerTool(
    "prepare_lido_stake",
    {
      description:
        "Build an unsigned Lido stake transaction (wraps ETH into stETH via stETH.submit). The tx's value field is the ETH amount to stake.",
      inputSchema: prepareLidoStakeInput.shape,
    },
    handler(prepareLidoStake)
  );

  server.registerTool(
    "prepare_lido_unstake",
    {
      description:
        "Build an unsigned Lido withdrawal request transaction. Wraps `requestWithdrawals` on the Lido Withdrawal Queue and includes an approve step if needed.",
      inputSchema: prepareLidoUnstakeInput.shape,
    },
    handler(prepareLidoUnstake)
  );

  server.registerTool(
    "prepare_eigenlayer_deposit",
    {
      description:
        "Build an unsigned EigenLayer StrategyManager.depositIntoStrategy transaction. Includes an ERC-20 approve step if needed.",
      inputSchema: prepareEigenLayerDepositInput.shape,
    },
    handler(prepareEigenLayerDeposit)
  );

  server.registerTool(
    "send_transaction",
    {
      description:
        "Forward an already-prepared transaction to Ledger Live via WalletConnect for user signing. The user must review and approve the tx in Ledger Live and on their Ledger device; this call blocks until the user signs or rejects. " +
        "You MUST pass `confirmed: true` — the agent is affirming that the user has seen and acknowledged the decoded preview.",
      inputSchema: sendTransactionInput.shape,
    },
    handler(sendTransaction)
  );

  server.registerTool(
    "get_transaction_status",
    {
      description:
        "Poll a transaction's status via the chain's RPC. Returns pending / success / failed, or unknown if the node hasn't seen it yet.",
      inputSchema: getTransactionStatusInput.shape,
    },
    handler(getTransactionStatus)
  );

  // ---- Module 7: Balances & ENS ----
  server.registerTool(
    "get_token_balance",
    {
      description:
        "Fetch a wallet's balance of any ERC-20 token or the chain's native coin. Pass `token: \"native\"` for ETH (or chain-native asset) or an ERC-20 contract address. Returns amount, decimals, symbol, and USD value.",
      inputSchema: getTokenBalanceInput.shape,
    },
    handler(getTokenBalance)
  );

  server.registerTool(
    "resolve_ens_name",
    {
      description:
        "Resolve an ENS name (e.g. vitalik.eth) to an Ethereum address via mainnet ENS resolver. Returns null if unregistered.",
      inputSchema: resolveNameInput.shape,
    },
    handler(resolveName)
  );

  server.registerTool(
    "reverse_resolve_ens",
    {
      description:
        "Reverse-resolve an Ethereum address to its primary ENS name. Returns null if no primary name is set.",
      inputSchema: reverseResolveInput.shape,
    },
    handler(reverseResolve)
  );

  server.registerTool(
    "prepare_native_send",
    {
      description:
        "Build an unsigned native-coin send transaction (ETH on Ethereum/Arbitrum). Pass a human-readable amount like \"0.5\".",
      inputSchema: prepareNativeSendInput.shape,
    },
    handler(prepareNativeSend)
  );

  server.registerTool(
    "prepare_token_send",
    {
      description:
        "Build an unsigned ERC-20 transfer transaction. Pass `amount: \"max\"` to send the full balance (resolved at build time).",
      inputSchema: prepareTokenSendInput.shape,
    },
    handler(prepareTokenSend)
  );

  // ---- Module: Bitcoin (read-only, mempool.space) ----
  server.registerTool(
    "get_bitcoin_balance",
    {
      description:
        "Fetch the confirmed + unconfirmed balance of a Bitcoin mainnet address via mempool.space. Supports legacy (1…), P2SH (3…), SegWit / Taproot (bc1…). Returns sats, BTC, and USD value (priced via DefiLlama).",
      inputSchema: getBitcoinBalanceInput.shape,
    },
    handler(getBitcoinBalance)
  );

  server.registerTool(
    "get_bitcoin_portfolio",
    {
      description:
        "Fetch confirmed BTC balances for a batch of up to 20 Bitcoin mainnet addresses. Returns per-address balances and aggregated totals in sats, BTC, and USD.",
      inputSchema: getBitcoinPortfolioInput.shape,
    },
    handler(getBitcoinPortfolio)
  );

  server.registerTool(
    "prepare_bitcoin_send",
    {
      description:
        "Prepare a Bitcoin send using a consolidation strategy: spends every spendable UTXO at the source address so the wallet is left with 0 (change absorbed as fee) or 1 (change output) UTXOs after confirmation. Returns the selection plan — inputs, outputs (recipient + optional change), estimated vsize, fee in sats/BTC, and fee rate used. No PSBT or signed transaction is produced; sign externally (Sparrow, Electrum, hardware wallet) and broadcast via broadcast_bitcoin_tx. Tradeoff: fee scales with input count, but consolidating now saves the cost of spending many small UTXOs later.",
      inputSchema: prepareBitcoinSendInput.shape,
    },
    handler(prepareBitcoinSend)
  );

  server.registerTool(
    "broadcast_bitcoin_tx",
    {
      description:
        "Broadcast a fully signed raw Bitcoin transaction (hex) to mempool.space. Returns the txid on success. The caller is responsible for producing a valid signed tx.",
      inputSchema: broadcastBitcoinTxInput.shape,
    },
    handler(broadcastBitcoinTx)
  );

  // ---- Module 8: Compound V3 ----
  server.registerTool(
    "get_compound_positions",
    {
      description:
        "Fetch Compound V3 (Comet) positions for a wallet across supported markets (cUSDCv3, cUSDTv3, cWETHv3, etc.). Returns base-token supplied/borrowed, per-asset collateral, and USD totals.",
      inputSchema: getCompoundPositionsInput.shape,
    },
    handler(getCompoundPositions)
  );

  server.registerTool(
    "prepare_compound_supply",
    {
      description:
        "Build an unsigned Compound V3 supply transaction (base token or collateral). If an ERC-20 approve() is required first, it is returned as the outer tx with supply in `.next`.",
      inputSchema: prepareCompoundSupplyInput.shape,
    },
    handler(buildCompoundSupply)
  );

  server.registerTool(
    "prepare_compound_withdraw",
    {
      description:
        "Build an unsigned Compound V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the full supplied balance.",
      inputSchema: prepareCompoundWithdrawInput.shape,
    },
    handler(buildCompoundWithdraw)
  );

  server.registerTool(
    "prepare_compound_borrow",
    {
      description:
        "Build an unsigned Compound V3 borrow transaction — encoded as withdraw(baseToken) beyond the user's supplied balance. Base token is resolved on-chain from the Comet.",
      inputSchema: prepareCompoundBorrowInput.shape,
    },
    handler(buildCompoundBorrow)
  );

  server.registerTool(
    "prepare_compound_repay",
    {
      description:
        "Build an unsigned Compound V3 repay transaction — encoded as supply(baseToken) against an outstanding borrow. Includes an approve step if needed. Pass `amount: \"max\"` for a full repay.",
      inputSchema: prepareCompoundRepayInput.shape,
    },
    handler(buildCompoundRepay)
  );

  // ---- Module 9: Morpho Blue ----
  server.registerTool(
    "get_morpho_positions",
    {
      description:
        "Fetch Morpho Blue positions for a wallet across a given list of market IDs. Each market is identified by a bytes32 id (keccak256 of its MarketParams). Returns per-market supplied/borrowed assets and collateral.",
      inputSchema: getMorphoPositionsInput.shape,
    },
    handler(getMorphoPositions)
  );

  server.registerTool(
    "prepare_morpho_supply",
    {
      description:
        "Build an unsigned Morpho Blue supply transaction (deposits loan token for yield). Market params are resolved on-chain from the market id. Includes an approve step if needed.",
      inputSchema: prepareMorphoSupplyInput.shape,
    },
    handler(buildMorphoSupply)
  );

  server.registerTool(
    "prepare_morpho_withdraw",
    {
      description:
        "Build an unsigned Morpho Blue withdraw transaction (withdraws supplied loan token). Explicit amount only — \"max\" is not supported; query your position first.",
      inputSchema: prepareMorphoWithdrawInput.shape,
    },
    handler(buildMorphoWithdraw)
  );

  server.registerTool(
    "prepare_morpho_borrow",
    {
      description:
        "Build an unsigned Morpho Blue borrow transaction. Requires pre-existing collateral in the market.",
      inputSchema: prepareMorphoBorrowInput.shape,
    },
    handler(buildMorphoBorrow)
  );

  server.registerTool(
    "prepare_morpho_repay",
    {
      description:
        "Build an unsigned Morpho Blue repay transaction. Includes an approve step if needed. Explicit amount only — \"max\" is not supported.",
      inputSchema: prepareMorphoRepayInput.shape,
    },
    handler(buildMorphoRepay)
  );

  server.registerTool(
    "prepare_morpho_supply_collateral",
    {
      description:
        "Build an unsigned Morpho Blue supplyCollateral transaction — adds collateral to a market. Includes an approve step if needed.",
      inputSchema: prepareMorphoSupplyCollateralInput.shape,
    },
    handler(buildMorphoSupplyCollateral)
  );

  server.registerTool(
    "prepare_morpho_withdraw_collateral",
    {
      description:
        "Build an unsigned Morpho Blue withdrawCollateral transaction — removes collateral from a market. Explicit amount only.",
      inputSchema: prepareMorphoWithdrawCollateralInput.shape,
    },
    handler(buildMorphoWithdrawCollateral)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[recon-mcp] fatal:", err);
  process.exit(1);
});
