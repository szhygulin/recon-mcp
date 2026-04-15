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
  pairLedgerTron,
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
  pairLedgerTronInput,
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

import { getTronStaking } from "./modules/tron/staking.js";
import { listTronWitnesses } from "./modules/tron/witnesses.js";
import {
  buildTronNativeSend,
  buildTronTokenSend,
  buildTronClaimRewards,
  buildTronFreeze,
  buildTronUnfreeze,
  buildTronWithdrawExpireUnfreeze,
  buildTronVote,
} from "./modules/tron/actions.js";
import {
  getTronStakingInput,
  prepareTronNativeSendInput,
  prepareTronTokenSendInput,
  prepareTronClaimRewardsInput,
  prepareTronFreezeInput,
  prepareTronUnfreezeInput,
  prepareTronWithdrawExpireUnfreezeInput,
  listTronWitnessesInput,
  prepareTronVoteInput,
} from "./modules/tron/schemas.js";

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

import { simulateTransaction } from "./modules/simulation/index.js";
import { simulateTransactionInput } from "./modules/simulation/schemas.js";

import { requestCapability, requestCapabilityInput } from "./modules/feedback/index.js";

import { issueHandles } from "./signing/tx-store.js";
import {
  renderTronVerificationBlock,
  renderVerificationBlock,
} from "./signing/render-verification.js";
import type { TxVerification, UnsignedTronTx, UnsignedTx } from "./types/index.js";

import { readUserConfig } from "./config/user-config.js";

/**
 * Collect rendered verification blocks from a result, walking `.next` for
 * EVM approve→action chains. Each prepared tx in the chain gets its own
 * block so the user can cross-check every hash they will sign — never a
 * single aggregated block that conflates two separate signatures.
 *
 * Unknown shapes return an empty array (non-prepare tools have no
 * verification field).
 */
function collectVerificationBlocks(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const blocks: string[] = [];
  // EVM path: UnsignedTx has `chain` / `to` / `data` / `value` / `verification` + optional `.next`.
  const r = result as Record<string, unknown>;
  const verification = r.verification as TxVerification | undefined;
  if (!verification) return blocks;
  const chain = r.chain as string | undefined;
  if (chain === "tron" && typeof r.rawDataHex === "string") {
    blocks.push(renderTronVerificationBlock(result as UnsignedTronTx & { verification: TxVerification }));
    return blocks;
  }
  if (typeof r.to === "string" && typeof r.data === "string" && typeof r.value === "string" && typeof chain === "string") {
    blocks.push(
      renderVerificationBlock(result as UnsignedTx & { verification: TxVerification }),
    );
    if (r.next) blocks.push(...collectVerificationBlocks(r.next));
  }
  return blocks;
}

/**
 * Wrap a plain async function into the shape MCP expects.
 * Returns `{ content: [{ type: "text", text }] }` on success,
 * `{ content, isError: true }` on failure.
 *
 * When the result carries a `verification` field (every `prepare_*` tool
 * output does), a SECOND text content block is appended with the rendered
 * "VERIFY BEFORE SIGNING" prose — decoder URL, local decode, comparison
 * string, payload hash, and the nudge to open the URL before approving.
 * The block lives next to the JSON so machine readers still get the
 * structured data AND the user sees the verification prose verbatim.
 */
