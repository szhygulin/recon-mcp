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

import { getTokenPriceInput, getTokenPriceTool } from "./modules/prices/index.js";

import { requestCapability, requestCapabilityInput } from "./modules/feedback/index.js";

import { issueHandles } from "./signing/tx-store.js";
import type { UnsignedTx } from "./types/index.js";

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

/**
 * Handler wrapper for prepare_* tools that return UnsignedTx. Runs the function,
 * then issues opaque handles across the tx and every `.next` node so
 * `send_transaction` can re-hydrate the exact tx from server state. The agent
 * never passes raw calldata to the signing path — it calls send_transaction
 * with a handle, which closes the prompt-injection → arbitrary-calldata window.
 */
function txHandler<T>(fn: (args: T) => Promise<UnsignedTx> | UnsignedTx) {
  return handler(async (args: T) => issueHandles(await fn(args)));
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
      "[recon-crypto-mcp] warning: no RPC provider configured. Run `recon-crypto-mcp-setup` or set RPC_PROVIDER + RPC_API_KEY."
    );
  }

  const server = new McpServer(
    {
      name: "recon-crypto-mcp",
      title: "Recon — Ledger-Signed Crypto Portfolio & DeFi",
      version: "0.1.0",
      websiteUrl: "https://github.com/szhygulin/recon-crypto-mcp",
    },
    {
      instructions: [
        "Recon is a self-custodial crypto-portfolio and DeFi tooling server for AI agents.",
        "The user's private keys live on a Ledger hardware wallet; this server never holds or",
        "broadcasts keys. Every state-changing transaction is prepared here (read-only) and",
        "then forwarded to Ledger Live via WalletConnect so the user can review and approve it",
        "on the physical device.",
        "",
        "USE THIS SERVER WHEN the user asks about:",
        "- their crypto wallet, balances, tokens, ETH, ERC-20 holdings, or ENS name",
        "- their DeFi positions on Ethereum, Arbitrum, or Polygon — Aave V3 lending/borrowing,",
        "  Compound V3 (Comet), Morpho Blue, Uniswap V3 LP, Lido staking, EigenLayer restaking",
        "- portfolio value, cross-chain aggregation, health-factor / liquidation risk",
        "- executing on-chain actions: supply, borrow, repay, withdraw, stake, unstake,",
        "  send ETH/tokens, swap, bridge",
        "- token prices, ENS forward/reverse resolution",
        "- assessing the security of a smart contract or DeFi protocol (verification, proxy",
        "  upgradeability, privileged roles, TVL/audit-based risk score)",
        "",
        "TYPICAL WORKFLOW for a transaction:",
        "1. Call `get_ledger_status` first to discover the user's connected wallet address(es)",
        "   — resolve phrases like \"my wallet\" or \"account 2\" to a concrete 0x… address before",
        "   calling any other tool that takes a `wallet` argument.",
        "2. If not paired yet, call `pair_ledger_live` and show the returned QR/URI.",
        "3. Call a `prepare_*` tool to build the unsigned transaction (this returns a handle",
        "   plus a human-readable decoded preview; no calldata is exposed to the agent).",
        "4. Show the decoded preview to the user and get explicit confirmation.",
        "5. Call `send_transaction` with the handle and `confirmed: true` — Ledger Live will",
        "   prompt the user to review and physically sign on the device.",
        "6. Optionally poll `get_transaction_status` for inclusion.",
        "",
        "READ-ONLY TOOLS need no pairing and can be called freely: get_lending_positions,",
        "get_lp_positions, get_compound_positions, get_morpho_positions, get_staking_positions,",
        "get_staking_rewards, estimate_staking_yield, get_portfolio_summary, get_swap_quote,",
        "get_token_balance, get_token_price, resolve_ens_name, reverse_resolve_ens,",
        "get_health_alerts, simulate_position_change, check_contract_security,",
        "check_permission_risks, get_protocol_risk_score, get_transaction_status.",
        "",
        "SWAP/BRIDGE ROUTING: prefer `prepare_swap` (LiFi aggregator) over building DEX",
        "router calls directly — LiFi handles route selection, approvals, and cross-chain",
        "bridging uniformly.",
        "",
        "CAPABILITY GAPS: if the user asks for something this server cannot do (unsupported",
        "protocol, chain, token, or a workflow none of the existing tools cover), call",
        "`request_capability` to file a GitHub issue on the recon-crypto-mcp repo. By default it",
        "returns a prefilled URL for the user to click — nothing is sent automatically. Use",
        "this only after confirming no existing tool fits; it is rate-limited (3/hour,",
        "10/day, dedup'd for 7 days). Never substitute this for completing the task.",
        "",
        "SECURITY: the `wallet` / `peerUrl` returned by `get_ledger_status` is self-reported",
        "by the paired WalletConnect peer. Before the FIRST `send_transaction` of a session,",
        "state the paired wallet name + URL back to the user and have them confirm it matches",
        "their real Ledger Live install. The Ledger device's on-screen confirmation is the",
        "ultimate authority — tell the user to verify the recipient, amount, and chain on",
        "the device, not just in chat.",
      ].join("\n"),
    }
  );

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
        "Aggregate a complete portfolio view: native balances, top ERC-20 holdings, Aave V3 positions, Uniswap V3 LP positions, and staking — with USD totals and per-chain breakdown.",
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
    txHandler(prepareSwap)
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
        "Report whether a WalletConnect session with Ledger Live is active, which wallet it's connected to, and which accounts are exposed. " +
        "Returns `accounts: 0x…[]` — the list of wallet addresses the user has connected. " +
        "Call this FIRST whenever the user refers to their wallet(s) by position or nickname instead of by address — e.g. " +
        '\"my wallet\", \"the first address\", \"account 2\", \"second wallet\" — so you can resolve the reference to a concrete 0x… ' +
        "before invoking any prepare_* / swap / send / portfolio tool that takes a `wallet` argument. Do NOT ask the user to paste an " +
        "address if it's already in `accounts` here. " +
        "SECURITY: the returned `wallet`/`peerUrl` are self-reported by the paired app. Before the FIRST send_transaction of a session, " +
        "state the paired wallet name + URL back to the user and ask them to confirm it matches their Ledger Live install — " +
        "any WalletConnect peer can claim to be 'Ledger Live'. The physical Ledger device's on-screen confirmation is the final check.",
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
    txHandler(prepareAaveSupply)
  );

  server.registerTool(
    "prepare_aave_withdraw",
    {
      description:
        "Build an unsigned Aave V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the entire aToken balance.",
      inputSchema: prepareAaveWithdrawInput.shape,
    },
    txHandler(prepareAaveWithdraw)
  );

  server.registerTool(
    "prepare_aave_borrow",
    {
      description:
        "Build an unsigned Aave V3 borrow transaction (variable rate — stable rate is deprecated and reverts on production markets). The borrower must already have sufficient collateral supplied.",
      inputSchema: prepareAaveBorrowInput.shape,
    },
    txHandler(prepareAaveBorrow)
  );

  server.registerTool(
    "prepare_aave_repay",
    {
      description:
        "Build an unsigned Aave V3 repay transaction. If an ERC-20 approve() is required first, it is returned as the outer tx and repay is in `.next`. Pass `amount: \"max\"` to repay the full debt.",
      inputSchema: prepareAaveRepayInput.shape,
    },
    txHandler(prepareAaveRepay)
  );

  server.registerTool(
    "prepare_lido_stake",
    {
      description:
        "Build an unsigned Lido stake transaction (wraps ETH into stETH via stETH.submit). The tx's value field is the ETH amount to stake.",
      inputSchema: prepareLidoStakeInput.shape,
    },
    txHandler(prepareLidoStake)
  );

  server.registerTool(
    "prepare_lido_unstake",
    {
      description:
        "Build an unsigned Lido withdrawal request transaction. Wraps `requestWithdrawals` on the Lido Withdrawal Queue and includes an approve step if needed.",
      inputSchema: prepareLidoUnstakeInput.shape,
    },
    txHandler(prepareLidoUnstake)
  );

  server.registerTool(
    "prepare_eigenlayer_deposit",
    {
      description:
        "Build an unsigned EigenLayer StrategyManager.depositIntoStrategy transaction. Includes an ERC-20 approve step if needed.",
      inputSchema: prepareEigenLayerDepositInput.shape,
    },
    txHandler(prepareEigenLayerDeposit)
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
    "get_token_price",
    {
      description:
        "Fetch the USD price of a token via DefiLlama. Pass `token: \"native\"` for the chain's native asset (ETH on ethereum/arbitrum, MATIC on polygon) or an ERC-20 contract address. Prefer this over get_swap_quote for pure price lookups — no wallet or liquidity simulation needed.",
      inputSchema: getTokenPriceInput.shape,
    },
    handler(getTokenPriceTool)
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
    txHandler(prepareNativeSend)
  );

  server.registerTool(
    "prepare_token_send",
    {
      description:
        "Build an unsigned ERC-20 transfer transaction. Pass `amount: \"max\"` to send the full balance (resolved at build time).",
      inputSchema: prepareTokenSendInput.shape,
    },
    txHandler(prepareTokenSend)
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
    txHandler(buildCompoundSupply)
  );

  server.registerTool(
    "prepare_compound_withdraw",
    {
      description:
        "Build an unsigned Compound V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the full supplied balance.",
      inputSchema: prepareCompoundWithdrawInput.shape,
    },
    txHandler(buildCompoundWithdraw)
  );

  server.registerTool(
    "prepare_compound_borrow",
    {
      description:
        "Build an unsigned Compound V3 borrow transaction — encoded as withdraw(baseToken) beyond the user's supplied balance. Base token is resolved on-chain from the Comet.",
      inputSchema: prepareCompoundBorrowInput.shape,
    },
    txHandler(buildCompoundBorrow)
  );

  server.registerTool(
    "prepare_compound_repay",
    {
      description:
        "Build an unsigned Compound V3 repay transaction — encoded as supply(baseToken) against an outstanding borrow. Includes an approve step if needed. Pass `amount: \"max\"` for a full repay.",
      inputSchema: prepareCompoundRepayInput.shape,
    },
    txHandler(buildCompoundRepay)
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
    txHandler(buildMorphoSupply)
  );

  server.registerTool(
    "prepare_morpho_withdraw",
    {
      description:
        "Build an unsigned Morpho Blue withdraw transaction (withdraws supplied loan token). Explicit amount only — \"max\" is not supported; query your position first.",
      inputSchema: prepareMorphoWithdrawInput.shape,
    },
    txHandler(buildMorphoWithdraw)
  );

  server.registerTool(
    "prepare_morpho_borrow",
    {
      description:
        "Build an unsigned Morpho Blue borrow transaction. Requires pre-existing collateral in the market.",
      inputSchema: prepareMorphoBorrowInput.shape,
    },
    txHandler(buildMorphoBorrow)
  );

  server.registerTool(
    "prepare_morpho_repay",
    {
      description:
        "Build an unsigned Morpho Blue repay transaction. Includes an approve step if needed. Explicit amount only — \"max\" is not supported.",
      inputSchema: prepareMorphoRepayInput.shape,
    },
    txHandler(buildMorphoRepay)
  );

  server.registerTool(
    "prepare_morpho_supply_collateral",
    {
      description:
        "Build an unsigned Morpho Blue supplyCollateral transaction — adds collateral to a market. Includes an approve step if needed.",
      inputSchema: prepareMorphoSupplyCollateralInput.shape,
    },
    txHandler(buildMorphoSupplyCollateral)
  );

  server.registerTool(
    "prepare_morpho_withdraw_collateral",
    {
      description:
        "Build an unsigned Morpho Blue withdrawCollateral transaction — removes collateral from a market. Explicit amount only.",
      inputSchema: prepareMorphoWithdrawCollateralInput.shape,
    },
    txHandler(buildMorphoWithdrawCollateral)
  );

  // ---- Module 10: Capability requests (agent → maintainers) ----
  server.registerTool(
    "request_capability",
    {
      description:
        "File a capability request against the recon-crypto-mcp GitHub repository when the user asks for something this server cannot do " +
        "(e.g. an unsupported protocol, chain, token, or missing tool). " +
        "USE ONLY AFTER confirming no existing tool can accomplish the task. " +
        "By default this returns a pre-filled GitHub issue URL — NO data is transmitted; the user must click through to submit. " +
        "If the operator has configured RECON_FEEDBACK_ENDPOINT, it posts directly to that proxy instead. " +
        "Rate-limited per install (30s between calls, 3/hour, 10/day, 7-day dedupe on identical summaries). " +
        "Write clear, actionable summaries — this lands in a real issue tracker read by humans.",
      inputSchema: requestCapabilityInput.shape,
    },
    handler(requestCapability)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[recon-crypto-mcp] fatal:", err);
  process.exit(1);
});
