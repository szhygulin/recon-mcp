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

import { getTransactionHistory } from "./modules/history/index.js";
import { getTransactionHistoryInput } from "./modules/history/schemas.js";

import { getSwapQuote, prepareSwap } from "./modules/swap/index.js";
import { getSwapQuoteInput, prepareSwapInput } from "./modules/swap/schemas.js";
import { prepareUniswapSwap } from "./modules/uniswap-swap/index.js";
import { prepareUniswapSwapInput } from "./modules/uniswap-swap/schemas.js";

import { getSessionStatus as getLedgerStatus } from "./signing/session.js";
import {
  pairLedgerLive,
  pairLedgerTron,
  prepareAaveSupply,
  prepareAaveWithdraw,
  prepareAaveBorrow,
  prepareAaveRepay,
  prepareLidoStake,
  prepareLidoUnstake,
  prepareEigenLayerDeposit,
  prepareNativeSend,
  prepareTokenSend,
  previewSend,
  sendTransaction,
  getTransactionStatus,
  getTxVerification,
  getVerificationArtifact,
  verifyTxDecode,
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
  previewSendInput,
  sendTransactionInput,
  getTransactionStatusInput,
  getTxVerificationInput,
  getVerificationArtifactInput,
} from "./modules/execution/schemas.js";