function handler<T, R>(fn: (args: T) => Promise<R> | R) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: JSON.stringify(result, bigintReplacer, 2) },
      ];
      for (const block of collectVerificationBlocks(result)) {
        content.push({ type: "text", text: block });
      }
      return { content };
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
      "[vaultpilot-mcp] warning: no RPC provider configured. Run `vaultpilot-mcp-setup` or set RPC_PROVIDER + RPC_API_KEY."
    );
  }

  const server = new McpServer(
    {
      name: "vaultpilot-mcp",
      title: "VaultPilot — Ledger-Signed Crypto Portfolio & DeFi",
      version: "0.1.0",
      websiteUrl: "https://github.com/szhygulin/vaultpilot-mcp",
    },
    {
      instructions: [
        "VaultPilot is a self-custodial crypto-portfolio and DeFi tooling server for AI agents.",
        "The user's private keys live on a Ledger hardware wallet; this server never holds or",
        "broadcasts keys. Every state-changing transaction is prepared here (read-only) and",
        "then forwarded to Ledger Live via WalletConnect so the user can review and approve it",
        "on the physical device.",
        "",
        "USE THIS SERVER WHEN the user asks about:",
        "- their crypto wallet, balances, tokens, ETH, ERC-20 holdings, or ENS name",
        "- their DeFi positions on Ethereum, Arbitrum, Polygon, or Base — Aave V3 lending/",
        "  borrowing, Compound V3 (Comet), Morpho Blue (Ethereum), Uniswap V3 LP, Lido staking",
        "  (Ethereum/Arbitrum), EigenLayer restaking (Ethereum)",
        "- their TRON balances (TRX + TRC-20 — USDT, USDC, USDD, TUSD) when the user",
        "  supplies a base58 address (prefix T) via the `tronAddress` arg on",
        "  `get_portfolio_summary` or the `chain: \"tron\"` branch of `get_token_balance`.",
        "- their TRON staking: claimable voting rewards, frozen TRX (Stake 2.0),",
        "  and pending unfreezes — via `get_tron_staking` or folded into",
        "  `get_portfolio_summary` when a `tronAddress` is passed. TRON has no",
        "  lending/LP coverage in this server (not deployed there).",
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
        "TWO-STEP ALLOWANCE FLOWS: when a `prepare_*` tool returns an approval tx alongside",
        "the main tx (supply, repay, swap, etc.), submit the approval via `send_transaction`",
        "FIRST, then POLL `get_transaction_status` until the approval is included (status",
        "`confirmed`). Only AFTER that, simulate or send the main tx. Simulating the main tx",
        "against pre-approval state fails with \"insufficient allowance\" / ERC20 reverts and",
        "looks like a builder bug — it is not, the allowance just isn't on-chain yet.",
        "",
        "READ-ONLY TOOLS need no pairing and can be called freely: get_lending_positions,",
        "get_lp_positions, get_compound_positions, get_morpho_positions, get_staking_positions,",
        "get_staking_rewards, estimate_staking_yield, get_portfolio_summary, get_swap_quote,",
        "get_token_balance, get_token_price, resolve_ens_name, reverse_resolve_ens,",
        "get_tron_staking, get_health_alerts, simulate_position_change,",
        "check_contract_security, check_permission_risks, get_protocol_risk_score,",
        "get_transaction_status.",
        "",
        "SWAP/BRIDGE ROUTING: prefer `prepare_swap` (LiFi aggregator) over building DEX",
        "router calls directly — LiFi handles route selection, approvals, and cross-chain",
        "bridging uniformly.",
        "",
        "CAPABILITY GAPS: if the user asks for something this server cannot do (unsupported",
        "protocol, chain, token, or a workflow none of the existing tools cover), call",
        "`request_capability` to file a GitHub issue on the vaultpilot-mcp repo. By default it",
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
        "Project annual yield on a hypothetical staking amount for Lido or EigenLayer using current APRs. Use this for 'what would I earn if I staked X ETH?' questions before the user commits capital. Returns the protocol, input amount, APR used, and projected annual rewards denominated in the same asset. Purely forward-looking — does NOT read any wallet or on-chain position; pair with `get_staking_positions` for actual holdings.",
      inputSchema: estimateStakingYieldInput.shape,
    },
    handler(estimateStakingYield)
  );

  // ---- Module 4: Portfolio ----
  server.registerTool(
    "get_portfolio_summary",
    {
      description:
        "One-shot cross-chain portfolio aggregation for one or more wallets. Fans out across Ethereum/Arbitrum/Polygon/Base (unless `chains` narrows it) and assembles: native ETH/MATIC balances, top ERC-20 holdings, Aave V3 and Compound V3 lending positions, Uniswap V3 LP positions, and Lido/EigenLayer staking — each valued in USD via DefiLlama. Pass `tronAddress` (base58, prefix T) alongside a single `wallet` to fold TRX + TRC-20 balances plus TRON staking into the same totals; `breakdown.tron` holds the TRON slice, `tronUsd` the subtotal, and `tronStakingUsd` the staking portion. Returns a `totalUsd`, a `breakdown` by category and by chain, and the raw per-protocol position arrays. Default tool for 'what's in my portfolio?' / 'total value' questions; prefer it over calling each per-protocol reader separately.",
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
        "Initiate a WalletConnect v2 pairing session with Ledger Live. Returns a URI and ASCII QR code — paste into Ledger Live's WalletConnect screen to complete pairing. The session persists for future transactions. EVM chains only; for TRON use `pair_ledger_tron` instead.",
      inputSchema: pairLedgerLiveInput.shape,
    },
    handler(pairLedgerLive)
  );

  server.registerTool(
    "pair_ledger_tron",
    {
      description:
        "Pair the host's directly-connected Ledger device for TRON signing. REQUIREMENTS: Ledger plugged into the machine running this MCP (USB, not WalletConnect), device unlocked, and the 'Tron' app open on-screen. Ledger Live's WalletConnect relay does not currently honor the `tron:` CAIP namespace, so TRON signing goes over USB HID via @ledgerhq/hw-app-trx. Reads the device address at m/44'/195'/<accountIndex>'/0/0 (default accountIndex=0) and caches it so `get_ledger_status` can report it. Call multiple times with different `accountIndex` values (0, 1, 2, …) to pair additional TRON accounts — each call adds to the cache; subsequent calls for the same index refresh in place. Call this once per session (per account) before calling any `prepare_tron_*` tool or `send_transaction` with a TRON handle. If the TRON app isn't open, or the device is locked, returns an actionable error describing what to fix.",
      inputSchema: pairLedgerTronInput.shape,
    },
    handler(pairLedgerTron)
  );

  server.registerTool(
    "get_ledger_status",
    {
      description:
        "Report whether a WalletConnect session with Ledger Live is active (EVM chains) AND whether any TRON Ledger pairings are cached (USB HID — see `pair_ledger_tron`). " +
        "Returns `accounts: 0x…[]` — the list of EVM wallet addresses the user has connected — and optionally `tron: [{ address, path, appVersion, accountIndex }, …]` (one entry per paired TRON account, ordered by accountIndex) if `pair_ledger_tron` has been run at least once. " +
        "Call this FIRST whenever the user refers to their wallet(s) by position or nickname instead of by address — e.g. " +
        '\"my wallet\", \"my TRON wallet\", \"the first address\", \"account 2\", \"second wallet\", \"second TRON account\" — so you can resolve the reference to a concrete 0x… / T… ' +
        "before invoking any prepare_* / swap / send / portfolio tool that takes a `wallet` / `tronAddress` argument. Do NOT ask the user to paste an " +
        "address if it's already in `accounts` or a `tron[*].address` here. " +
        "SECURITY: the returned `wallet`/`peerUrl` (EVM) are self-reported by the paired WC app. Before the FIRST send_transaction of a session, " +
        "state the paired wallet name + URL back to the user and ask them to confirm it matches their Ledger Live install — " +
        "any WalletConnect peer can claim to be 'Ledger Live'. The physical Ledger device's on-screen confirmation is the final check. " +
        "The `tron` array is read from the cache populated by `pair_ledger_tron`; `send_transaction` re-probes USB on every TRON sign, so the cache cannot be spoofed into approving a tx for the wrong account.",
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
        "Forward an already-prepared transaction to the Ledger device for user signing. Routes on the handle's origin: EVM handles (prepare_aave_*, prepare_compound_*, prepare_swap, prepare_native_send, ...) go through Ledger Live via WalletConnect; TRON handles (prepare_tron_*) go through the directly-connected Ledger over USB HID and are broadcast via TronGrid. In both cases the user must review and physically approve the tx on the Ledger screen; this call blocks until the user signs or rejects. " +
        "You MUST pass `confirmed: true` — the agent is affirming that the user has seen and acknowledged the decoded preview. " +
        "For TRON handles, `pair_ledger_tron` must have been called at least once per session (so the TRON app has been opened on the device) and the Ledger must still be plugged in with the TRON app open at send time.",
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

  server.registerTool(
    "simulate_transaction",
    {
      description:
        "Run an eth_call against the chain's RPC to simulate a transaction without signing or broadcasting it. " +
        "Returns `{ ok, returnData?, revertReason? }`. Use this BEFORE prepare_*/send_transaction to verify " +
        "a contract call does what you expect — e.g. does wrapping ETH by sending to WETH9's fallback succeed, " +
        "does a custom calldata revert, what selector gets hit. For state-dependent calls (WETH deposit credits " +
        "msg.sender, ERC-20 transfer debits msg.sender), pass the user's wallet as `from`. Prepared transactions " +
        "are also re-simulated automatically at send_transaction time — this tool lets the agent check ahead. " +
        "NEVER call this on a tx that depends on an approval you just submitted but haven't yet waited on: " +
        "the approval must be included on-chain (poll get_transaction_status until confirmed) before the " +
        "dependent tx will simulate correctly — otherwise you get a misleading 'insufficient allowance' revert.",
      inputSchema: simulateTransactionInput.shape,
    },
    handler(simulateTransaction)
  );

  // ---- Module 7: Balances & ENS ----
  server.registerTool(
    "get_token_balance",
    {
      description:
        "Fetch a wallet's balance of any ERC-20 token or the chain's native coin. Pass `token: \"native\"` for ETH (or chain-native asset) or an ERC-20 contract address. Returns amount, decimals, symbol, and USD value. For TRON, pass `chain: \"tron\"` with a base58 wallet (prefix T) and either `token: \"native\"` for TRX or a base58 TRC-20 address; returns a TronBalance (same fields, base58 token id).",
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
    "get_tron_staking",
    {
      description:
        "Read TRON staking state for a base58 address: claimable voting rewards (WithdrawBalance-ready), frozen TRX under Stake 2.0 (bandwidth + energy), and pending unfreezes with their unlock timestamps. Returns raw SUN + formatted TRX + USD values, plus a `totalStakedUsd` rollup. Read-only; pair with `prepare_tron_claim_rewards` to actually withdraw the accumulated reward.",
      inputSchema: getTronStakingInput.shape,
    },
    handler((args: { address: string }) => getTronStaking(args.address))
  );

  server.registerTool(
    "prepare_tron_native_send",
    {
      description:
        "Build an unsigned TRON native TRX send transaction via TronGrid's /wallet/createtransaction. Returns a human-readable preview + opaque handle. Forward the handle via `send_transaction` to sign on the directly-connected Ledger (USB HID via @ledgerhq/hw-app-trx) and broadcast to TronGrid. Run `pair_ledger_tron` once per session first so the TRON app is open and the device address is verified.",
      inputSchema: prepareTronNativeSendInput.shape,
    },
    handler(buildTronNativeSend)
  );

  server.registerTool(
    "prepare_tron_token_send",
    {
      description:
        "Build an unsigned TRC-20 transfer transaction (canonical set only: USDT, USDC, USDD, TUSD) via TronGrid's /wallet/triggersmartcontract. Decimals are resolved from the canonical table — unknown TRC-20s are rejected with an explicit error. Default fee_limit is 100 TRX (TronLink/Ledger Live default); override with `feeLimitTrx` if energy pricing has moved. Returns a preview + opaque handle. Forward via `send_transaction` for USB-HID signing on the paired Ledger. USDT renders natively on the TRON app; other TRC-20s may display raw hex on-device (the contract address and amount are still shown, so the user can verify against the preview).",
      inputSchema: prepareTronTokenSendInput.shape,
    },
    handler(buildTronTokenSend)
  );

  server.registerTool(
    "prepare_tron_claim_rewards",
    {
      description:
        "Build an unsigned TRON WithdrawBalance transaction that claims accumulated voting rewards to the owner's balance. TRON enforces a 24-hour cooldown between claims — TronGrid will reject (surfaced as an error) if the previous claim was inside the window. Pair with `get_tron_staking` first to read `claimableRewards` and avoid empty-claim tx builds. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronClaimRewardsInput.shape,
    },
    handler(buildTronClaimRewards)
  );

  server.registerTool(
    "prepare_tron_freeze",
    {
      description:
        "Build an unsigned TRON Stake 2.0 FreezeBalanceV2 transaction. Locks TRX to earn `bandwidth` (fuels plain transfers) or `energy` (fuels smart-contract calls) and gains proportional voting power. IMPORTANT: freezing alone does NOT accrue TRX rewards — `claimableRewards` (see `get_tron_staking`) only grows after the user also votes for a Super Representative. Pair this tool with `list_tron_witnesses` + `prepare_tron_vote` for the full reward-earning flow. Unlocking requires a 14-day cooldown via `prepare_tron_unfreeze` + `prepare_tron_withdraw_expire_unfreeze`. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronFreezeInput.shape,
    },
    handler(buildTronFreeze)
  );

  server.registerTool(
    "prepare_tron_unfreeze",
    {
      description:
        "Build an unsigned TRON Stake 2.0 UnfreezeBalanceV2 transaction — begins the 14-day cooldown on a previously-frozen slice. The `amount` must not exceed what's currently frozen for that resource (query `get_tron_staking` first; TronGrid rejects otherwise with 'less than frozen balance'). After 14 days the slice shows up in `pendingUnfreezes` with an elapsed `unlockAt`; call `prepare_tron_withdraw_expire_unfreeze` to sweep it back to liquid TRX. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronUnfreezeInput.shape,
    },
    handler(buildTronUnfreeze)
  );

  server.registerTool(
    "prepare_tron_withdraw_expire_unfreeze",
    {
      description:
        "Build an unsigned TRON WithdrawExpireUnfreeze transaction — sweeps every matured unfreeze slice (those whose 14-day cooldown elapsed) back to liquid TRX. No amount needed; the chain drains all eligible slices in one call. Inspect `pendingUnfreezes` from `get_tron_staking` first — if every entry's `unlockAt` is still in the future, TronGrid returns 'no expire unfreeze' and this tool errors. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronWithdrawExpireUnfreezeInput.shape,
    },
    handler(buildTronWithdrawExpireUnfreeze)
  );

  server.registerTool(
    "list_tron_witnesses",
    {
      description:
        "List TRON Super Representatives (SRs) + SR candidates, ranked by total vote count. Active SRs (rank ≤ 27, `isActive: true`) produce blocks and distribute the 160 TRX/block voter-reward pool pro-rata to their voters; every witness in the top 127 shares the same APR estimate (pro-rata split of the pool); witnesses ranked > 127 get `estVoterApr: 0`. APR estimates assume current mainnet constants (3-second blocks, 27 active SRs, 365 days/year) and are best-effort — actual rewards depend on missed blocks and competing voters shifting between your vote tx and reward claim. When `address` is passed, also returns `userVotes`, `totalTronPower`, `totalVotesCast`, and `availableVotes` so you can diff against a target allocation before calling `prepare_tron_vote`. Defaults to top-27 only; pass `includeCandidates: true` for the long tail.",
      inputSchema: listTronWitnessesInput.shape,
    },
    handler((args: { address?: string; includeCandidates?: boolean }) =>
      listTronWitnesses(args.address, args.includeCandidates ?? false)
    )
  );

  server.registerTool(
    "prepare_tron_vote",
    {
      description:
        "Build an unsigned TRON VoteWitnessContract transaction — casts votes for Super Representatives to earn voting rewards on frozen TRX. IMPORTANT: VoteWitness REPLACES the wallet's entire prior vote allocation atomically. Pass every SR you intend to back (not just a delta); an empty `votes` array clears all votes. Sum of `count` values must not exceed the wallet's available TRON Power — check `list_tron_witnesses(address)` → `availableVotes` first. `count` is an integer (1 vote = 1 TRX of TRON Power). Rewards accrue per block and are harvested via `prepare_tron_claim_rewards` (24h cooldown). Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronVoteInput.shape,
    },
    handler(buildTronVote)
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
        "Fetch Compound V3 (Comet) positions for a wallet across all known markets on the selected chains (cUSDCv3, cUSDTv3, cWETHv3, etc.). For each market the wallet touches, returns the base-token supply or borrow balance, per-asset collateral deposits, and USD valuations. Use this to answer 'my Compound positions' or before preparing a `prepare_compound_*` action so you have the right market address. Returns an empty list if the wallet has no Compound V3 exposure on the requested chains.",
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
        "Build an unsigned Compound V3 borrow transaction. Compound V3 encodes a borrow as `withdraw(baseToken)` drawn beyond the wallet's supplied balance — the base token is resolved on-chain from the Comet market so you only pass the market address and amount. Requires the wallet to have already supplied enough collateral in that market; `get_compound_positions` shows the current collateral mix. Returns a handle + human-readable preview for the user to sign on Ledger; no approval step is needed (borrowing doesn't pull tokens from the wallet).",
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
        "Fetch Morpho Blue positions for a wallet. If `marketIds` is omitted, the server auto-discovers the wallet's markets by scanning Morpho Blue event logs (may take several seconds on a cold call). Pass explicit `marketIds` (bytes32 each, keccak256 of MarketParams) as a fast path. Returns per-market supplied/borrowed assets and collateral.",
      inputSchema: getMorphoPositionsInput.shape,
    },
    handler(getMorphoPositions)
  );

  server.registerTool(
    "prepare_morpho_supply",
    {
      description:
        "Build an unsigned Morpho Blue supply transaction — deposits the market's loan token to earn lending yield. Market params (loan/collateral tokens, oracle, IRM, LLTV) are resolved on-chain from the market id, so only wallet/marketId/amount are required. If the wallet's current allowance is insufficient, an ERC-20 approve tx is emitted first (chainable via `.next`); control the cap with `approvalCap` (defaults to unlimited for UX, pass 'exact' or a decimal ceiling to scope it). Returns a handle + preview for Ledger signing.",
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
        "Build an unsigned Morpho Blue withdrawCollateral transaction — removes collateral from a market to send back to the wallet. Only withdraws the exact amount specified; `\"max\"` is NOT supported because Morpho's isolated-market accounting doesn't expose a clean max-safe value without simulating against the market's oracle/LLTV (query `get_morpho_positions` first to know your deposited collateral). Will revert on-chain if the withdrawal would push the position below the liquidation threshold. No approval step needed. Returns a handle + preview for Ledger signing.",
      inputSchema: prepareMorphoWithdrawCollateralInput.shape,
    },
    txHandler(buildMorphoWithdrawCollateral)
  );

  // ---- Module 10: Capability requests (agent → maintainers) ----
  server.registerTool(
    "request_capability",
    {
      description:
        "File a capability request against the vaultpilot-mcp GitHub repository when the user asks for something this server cannot do " +
        "(e.g. an unsupported protocol, chain, token, or missing tool). " +
        "USE ONLY AFTER confirming no existing tool can accomplish the task. " +
        "By default this returns a pre-filled GitHub issue URL — NO data is transmitted; the user must click through to submit. " +
        "If the operator has configured VAULTPILOT_FEEDBACK_ENDPOINT, it posts directly to that proxy instead. " +
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
  console.error("[vaultpilot-mcp] fatal:", err);
  process.exit(1);
});