import {
  getTokenBalance,
  getTokenMetadata,
  resolveName,
  reverseResolve,
} from "./modules/balances/index.js";
import {
  getTokenBalanceInput,
  getTokenMetadataInput,
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
import { getCompoundMarketInfo } from "./modules/compound/market-info.js";
import { getMarketIncidentStatus } from "./modules/incidents/index.js";
import { getMarketIncidentStatusInput } from "./modules/incidents/schemas.js";
import {
  buildCompoundSupply,
  buildCompoundWithdraw,
  buildCompoundBorrow,
  buildCompoundRepay,
} from "./modules/compound/actions.js";
import {
  getCompoundPositionsInput,
  getCompoundMarketInfoInput,
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
  renderAgentTaskBlock,
  renderLedgerHashBlock,
  renderPostBroadcastBlock,
  renderPostSendPollBlock,
  renderPrepareReceiptBlock,
  renderPreviewVerifyAgentTaskBlock,
  renderTronVerificationBlock,
  renderVerificationBlock,
  shouldRenderVerificationBlock,
} from "./signing/render-verification.js";
import { verifyEvmCalldata, type VerifyDecodeResult } from "./signing/verify-decode.js";
import type { SupportedChain, TxVerification, UnsignedTronTx, UnsignedTx } from "./types/index.js";
import type { SendTransactionArgs } from "./modules/execution/schemas.js";

import { readUserConfig } from "./config/user-config.js";

/**
 * Collect rendered verification blocks from a result, walking `.next` for
 * EVM approve→action chains. Each prepared tx in the chain gets its own
 * block so the user can cross-check every hash they will sign — never a
 * single aggregated block that conflates two separate signatures.
 *
 * Runs the independent 4byte.directory cross-check inline so its summary
 * is ALWAYS emitted, regardless of whether the agent remembers to call
 * `verify_tx_decode`. A compromised agent could previously skip the tool
 * and fabricate a "✓ cross-check passed" line; now the server emits the
 * real result adjacent to the verification block.
 *
 * Unknown shapes return an empty array (non-prepare tools have no
 * verification field).
 */
export async function collectVerificationBlocks(
  result: unknown,
  opts?: {
    verify?: (
      tx: UnsignedTx & { verification: TxVerification },
    ) => Promise<VerifyDecodeResult>;
  },
): Promise<string[]> {
  const verify = opts?.verify ?? verifyEvmCalldata;
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
    const tx = result as UnsignedTx & { verification: TxVerification };
    // ERC-20 approvals clear-sign on Ledger's Ethereum app — skip rendering
    // (the send-time payload-hash guard still runs, using tx.verification).
    if (shouldRenderVerificationBlock(tx)) {
      blocks.push(renderVerificationBlock(tx));
      // Auto-emit the independent 4byte.directory cross-check. If the network
      // call fails, verifyEvmCalldata returns an "error" summary — we still
      // emit it so the agent surfaces the degraded state to the user rather
      // than silently skipping.
      try {
        const cross = await verify(tx);
        blocks.push(
          `[CROSS-CHECK SUMMARY — RELAY VERBATIM TO USER AS THE FIRST LINE OF YOUR REPLY]\n${cross.summary}`,
        );
      } catch (e) {
        blocks.push(
          `[CROSS-CHECK SUMMARY — RELAY VERBATIM TO USER AS THE FIRST LINE OF YOUR REPLY]\n` +
            `Could not run the independent calldata cross-check this turn (${e instanceof Error ? e.message : String(e)}). ` +
            `The local ABI decode above is still shown; open the swiss-knife decoder URL in a browser for a manual check.`,
        );
      }
      // Per-call agent directives (compact bullet summary, two trust-boundary
      // options, Ledger-match reminder). Adjacent to the verification block so
      // the model is far more likely to act on it than on the session-level
      // instructions field, which it tends to ignore after the first few turns.
      const taskBlock = renderAgentTaskBlock(tx);
      if (taskBlock) blocks.push(taskBlock);
    }
    if (r.next) blocks.push(...(await collectVerificationBlocks(r.next, opts)));
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
function handler<T, R>(
  fn: (args: T) => Promise<R> | R,
  opts?: { toolName?: string },
) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: JSON.stringify(result, bigintReplacer, 2) },
      ];
      // Emit the prepare-receipt for every tool that built a transaction
      // (result carries `verification`). Gives the user a verbatim-relay view
      // of the args that hit the server, independent of the agent's bullet
      // summary — raises the tampering bar against narrow prompt injections
      // and malicious add-ons that rewrite args without also crafting an
      // output filter. See render-verification.ts for the full rationale.
      if (
        opts?.toolName &&
        result !== null &&
        typeof result === "object" &&
        "verification" in (result as Record<string, unknown>)
      ) {
        content.push({
          type: "text",
          text: renderPrepareReceiptBlock({
            tool: opts.toolName,
            args: (args ?? {}) as Record<string, unknown>,
          }),
        });
      }
      for (const block of await collectVerificationBlocks(result)) {
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
 *
 * `toolName` is the registered MCP tool name; it's threaded through so the
 * prepare-receipt block can label which tool was called with which args.
 */
function txHandler<T>(toolName: string, fn: (args: T) => Promise<UnsignedTx> | UnsignedTx) {
  return handler(async (args: T) => issueHandles(await fn(args)), { toolName });
}

/**
 * Handler wrapper for `preview_send`. Appends the user-facing LEDGER BLIND-
 * SIGN HASH block so the agent relays the hash verbatim BEFORE calling
 * `send_transaction` — which is the whole point of the preview step: the
 * user must see the hash on their screen before the Ledger device prompt
 * fires, since a single MCP tool call cannot emit content between pinning
 * and signing.
 */
function previewSendHandler(
  fn: (args: { handle: string }) => Promise<{
    handle: string;
    chain: SupportedChain;
    to: `0x${string}`;
    valueWei: string;
    preSignHash: `0x${string}`;
    pinned: {
      nonce: number;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
      gas: string;
    };
    previewToken: string;
    decoderUrl?: string;
  }>,
) {
  return async (args: { handle: string }) => {
    try {
      const result = await fn(args);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, bigintReplacer, 2) },
          {
            type: "text" as const,
            text: renderLedgerHashBlock({
              preSignHash: result.preSignHash,
              to: result.to,
              valueWei: result.valueWei,
            }),
          },
          // Agent-task block: offer the user an independent hash re-computation
          // against a compromised MCP that lies about the hash. Optional, not
          // run unprompted. Emitting it here (per-call) keeps the values in-
          // context for the agent to splice into the local viem command.
          {
            type: "text" as const,
            text: renderPreviewVerifyAgentTaskBlock({
              chain: result.chain,
              preSignHash: result.preSignHash,
              pinned: result.pinned,
              to: result.to,
              valueWei: result.valueWei,
              ...(result.decoderUrl ? { decoderUrl: result.decoderUrl } : {}),
            }),
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
 * Handler wrapper for `send_transaction`. Emits a user-facing post-broadcast
 * block with the txHash + explorer link (so the agent cannot silently drop
 * the hash from the chat — a live-test regression that motivated this
 * block), followed by an agent-task block directing self-polling via
 * `get_transaction_status`. The session-level instructions tend to drift out
 * of attention after a few hundred tokens, so we put the directive adjacent
 * to the txHash it refers to.
 */
function sendTransactionHandler(
  fn: (args: SendTransactionArgs) => Promise<{
    txHash: `0x${string}` | string;
    chain: SupportedChain | "tron";
    nextHandle?: string;
    preSignHash?: `0x${string}`;
    to?: `0x${string}`;
    valueWei?: string;
  }>,
) {
  return async (args: SendTransactionArgs) => {
    try {
      const result = await fn(args);
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: JSON.stringify(result, bigintReplacer, 2) },
        {
          type: "text",
          text: renderPostBroadcastBlock({
            chain: String(result.chain),
            txHash: String(result.txHash),
            ...(result.preSignHash ? { preSignHash: result.preSignHash } : {}),
          }),
        },
        {
          type: "text",
          text: renderPostSendPollBlock({
            chain: String(result.chain),
            txHash: String(result.txHash),
            ...(result.nextHandle ? { nextHandle: result.nextHandle } : {}),
          }),
        },
      ];
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
        "5. FOR EVM HANDLES ONLY: call `preview_send(handle)` BEFORE `send_transaction`. It pins",
        "   nonce + EIP-1559 fees server-side and returns a LEDGER BLIND-SIGN HASH content block.",
        "   Relay that block VERBATIM to the user so the hash is on-screen when the Ledger device",
        "   prompt later appears. Skip this step for TRON handles — they use USB-HID signing with",
        "   native clear-sign screens, no WalletConnect hash.",
        "6. Call `send_transaction` with the handle, `confirmed: true`, and (EVM only) the",
        "   `previewToken` value returned by step 5 plus `userDecision: \"send\"`. Ledger Live",
        "   will prompt the user to review and physically sign on the device. For EVM handles",
        "   this reads the pin from step 5; if you skipped preview_send it throws \"Missing",
        "   pinned gas\". The previewToken + userDecision pair is the schema-level gate that",
        "   proves preview_send actually ran and that the EXTRA CHECKS menu was surfaced to",
        "   the user — omit either and send_transaction refuses with a clear error explaining",
        "   the fix. TRON handles ignore these two args.",
        "7. After `send_transaction` returns a txHash, relay the TRANSACTION BROADCAST block",
        "   VERBATIM to the user (it carries the hash + explorer link — do NOT drop it), THEN",
        "   poll `get_transaction_status` YOURSELF every ~5s until status is `success` or",
        "   `failed` (budget ~2min). Do NOT stop and wait for the user to type \"next\" — the",
        "   per-call AGENT TASK block emitted alongside the txHash prescribes the exact cadence.",
        "",
        "TWO-STEP ALLOWANCE FLOWS: when a `prepare_*` tool returns an approval tx alongside",
        "the main tx (supply, repay, swap, etc.), submit the approval FIRST via preview_send",
        "→ send_transaction. The post-send auto-poll (step 7) is how you wait for the approval",
        "to be included — do not ask the user to confirm inclusion. Only AFTER status flips to",
        "`success`, call preview_send on the nextHandle and then send the main tx. Simulating",
        "or previewing against pre-approval state fails with \"insufficient allowance\" / ERC20",
        "reverts and looks like a builder bug — it is not, the allowance just isn't on-chain yet.",
        "",
        "READ-ONLY TOOLS need no pairing and can be called freely: get_lending_positions,",
        "get_lp_positions, get_compound_positions, get_compound_market_info,",
        "get_market_incident_status,",
        "get_morpho_positions, get_staking_positions,",
        "get_staking_rewards, estimate_staking_yield, get_portfolio_summary, get_swap_quote,",
        "get_token_balance, get_token_price, get_token_metadata, resolve_ens_name,",
        "reverse_resolve_ens,",
        "get_tron_staking, get_health_alerts, simulate_position_change,",
        "check_contract_security, check_permission_risks, get_protocol_risk_score,",
        "get_transaction_status, get_tx_verification, get_verification_artifact.",
        "",
        "SWAP/BRIDGE ROUTING: default to `prepare_swap` (LiFi aggregator) — it handles route",
        "selection, approvals, and cross-chain bridging uniformly. EXCEPTION: when the user",
        "EXPLICITLY names a direct DEX venue (e.g. \"swap on Uniswap\", \"via Uniswap\"), use the",
        "matching direct-DEX tool instead so their stated venue choice is honoured rather than",
        "re-routed by the aggregator. Available direct-DEX tools: `prepare_uniswap_swap`",
        "(Uniswap V3, same-chain only). If the user asks for a venue we do not have a direct",
        "tool for (Sushi/Curve/Balancer/etc.), fall back to `prepare_swap` AND note that the",
        "aggregator picked the actual venue — do NOT silently claim you used the requested one.",
        "",
        "CAPABILITY GAPS: if the user asks for something this server cannot do (unsupported",
        "protocol, chain, token, venue, or a workflow none of the existing tools cover), do",
        "NOT just mention the limitation in passing as a bullet the user has to act on",
        "themselves. PROACTIVELY OFFER to file a capability request by asking: \"Want me to",
        "file this as a feature request against the vaultpilot-mcp repo?\" If the user says",
        "yes, call `request_capability` — it returns a prefilled GitHub-issue URL for the",
        "user to click (nothing is sent automatically unless a feedback endpoint is",
        "configured). This applies even when you also recommend a workaround in the SAME",
        "reply (a different UI, a different tool, an alternate flow): the workaround and",
        "the feature-request offer are complementary, not substitutes. Use only after",
        "confirming no existing tool fits; rate-limited (3/hour, 10/day, 7-day dedup).",
        "Never substitute this for completing the task when a tool already covers it.",
        "",
        "TRANSACTION VERIFICATION (CRITICAL — DO NOT SKIP): most `prepare_*` tools return",
        "MULTIPLE text content elements after the JSON. The order is: (1) the VERIFY-",
        "BEFORE-SIGNING block; (2) the [CROSS-CHECK SUMMARY] block produced by the server's",
        "4byte.directory independent decode; (3) the [AGENT TASK] block with per-call",
        "directives. Do NOT relay the raw VERIFY-BEFORE-SIGNING block to the user — it is",
        "a wall of hex/struct data that drowns the sentence that matters. Instead, relay",
        "the CROSS-CHECK SUMMARY text VERBATIM as your first line(s), keep the ✓/✗ prefix",
        "unchanged, then produce a COMPACT bullet summary of the tx: a headline",
        "(\"Prepared <action> — <one-line summary>\"), then From / To (with a destination",
        "label when known, e.g. \"LiFi diamond\", \"Aave pool\") / Value (human + wei) /",
        "Function, plus the tx-specific field that matters for this flow (Min out for",
        "swaps, Amount for supplies/withdraws/sends, Spender+Cap for approves). Do NOT",
        "include a \"Short hash\" line in the bullet summary — our payloadHash does not",
        "match what Ledger displays on-device (Ledger hashes the full RLP including",
        "nonce + gas fields that Ledger Live picks at send time), and showing the short",
        "hash trains the user to rubber-stamp a real mismatch. The per-call AGENT TASK",
        "block prescribes the exact shape — follow it. You may label chain steps",
        "(\"STEP 1 — Approval\" / \"STEP 2 — Swap\"). ERC-20 approvals clear-sign natively on",
        "Ledger's Ethereum app, so the server intentionally does NOT emit a VERIFY /",
        "CROSS-CHECK / AGENT TASK block for those — you'll only see blocks for the main",
        "action on approve→action chains. That is expected, not a bug. The send-time",
        "payload-hash guard still runs on every tx. FOR APPROVAL STEPS, tell the user",
        "exactly what to eyeball on their Ledger screen: (1) the spender address matches",
        "the protocol they intended to authorize (LiFi diamond for swaps, the Aave /",
        "Compound / Morpho pool for lending, etc. — state the address and the protocol",
        "name), and (2) the approved amount matches the amount they asked for (in human",
        "units, not wei). If either differs, they MUST reject on-device. For all OTHER",
        "txs (non-approve), the end-of-reply Ledger reminder must cover both on-device",
        "modes honestly: CLEAR-SIGN (device shows decoded fields via a plugin — confirm",
        "function + key field from the bullet summary) AND BLIND-SIGN (device shows a",
        "hash — match it against the LEDGER BLIND-SIGN HASH block `send_transaction`",
        "emits, and additionally verify To = <to address> and Value = <human native",
        "amount>; reject if anything doesn't match). Never claim our prepare-time",
        "payloadHashShort equals the Ledger hash — those are different preimages. The",
        "send-time block is the authoritative source.",
        "",
        "LEDGER BLIND-SIGN HASH (PRE-SIGN, via preview_send): a single MCP tool call cannot",
        "emit content WHILE the Ledger device prompt is open, so the hash must be surfaced in",
        "a separate step. For every EVM send, call `preview_send(handle)` BEFORE calling",
        "`send_transaction`. preview_send pins nonce + EIP-1559 fees server-side, stashes them",
        "on the handle, computes the EIP-1559 pre-sign RLP hash, and returns a \"LEDGER BLIND-",
        "SIGN HASH — RELAY VERBATIM TO USER; THEY MATCH ON-DEVICE\" content block. Forward",
        "that block VERBATIM — do not collapse it into a summary. Only after the user has",
        "seen the hash should you call send_transaction (which then reads the pin and forwards",
        "it via WalletConnect). The Edit-gas paragraph in the block is load-bearing: if the",
        "user taps \"Edit gas\" / \"Edit fees\" in Ledger Live, the on-device hash will",
        "legitimately diverge. The block lets the user decide — they may accept the divergence",
        "(at which point the server's hash-match guarantee no longer applies and they are",
        "signing without the calldata-integrity check), or reject and call preview_send again",
        "for a fresh pin. Do NOT rewrite that paragraph as a flat \"you must reject\" — the",
        "user's choice is part of the contract. If send_transaction throws \"Missing pinned",
        "gas\", you skipped preview_send — call it and retry. This step is EVM-only; TRON uses",
        "USB-HID clear-signing with no hash block.",
        "",
        "POST-BROADCAST (after send_transaction): the server emits a \"TRANSACTION BROADCAST —",
        "RELAY VERBATIM TO USER\" block carrying the txHash + block-explorer link. Forward it",
        "VERBATIM — a live-test regression showed the agent sometimes dropped the hash from",
        "the chat, forcing the user to dig through Ledger Live. Never summarize away the hash.",
        "",
        "INDEPENDENT CROSS-CHECK: the server now runs the 4byte.directory decode",
        "automatically for every prepared EVM tx and emits the result as a [CROSS-CHECK",
        "SUMMARY] text block in the response. You do NOT need to call `verify_tx_decode`",
        "separately — just relay the summary text verbatim. Do NOT script your own",
        "WebFetch to 4byte.directory or swiss-knife.xyz to duplicate the check — that",
        "bypasses the auditable code path and the summary text will disagree with the",
        "canonical one. `verify_tx_decode` is kept as a tool only for re-running the",
        "check against a still-open handle (e.g. after context compaction).",
        "",
        "RECOVERING A LOST VERIFICATION BLOCK: if the original prepare_* tool result has",
        "dropped out of your context (compaction, long session, multi-agent handoff),",
        "call `get_tx_verification(handle)` to have the server re-emit the same JSON +",
        "VERIFY-BEFORE-SIGNING block from in-memory state. The handle lives 15 minutes.",
        "DO NOT read tool-result JSON files from disk (e.g. via Bash + python or jq) to",
        "recover the verification data — that scrapes harness internals, produces brittle",
        "code per call, and bypasses the MCP boundary that exists to keep this auditable.",
        "",
        "AGENT-SIDE VERIFICATION SCRIPTS: if you choose to run a short independent check",
        "in a shell (e.g. recomputing the EIP-1559 pre-sign hash locally with viem to",
        "cross-check preview_send's preSignHash), invoke it as a `node -e '…'` one-liner",
        "via Bash — do NOT Write a temporary `.cjs`/`.js` file to disk. Temp files clutter",
        "the chat with a code-snippet block the user has to scroll past and leave stray",
        "artifacts in the project tree; a single `node -e` line keeps the verification",
        "step compact and self-contained. If the script is too quote-heavy for `-e`",
        "(imports plus multi-line logic), pipe a heredoc into `node` from Bash instead.",
        "Either way: no Write, no file to clean up.",
        "",
        "SECOND-AGENT VERIFICATION (strongest user-facing check — volunteer it, don't wait",
        "to be asked): `get_verification_artifact(handle)` returns a sparse JSON artifact",
        "(raw calldata, chain, to, value, payloadHash, preSignHash if pinned) plus a canned",
        "prompt for a second LLM. The user pastes it into an independent chat (ideally a",
        "different provider) so a second agent decodes the bytes from scratch with no",
        "shared context. If the first and second agents disagree on what the tx does, or",
        "the preSignHash in the artifact differs from what Ledger shows on-device, the",
        "user rejects. This is the ONLY check that survives a fully-coordinated compromise",
        "where this agent and the MCP would lie together — a second LLM in a separate",
        "provider cannot be coordinated with either. ACTIVELY OFFER it alongside (a)/(b)",
        "at prepare time for: swap/bridge calldata with an unknown 4-byte selector,",
        "txs touching unfamiliar contract addresses, approvals with large or unlimited",
        "caps, any tx moving >$1k of value, or any flow where the server's 4byte cross-",
        "check returned 'no-signature' or 'error'. Do NOT offer it in place of the normal",
        "VERIFY-BEFORE-SIGNING block — it's an additional check, not a replacement. The",
        "preview_send agent-task block also offers it again as a fifth trust-boundary",
        "option right before signing.",
        "",
        "SECURITY: the `wallet` / `peerUrl` returned by `get_ledger_status` is self-reported",
        "by the paired WalletConnect peer and is NOT a trusted identity — any peer can claim",
        "to be 'Ledger Live' at `wc.apps.ledger.com`. The real discriminator is the WC session",
        "`topic` (also returned by `get_ledger_status`). Before the FIRST `send_transaction`",
        "of a session, tell the user to open Ledger Live → Settings → Connected Apps (mobile:",
        "Manager → WalletConnect) and confirm a WC session is listed there whose topic ends",
        "with the last 8 characters of the `topic` field. Surface those 8 chars in your",
        "prompt (e.g. \"…a1b2c3d4\"). No matching session in Ledger Live means a different peer",
        "is impersonating Ledger Live — do NOT proceed. The Ledger device's on-screen",
        "confirmation is still the ultimate check on tx contents; the topic cross-check is",
        "what binds the WC session itself to the user's real Ledger Live install.",
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
        "Simulate the effect of adding or removing collateral, or borrowing/repaying debt on a lending position. Returns the projected health factor and collateral/debt totals. Supports Aave V3 (default), Compound V3 (pass `protocol: \"compound-v3\"` + `market` Comet address), and Morpho Blue (pass `protocol: \"morpho-blue\"` + `marketId` bytes32). No transaction is sent.",
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

  server.registerTool(
    "get_transaction_history",
    {
      description:
        "Fetch a wallet's recent on-chain transaction history on a single chain, merged across external (user-initiated) txs, ERC-20/TRC-20 token transfers, and internal (contract-initiated) txs. Results are sorted newest-first, capped at `limit` (default 25, max 50), and annotated with decoded method names (via 4byte.directory) and historical USD values at the time of each tx (via DefiLlama). Supports Ethereum/Arbitrum/Polygon/Base via Etherscan and TRON via TronGrid. TRON does not expose internal txs, so `includeInternal` is silently ignored there. Use this to answer 'what did I do last week?', 'show me my recent swaps', or 'did I already approve X?' without the user pasting tx hashes. Read-only — no signing, no broadcast.",
      inputSchema: getTransactionHistoryInput.shape,
    },
    handler(getTransactionHistory)
  );

  // ---- Module 5: Swap/Bridge (LiFi) ----
  server.registerTool(
    "get_swap_quote",
    {
      description:
        "Get a LiFi aggregator quote for a token swap (same-chain) or bridge (cross-chain). Returns expected output, fees, execution time, and the underlying tool selected. Default is exact-in (`amount` = fromToken); set `amountSide: \"to\"` for exact-out quotes (`amount` = target toToken output). No transaction is built.",
      inputSchema: getSwapQuoteInput.shape,
    },
    handler(getSwapQuote)
  );

  server.registerTool(
    "prepare_swap",
    {
      description:
        "Prepare an unsigned swap or bridge transaction via LiFi aggregator. Same-chain swaps use the best DEX route; cross-chain swaps use a bridge + DEX combo. Default is exact-in (`amount` = fromToken); set `amountSide: \"to\"` for exact-out (`amount` = target toToken output, e.g. \"I want 100 USDC out\"). The returned tx can be sent via `send_transaction`.",
      inputSchema: prepareSwapInput.shape,
    },
    txHandler("prepare_swap", prepareSwap)
  );

  server.registerTool(
    "prepare_uniswap_swap",
    {
      description:
        "Prepare a direct Uniswap V3 swap (bypasses LiFi aggregator). Use this ONLY when the user " +
          "explicitly asks for Uniswap — otherwise default to `prepare_swap` which compares routes " +
          "across venues. Same-chain only (Uniswap V3 is not a bridge). Auto-picks the best pool " +
          "fee tier (100/500/3000/10000 bps) by quoting all four against QuoterV2 and choosing the " +
          "one with the best price; pass `feeTier` to override. Supports ERC-20 <-> ERC-20, " +
          "native-in (ETH -> ERC-20), and native-out (ERC-20 -> ETH). Both exact-in and exact-out. " +
          "Returns an unsigned tx (with a reset+approve chain when the router needs allowance) that " +
          "`send_transaction` can forward to Ledger Live. Single-hop only in v1 — multi-hop routes " +
          "through an intermediate asset (e.g. via WETH) fall back to `prepare_swap`.",
      inputSchema: prepareUniswapSwapInput.shape,
    },
    txHandler("prepare_uniswap_swap", prepareUniswapSwap)
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
        "SECURITY: the returned `wallet`/`peerUrl` (EVM) are self-reported by the paired WC app — any peer can claim to be 'Ledger Live' at wc.apps.ledger.com, " +
        "so the wallet name and URL alone do NOT prove identity. The cryptographic discriminator is the WC session `topic` (also returned here). Before the FIRST " +
        "send_transaction of a session, ask the user to open Ledger Live → Settings → Connected Apps (mobile: Manager → WalletConnect) and confirm a WalletConnect " +
        "session exists whose topic ends with the last 8 chars of the `topic` field (surface those 8 chars in your prompt, e.g. \"…a1b2c3d4\"). If no matching session " +
        "is listed there, a different peer is impersonating Ledger Live — do NOT proceed. The physical Ledger device's on-screen confirmation is still the final check " +
        "on tx contents, but the topic cross-check is what binds the WC session to the user's real Ledger Live install. " +
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
    txHandler("prepare_aave_supply", prepareAaveSupply)
  );

  server.registerTool(
    "prepare_aave_withdraw",
    {
      description:
        "Build an unsigned Aave V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the entire aToken balance.",
      inputSchema: prepareAaveWithdrawInput.shape,
    },
    txHandler("prepare_aave_withdraw", prepareAaveWithdraw)
  );

  server.registerTool(
    "prepare_aave_borrow",
    {
      description:
        "Build an unsigned Aave V3 borrow transaction (variable rate — stable rate is deprecated and reverts on production markets). The borrower must already have sufficient collateral supplied.",
      inputSchema: prepareAaveBorrowInput.shape,
    },
    txHandler("prepare_aave_borrow", prepareAaveBorrow)
  );

  server.registerTool(
    "prepare_aave_repay",
    {
      description:
        "Build an unsigned Aave V3 repay transaction. If an ERC-20 approve() is required first, it is returned as the outer tx and repay is in `.next`. Pass `amount: \"max\"` to repay the full debt.",
      inputSchema: prepareAaveRepayInput.shape,
    },
    txHandler("prepare_aave_repay", prepareAaveRepay)
  );

  server.registerTool(
    "prepare_lido_stake",
    {
      description:
        "Build an unsigned Lido stake transaction (wraps ETH into stETH via stETH.submit). The tx's value field is the ETH amount to stake.",
      inputSchema: prepareLidoStakeInput.shape,
    },
    txHandler("prepare_lido_stake", prepareLidoStake)
  );

  server.registerTool(
    "prepare_lido_unstake",
    {
      description:
        "Build an unsigned Lido withdrawal request transaction. Wraps `requestWithdrawals` on the Lido Withdrawal Queue and includes an approve step if needed.",
      inputSchema: prepareLidoUnstakeInput.shape,
    },
    txHandler("prepare_lido_unstake", prepareLidoUnstake)
  );

  server.registerTool(
    "prepare_eigenlayer_deposit",
    {
      description:
        "Build an unsigned EigenLayer StrategyManager.depositIntoStrategy transaction. Includes an ERC-20 approve step if needed.",
      inputSchema: prepareEigenLayerDepositInput.shape,
    },
    txHandler("prepare_eigenlayer_deposit", prepareEigenLayerDeposit)
  );

  server.registerTool(
    "preview_send",
    {
      description:
        "EVM-only: finalize an already-prepared transaction for signing by pinning the nonce, " +
        "EIP-1559 fees (maxFeePerGas, maxPriorityFeePerGas), and gas limit server-side, then computing " +
        "the EIP-1559 pre-sign RLP hash Ledger will display in blind-sign mode. Returns a LEDGER " +
        "BLIND-SIGN HASH content block the user reads BEFORE you call send_transaction — the Ledger " +
        "device prompt blocks the MCP tool call, so the hash must be surfaced now, not after. The " +
        "pinned tuple is stashed against the handle and forwarded verbatim on send_transaction so the " +
        "on-device hash is deterministic. If gas conditions drift while the user reviews, call " +
        "preview_send again on the same handle to refresh the pin (overwrites the prior one). " +
        "send_transaction will throw a clear error if called without a prior preview_send. Not " +
        "applicable to TRON handles (USB HID signing flow, no WalletConnect).",
      inputSchema: previewSendInput.shape,
    },
    previewSendHandler(previewSend),
  );

  server.registerTool(
    "send_transaction",
    {
      description:
        "Forward an already-prepared transaction to the Ledger device for user signing. Routes on the handle's origin: EVM handles (prepare_aave_*, prepare_compound_*, prepare_swap, prepare_native_send, ...) go through Ledger Live via WalletConnect; TRON handles (prepare_tron_*) go through the directly-connected Ledger over USB HID and are broadcast via TronGrid. In both cases the user must review and physically approve the tx on the Ledger screen; this call blocks until the user signs or rejects. " +
        "EVM handles REQUIRE a prior preview_send(handle) call in the same session — send_transaction reads the pinned nonce + fees + gas stashed on the handle and will throw a clear error if the pin is missing. The split exists so the LEDGER BLIND-SIGN HASH is surfaced to the user BEFORE the blocking device prompt. " +
        "You MUST pass `confirmed: true` — the agent is affirming that the user has seen and acknowledged the decoded preview AND the LEDGER BLIND-SIGN HASH emitted by preview_send. " +
        "EVM handles ADDITIONALLY require passing `previewToken` (the opaque string returned in preview_send's top-level JSON response) and `userDecision: \"send\"` (set after the user has replied \"send\" to the EXTRA CHECKS menu emitted by preview_send's agent-task block). Together these prove the agent actually surfaced the preview-time gate to the user instead of collapsing preview_send + send_transaction into one silent step — missing/mismatched values cause a clear-error refusal. TRON handles ignore both args. " +
        "For TRON handles, `pair_ledger_tron` must have been called at least once per session (so the TRON app has been opened on the device) and the Ledger must still be plugged in with the TRON app open at send time; preview_send is skipped (TRON has its own clear-sign UX on-device).",
      inputSchema: sendTransactionInput.shape,
    },
    sendTransactionHandler(sendTransaction)
  );

  server.registerTool(
    "get_transaction_status",
    {
      description:
        "Poll a transaction's status via the chain's RPC (EVM) or TronGrid (TRON). Returns pending / success / failed, or unknown if the node hasn't seen it yet. Pass chain='tron' with the bare hex txID for TRON.",
      inputSchema: getTransactionStatusInput.shape,
    },
    handler(getTransactionStatus)
  );

  server.registerTool(
    "get_tx_verification",
    {
      description:
        "Re-emit the prepared-tx JSON and VERIFY-BEFORE-SIGNING block for a known handle. Use this when the original prepare_* tool output has dropped out of your context (compaction, long sessions). The response shape and verification block match the original prepare_* call exactly. NEVER recover a verification block by reading tool-result files from disk — call this tool instead. Handles live in-memory for 15 minutes after issue.",
      inputSchema: getTxVerificationInput.shape,
    },
    handler(getTxVerification)
  );

  server.registerTool(
    "get_verification_artifact",
    {
      description:
        "Return a sparse verification artifact for a prepared tx — raw calldata (or TRON " +
        "rawDataHex), chain, to/value, payloadHash, preSignHash if preview_send has pinned " +
        "gas, plus a static prompt instructing a second LLM on how to decode the bytes from " +
        "scratch. Intended for adversarial independent verification: the user copies this " +
        "artifact into a second LLM session (different provider recommended) so the second " +
        "agent produces an independent decode with no shared context from the current " +
        "conversation. If the two decodes disagree — or if the preSignHash doesn't match " +
        "what Ledger displays at sign time — the user rejects. Does NOT call any external " +
        "API; read-only in-memory lookup. Output deliberately omits the server's humanDecode, " +
        "swiss-knife URL, and 4byte cross-check so the second agent cannot echo them. Handles " +
        "live in-memory for 15 minutes after issue.",
      inputSchema: getVerificationArtifactInput.shape,
    },
    handler(getVerificationArtifact)
  );

  server.registerTool(
    "verify_tx_decode",
    {
      description:
        "Independent server-side cross-check of a prepared EVM tx's calldata. Fetches the function " +
        "signature(s) registered for the 4-byte selector on 4byte.directory (a public registry), " +
        "re-decodes the calldata via viem against each candidate, and re-encodes to prove the signature " +
        "describes the exact calldata bytes losslessly. Returns a VerifyDecodeResult whose `summary` " +
        "field is pre-written for end-user consumption — the orchestrator should relay it verbatim. " +
        "Status values: `match` (independent decode agrees with local ABI), `mismatch` (function-name " +
        "disagreement — DO NOT SEND), `no-signature` / `error` / `not-applicable` (no independent check " +
        "possible; fall back to the swiss-knife URL). On TRON, returns `not-applicable` — TRON " +
        "transactions carry no 4-byte selector so this cross-check doesn't apply. Handle is the same " +
        "opaque ID returned by any prepare_* tool. NEVER do this check by scripting ad-hoc WebFetches " +
        "to 4byte or swiss-knife; always call this tool so the check runs through a single auditable " +
        "code path. This is deliberately more expensive than a 4byte-selector lookup — it proves the " +
        "FULL calldata (not just the function name) is consistent with the independent signature.",
      inputSchema: getTxVerificationInput.shape,
    },
    handler(verifyTxDecode)
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
    "get_token_metadata",
    {
      description:
        "Fetch on-chain ERC-20 metadata (symbol, name, decimals) for any token address on an EVM chain — no wallet or balance required. Also detects EIP-1967 transparent proxies and returns the current implementation address when present. Prefer this over running raw simulate_transaction calls against symbol()/name()/decimals() selectors.",
      inputSchema: getTokenMetadataInput.shape,
    },
    handler(getTokenMetadata)
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
        "Read TRON staking state for a base58 address: claimable voting rewards (WithdrawBalance-ready), frozen TRX under Stake 2.0 (bandwidth + energy), pending unfreezes with unlock timestamps, AND the live account-resource meter (`resources`) showing immediately-consumable bandwidth units (free + staked pools), energy units, and voting-power units. The resource meter is what tx execution actually charges against — frozen TRX only determines the daily limit. Read-only; pair with `prepare_tron_claim_rewards` to withdraw rewards or `prepare_tron_vote` to allocate voting power.",
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
    handler(buildTronNativeSend, { toolName: "prepare_tron_native_send" })
  );

  server.registerTool(
    "prepare_tron_token_send",
    {
      description:
        "Build an unsigned TRC-20 transfer transaction (canonical set only: USDT, USDC, USDD, TUSD) via TronGrid's /wallet/triggersmartcontract. Decimals are resolved from the canonical table — unknown TRC-20s are rejected with an explicit error. Default fee_limit is 100 TRX (TronLink/Ledger Live default); override with `feeLimitTrx` if energy pricing has moved. Returns a preview + opaque handle. Forward via `send_transaction` for USB-HID signing on the paired Ledger. USDT renders natively on the TRON app; other TRC-20s may display raw hex on-device (the contract address and amount are still shown, so the user can verify against the preview).",
      inputSchema: prepareTronTokenSendInput.shape,
    },
    handler(buildTronTokenSend, { toolName: "prepare_tron_token_send" })
  );

  server.registerTool(
    "prepare_tron_claim_rewards",
    {
      description:
        "Build an unsigned TRON WithdrawBalance transaction that claims accumulated voting rewards to the owner's balance. TRON enforces a 24-hour cooldown between claims — TronGrid will reject (surfaced as an error) if the previous claim was inside the window. Pair with `get_tron_staking` first to read `claimableRewards` and avoid empty-claim tx builds. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronClaimRewardsInput.shape,
    },
    handler(buildTronClaimRewards, { toolName: "prepare_tron_claim_rewards" })
  );

  server.registerTool(
    "prepare_tron_freeze",
    {
      description:
        "Build an unsigned TRON Stake 2.0 FreezeBalanceV2 transaction. Locks TRX to earn `bandwidth` (fuels plain transfers) or `energy` (fuels smart-contract calls) and gains proportional voting power. IMPORTANT: freezing alone does NOT accrue TRX rewards — `claimableRewards` (see `get_tron_staking`) only grows after the user also votes for a Super Representative. Pair this tool with `list_tron_witnesses` + `prepare_tron_vote` for the full reward-earning flow. Unlocking requires a 14-day cooldown via `prepare_tron_unfreeze` + `prepare_tron_withdraw_expire_unfreeze`. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronFreezeInput.shape,
    },
    handler(buildTronFreeze, { toolName: "prepare_tron_freeze" })
  );

  server.registerTool(
    "prepare_tron_unfreeze",
    {
      description:
        "Build an unsigned TRON Stake 2.0 UnfreezeBalanceV2 transaction — begins the 14-day cooldown on a previously-frozen slice. The `amount` must not exceed what's currently frozen for that resource (query `get_tron_staking` first; TronGrid rejects otherwise with 'less than frozen balance'). After 14 days the slice shows up in `pendingUnfreezes` with an elapsed `unlockAt`; call `prepare_tron_withdraw_expire_unfreeze` to sweep it back to liquid TRX. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronUnfreezeInput.shape,
    },
    handler(buildTronUnfreeze, { toolName: "prepare_tron_unfreeze" })
  );

  server.registerTool(
    "prepare_tron_withdraw_expire_unfreeze",
    {
      description:
        "Build an unsigned TRON WithdrawExpireUnfreeze transaction — sweeps every matured unfreeze slice (those whose 14-day cooldown elapsed) back to liquid TRX. No amount needed; the chain drains all eligible slices in one call. Inspect `pendingUnfreezes` from `get_tron_staking` first — if every entry's `unlockAt` is still in the future, TronGrid returns 'no expire unfreeze' and this tool errors. Returns a preview + opaque handle; forward via `send_transaction` for USB-HID signing on the paired Ledger.",
      inputSchema: prepareTronWithdrawExpireUnfreezeInput.shape,
    },
    handler(buildTronWithdrawExpireUnfreeze, { toolName: "prepare_tron_withdraw_expire_unfreeze" })
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
    handler(buildTronVote, { toolName: "prepare_tron_vote" })
  );

  server.registerTool(
    "prepare_native_send",
    {
      description:
        "Build an unsigned native-coin send transaction (ETH on Ethereum/Arbitrum). Pass a human-readable amount like \"0.5\".",
      inputSchema: prepareNativeSendInput.shape,
    },
    txHandler("prepare_native_send", prepareNativeSend)
  );

  server.registerTool(
    "prepare_token_send",
    {
      description:
        "Build an unsigned ERC-20 transfer transaction. Pass `amount: \"max\"` to send the full balance (resolved at build time).",
      inputSchema: prepareTokenSendInput.shape,
    },
    txHandler("prepare_token_send", prepareTokenSend)
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
    "get_compound_market_info",
    {
      description:
        "Fetch structured market info for a single Compound V3 (Comet) market — no wallet required. Returns base-token metadata, totalSupply/totalBorrow, utilization, supply+borrow APR, current pause flags, and the full collateral-asset list with each asset's symbol, decimals, priceFeed, borrow/liquidate/liquidation collateral factors, supply cap, and total amount currently supplied across all users. Use this to explain market state, answer 'what are the listed collaterals for cUSDCv3', or diagnose an incident (pause + utilization + contagion across collaterals) in one call.",
      inputSchema: getCompoundMarketInfoInput.shape,
    },
    handler(getCompoundMarketInfo)
  );

  server.registerTool(
    "get_market_incident_status",
    {
      description:
        "Return an 'is anything on fire' snapshot across every registered market for a protocol + chain. For Compound V3, returns per-market pause flags, utilization, totalSupply, totalBorrow. For Aave V3, returns per-reserve isActive/isFrozen/isPaused, utilization, totalSupplied, totalBorrowed. Each entry has a `flagged` bit: Compound flags on any pause or utilization ≥ 95% (borrowers trapped); Aave flags on paused/frozen/inactive or utilization ≥ 95%. Top-level `incident: true` if any market/reserve is flagged. Use when you suspect a governance pause, a utilization cliff, or multi-market contagion from a shared-collateral exploit — collapses what would otherwise take one get_compound_market_info call per market.",
      inputSchema: getMarketIncidentStatusInput.shape,
    },
    handler(getMarketIncidentStatus)
  );

  server.registerTool(
    "prepare_compound_supply",
    {
      description:
        "Build an unsigned Compound V3 supply transaction (base token or collateral). If an ERC-20 approve() is required first, it is returned as the outer tx with supply in `.next`.",
      inputSchema: prepareCompoundSupplyInput.shape,
    },
    txHandler("prepare_compound_supply", buildCompoundSupply)
  );

  server.registerTool(
    "prepare_compound_withdraw",
    {
      description:
        "Build an unsigned Compound V3 withdraw transaction. Pass `amount: \"max\"` to withdraw the full supplied balance.",
      inputSchema: prepareCompoundWithdrawInput.shape,
    },
    txHandler("prepare_compound_withdraw", buildCompoundWithdraw)
  );

  server.registerTool(
    "prepare_compound_borrow",
    {
      description:
        "Build an unsigned Compound V3 borrow transaction. Compound V3 encodes a borrow as `withdraw(baseToken)` drawn beyond the wallet's supplied balance — the base token is resolved on-chain from the Comet market so you only pass the market address and amount. Requires the wallet to have already supplied enough collateral in that market; `get_compound_positions` shows the current collateral mix. Returns a handle + human-readable preview for the user to sign on Ledger; no approval step is needed (borrowing doesn't pull tokens from the wallet).",
      inputSchema: prepareCompoundBorrowInput.shape,
    },
    txHandler("prepare_compound_borrow", buildCompoundBorrow)
  );

  server.registerTool(
    "prepare_compound_repay",
    {
      description:
        "Build an unsigned Compound V3 repay transaction — encoded as supply(baseToken) against an outstanding borrow. Includes an approve step if needed. Pass `amount: \"max\"` for a full repay.",
      inputSchema: prepareCompoundRepayInput.shape,
    },
    txHandler("prepare_compound_repay", buildCompoundRepay)
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
    txHandler("prepare_morpho_supply", buildMorphoSupply)
  );

  server.registerTool(
    "prepare_morpho_withdraw",
    {
      description:
        "Build an unsigned Morpho Blue withdraw transaction (withdraws supplied loan token). Explicit amount only — \"max\" is not supported; query your position first.",
      inputSchema: prepareMorphoWithdrawInput.shape,
    },
    txHandler("prepare_morpho_withdraw", buildMorphoWithdraw)
  );

  server.registerTool(
    "prepare_morpho_borrow",
    {
      description:
        "Build an unsigned Morpho Blue borrow transaction. Requires pre-existing collateral in the market.",
      inputSchema: prepareMorphoBorrowInput.shape,
    },
    txHandler("prepare_morpho_borrow", buildMorphoBorrow)
  );

  server.registerTool(
    "prepare_morpho_repay",
    {
      description:
        "Build an unsigned Morpho Blue repay transaction. Includes an approve step if needed. Explicit amount only — \"max\" is not supported.",
      inputSchema: prepareMorphoRepayInput.shape,
    },
    txHandler("prepare_morpho_repay", buildMorphoRepay)
  );

  server.registerTool(
    "prepare_morpho_supply_collateral",
    {
      description:
        "Build an unsigned Morpho Blue supplyCollateral transaction — adds collateral to a market. Includes an approve step if needed.",
      inputSchema: prepareMorphoSupplyCollateralInput.shape,
    },
    txHandler("prepare_morpho_supply_collateral", buildMorphoSupplyCollateral)
  );

  server.registerTool(
    "prepare_morpho_withdraw_collateral",
    {
      description:
        "Build an unsigned Morpho Blue withdrawCollateral transaction — removes collateral from a market to send back to the wallet. Only withdraws the exact amount specified; `\"max\"` is NOT supported because Morpho's isolated-market accounting doesn't expose a clean max-safe value without simulating against the market's oracle/LLTV (query `get_morpho_positions` first to know your deposited collateral). Will revert on-chain if the withdrawal would push the position below the liquidation threshold. No approval step needed. Returns a handle + preview for Ledger signing.",
      inputSchema: prepareMorphoWithdrawCollateralInput.shape,
    },
    txHandler("prepare_morpho_withdraw_collateral", buildMorphoWithdrawCollateral)
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
