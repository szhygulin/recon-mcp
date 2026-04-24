# VaultPilot MCP

[![npm version](https://img.shields.io/npm/v/vaultpilot-mcp.svg)](https://www.npmjs.com/package/vaultpilot-mcp)
[![license](https://img.shields.io/npm/l/vaultpilot-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/vaultpilot-mcp.svg)](package.json)
[![vaultpilot-mcp MCP server](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp/badges/score.svg)](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp)

**Hardware-verified DeFi for AI agents. The agent proposes, you approve on your Ledger - designed for when the AI can be compromised.**

![VaultPilot MCP demo](./demo.gif)

VaultPilot MCP is a Model Context Protocol server that lets AI agents — **Claude Code, Claude Desktop, Cursor**, and any MCP-compatible client — read your on-chain positions across **Ethereum, Arbitrum, Polygon, Base**, and **TRON** and prepare EVM transactions that you sign on your **Ledger device via WalletConnect**. Your private keys never leave the hardware wallet, and every transaction is previewed in human-readable form before you approve it on the device.

Supported protocols: **Aave V3, Compound V3 (Comet), Morpho Blue, Uniswap V3 LP, Lido (stETH/wstETH), EigenLayer**, plus **LiFi** for swap/bridge aggregation and **1inch** for optional intra-chain quote comparison.

Use it when you want to:

- Ask an agent *"what are my DeFi positions across Ethereum, Arbitrum, Polygon, and Base?"* and get a unified portfolio view (wallet balances + Aave/Compound/Morpho lending + Uniswap V3 LP + Lido/EigenLayer staking) with USD totals.
- Get liquidation-risk alerts (*"any position below health factor 1.5?"*) without manually checking dashboards.
- Swap or bridge tokens — the agent prepares the route via LiFi, you sign on Ledger.
- Supply, borrow, repay, withdraw on lending protocols; stake ETH on Lido; deposit into EigenLayer strategies; send ETH or ERC-20 tokens — all through Ledger-signed transactions.
- Assess protocol security before interacting with it: contract verification, EIP-1967 proxy/admin keys, privileged roles (Ownable, AccessControl, Gnosis Safe multisig, Timelock), and a DefiLlama-backed 0–100 risk score.
- Look up token prices, resolve ENS names, and poll transaction status.

This is an **agent-driven portfolio management** tool, not a wallet replacement. The MCP never holds keys or broadcasts anything you haven't approved on your Ledger device.

## Features

- **Positions** — lending/borrowing (Aave, Compound, Morpho), LP positions, and health-factor alerts
- **Portfolio** — cross-chain balances, DeFi position aggregation, USD-denominated summaries
- **Staking** — Lido, EigenLayer, reward aggregation, yield estimation
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, protocol risk scoring
- **Swaps** — LiFi-routed intra-chain and cross-chain quotes; intra-chain routes are also cross-checked against 1inch (when an API key is configured) with a `bestSource` hint and output-delta savings
- **Execution** — tx preparation for Aave, Compound, Morpho, Lido, EigenLayer, native/token sends, swaps; signing via Ledger Live (WalletConnect) for EVM chains
- **Utilities** — ENS forward/reverse resolution, token balances, transaction status

## Security model

**VaultPilot assumes the AI agent can be compromised, the MCP server can be compromised, and your host computer can be compromised. Only your Ledger device is trusted.** Every transaction is cryptographically bound across every layer so that tampering anywhere — a swapped recipient, a rewritten swap route, a smuggled approval — produces a visible mismatch on the device screen, giving you the chance to reject before anything is signed.

Private keys never leave the Ledger device. Every state-changing transaction is prepared read-only by the server, previewed in human-readable form, and approved on the device's own screen — the only display in the pipeline that isn't filtered through the agent.

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

VaultPilot layers defenses so most single-layer compromises are caught by at least one cross-check, and the cases that aren't are called out honestly. The layers include a server-side prepare↔send fingerprint, an independent 4byte.directory selector cross-check, an agent-side ABI decode and pair-consistency pre-sign hash recomputation that auto-run at `preview_send` and are reported in a `CHECKS PERFORMED` block (with a swiss-knife decoder URL as a suggested fallback when the agent's ABI decode is low-confidence), an on-device final check — in blind-sign mode the user matches a Ledger-displayed hash against the one the server returned; in clear-sign mode (Aave, Lido, 1inch, LiFi, approve plugins) the user checks decoded fields (function name, amount, recipient, spender) against the compact summary shown in chat — a verbatim `PREPARE RECEIPT` of the args the agent actually passed, a `previewToken` + `userDecision` gate against accidental preview-step collapse, a WalletConnect session-topic cross-check (the agent surfaces the last 8 chars of the WC session `topic` and asks the user to confirm a matching session exists in Ledger Live → Settings → Connected Apps, catching peer impersonation any self-reported name/URL can't), and — for skeptical users on high-value flows — a `get_verification_artifact` that routes bytes to a second, independent LLM for cross-verification.

**See [SECURITY.md](./SECURITY.md)** for the full defenses table, threat → catches-it mapping, honest limits, the `payloadFingerprint` verification recipe, and the second-agent verification flow.

### Agent-side hardening (strongly recommended)

All of the `CHECKS PERFORMED` / `VERIFY-BEFORE-SIGNING` directives that VaultPilot emits are authored by the MCP server itself. A compromised or out-of-date server can silently omit them, and an honest agent with no static rule to fall back on will drop the checks. To close that self-referential gap, install the companion [`vaultpilot-skill`](https://github.com/szhygulin/vaultpilot-skill) repository as a Claude Code skill — it lives on your local disk under `~/.claude/skills/` and instructs the agent to run the bytes-decode + hash-recompute invariants on every signing flow regardless of what the MCP says.

```bash
git clone https://github.com/szhygulin/vaultpilot-skill.git \
  ~/.claude/skills/vaultpilot-preflight
```

Restart Claude Code after installing. When the MCP detects the skill is missing (no `SKILL.md` at that path), the first vaultpilot-mcp tool response of the session — read-only or signing — carries a `VAULTPILOT NOTICE — Preflight skill not installed` block asking you to install it. The notice is deduped per-session so it doesn't spam follow-up calls. It deliberately uses a non-imperative "notice" framing rather than an "AGENT TASK" directive — earlier iterations framed it as `[AGENT TASK — RELAY TO USER FIRST, BEFORE ANY OTHER BLOCK]` with a pasteable `git clone` command, which stricter-sandboxed agents correctly classified as prompt injection and dropped. The current framing is documented as a legitimate server pattern at the top of the MCP's server-level `instructions` field so sandboxed agents don't need to guess. That notice is still server-authored (a compromised MCP would suppress it), so the install step must not be deferred. Users who only use vaultpilot-mcp for reads and never sign can suppress the notice via `VAULTPILOT_SKILL_MARKER_PATH=<any existing file>` after acknowledging the tradeoff. See the roadmap for a planned `PreToolUse` hook that would enforce the hash recompute as host-side code, removing the agent-prose dependency entirely.

## Supported chains

EVM: Ethereum, Arbitrum, Polygon, Base.

Non-EVM: TRON — full reads (balance, staking state, SR listing) and full write coverage (native TRX sends, canonical TRC-20 transfers, voting-reward claims, Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze, and VoteWitness) signed on a directly-connected Ledger over USB HID. Ledger Live's WalletConnect relay does not currently honor the `tron:` namespace (verified 2026-04-14), so TRON signing goes through `@ledgerhq/hw-app-trx` — the user's Ledger must be plugged into the host running the MCP, unlocked, with the TRON app open. Pair via `pair_ledger_tron` once per session.

Not every protocol is on every chain. Lido and EigenLayer are L1-only (Ethereum). Morpho Blue is currently enabled on Ethereum only — it is deployed on Base at the same address but the discovery scan needs a pinned deployment block, tracked as a follow-up. TRON has no lending/LP coverage in this server (none of Aave/Compound/Morpho/Uniswap are deployed there); balance reads return TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD) that together cover the vast majority of TRON token volume, and TRON-native staking (frozen TRX under Stake 2.0, pending unfreezes, claimable voting rewards) is surfaced via `get_tron_staking` and folded into the portfolio summary. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

- **MetaMask support** (WalletConnect) — alongside the existing Ledger Live integration. Will let users sign through a MetaMask-paired session when a hardware wallet isn't available.
- **Solana** — coming later. Non-EVM: introduces a separate SDK (`@solana/web3.js`), base58 addresses, and the WalletConnect `solana:` namespace for signing.
- **Server-integrated second-agent verification** — have the MCP call an independent second-provider LLM directly on every high-value or blind-sign-expected `send_transaction`, relay its verdict to the user, and block the send on disagreement. Structurally closes the coordinated-agent gap that today's copy-paste `get_verification_artifact` flow only narrows (the copy-paste path depends on the first agent not silently suppressing the artifact). Additive, opt-in feature — the self-custody trust model (no private keys on the server, no broadcast without device approval) is unchanged.
- **PreToolUse hook for mechanical hash enforcement** — the agent-side preflight skill currently instructs the agent to run the bytes-decode + hash-recompute checks, but it does not physically prevent a prompt-injected or coordinated-compromised agent from skipping them. A Claude Code `PreToolUse` hook registered on `mcp__vaultpilot-mcp__send_transaction` would do the hash recompute as host-side code, using its own pinned `viem` / `@solana/web3.js` install, and exit non-zero on divergence — the Claude Code harness blocks the tool call before it reaches the MCP. This makes the check mechanical rather than prose-based; the only way past it is to also compromise the user's local `settings.json` or the hook's own `node_modules`. Ships as a separate `vaultpilot-hook` repo (same independent-trust-root reasoning as [`vaultpilot-skill`](https://github.com/szhygulin/vaultpilot-skill)). Deferred because the transcript-path conventions and failure-mode UX warrant a full iteration of their own.

## Tools exposed to the agent

Read-only (no Ledger pairing required):

- `get_portfolio_summary` — cross-chain portfolio aggregation with USD totals; pass an optional `tronAddress` (base58, prefix T) alongside an EVM `wallet` to fold TRX + TRC-20 balances + TRON staking (frozen + pending-unfreeze + claimable rewards) into the same total (returned under `breakdown.tron`, `tronUsd`, and `tronStakingUsd`)
- `get_lending_positions` — Aave V3 collateral/debt/health-factor per wallet
- `get_compound_positions` — Compound V3 (Comet) base + collateral positions
- `get_morpho_positions` — Morpho Blue positions; auto-discovers the wallet's markets via event-log scan when `marketIds` is omitted (pass explicit ids for a fast path)
- `get_lp_positions` — Uniswap V3 LP positions, fee tier, in-range, IL estimate
- `get_staking_positions`, `get_staking_rewards`, `estimate_staking_yield` — Lido + EigenLayer
- `get_health_alerts` — Aave positions near liquidation
- `simulate_position_change` — projected Aave health factor for a hypothetical action
- `simulate_transaction` — run `eth_call` against a prepared or arbitrary tx to preview success/revert before signing; prepared txs are re-simulated automatically at send time
- `get_token_balance`, `get_token_price` — balances and DefiLlama prices; `get_token_balance` accepts `chain: "tron"` with a base58 wallet and a base58 TRC-20 address (or `token: "native"` for TRX), returning a `TronBalance` shape
- `get_tron_staking` — TRON-native staking state for a base58 address: claimable voting rewards (WithdrawBalance-ready), frozen TRX under Stake 2.0 (bandwidth + energy), and pending unfreezes with ISO unlock timestamps. Pair with `prepare_tron_claim_rewards` to actually withdraw accumulated rewards.
- `list_tron_witnesses` — TRON Super Representatives + SR candidates, ranked by vote weight, with a rough voter-APR estimate per SR. Optionally augments with the caller's current vote allocation, total TRON Power, and available (unused) votes — pair with `prepare_tron_vote`.
- `resolve_ens_name`, `reverse_resolve_ens` — ENS forward/reverse
- `get_swap_quote` — LiFi quote (optionally cross-checked against 1inch)
- `check_contract_security`, `check_permission_risks`, `get_protocol_risk_score` — risk tooling
- `get_transaction_status` — poll inclusion by hash
- `get_verification_artifact` — returns a sparse, copy-paste-friendly JSON artifact (raw calldata + chain + payloadHash + preSignHash if pinned) for a prepared tx, plus a canned prompt telling a second LLM how to independently decode it. Intended for adversarial cross-verification on high-value flows — see [SECURITY.md](./SECURITY.md#second-agent-verification-optional-for-the-coordinated-agent-case)

Meta:

- `request_capability` — agent-facing escape hatch: files a GitHub issue on this repo when the user asks for something vaultpilot-mcp can't do (new protocol, new chain, missing tool). Default mode returns a pre-filled issue URL (zero spam risk — user must click to submit). Operators can set `VAULTPILOT_FEEDBACK_ENDPOINT` to a proxy that posts directly. Rate-limited: 30s between calls, 3/hour, 10/day, 7-day dedupe on identical summaries.

Execution (Ledger-signed):

- `pair_ledger_live` (WalletConnect, EVM), `pair_ledger_tron` (USB HID, TRON), `get_ledger_status` — session management and account discovery; `get_ledger_status` returns per-chain EVM exposure (`accountDetails[]` with `address`, `chainIds`, `chains`) so duplicate-looking addresses across chains are disambiguated, the WalletConnect session `topic` (the agent is instructed to surface its last 8 chars and ask the user to verify a matching session in Ledger Live → Settings → Connected Apps before the first `send_transaction` — any WC peer can self-report "Ledger Wallet" / `wc.apps.ledger.com`, but the session topic is unique per pairing), and a `tron: [{ address, path, appVersion, accountIndex }, …]` array (one entry per paired TRON account) when `pair_ledger_tron` has been called. Pass `accountIndex: 1` (2, 3, …) to pair additional TRON accounts.
- `prepare_aave_supply` / `_withdraw` / `_borrow` / `_repay`
- `prepare_compound_supply` / `_withdraw` / `_borrow` / `_repay`
- `prepare_morpho_supply` / `_withdraw` / `_borrow` / `_repay` / `_supply_collateral` / `_withdraw_collateral`
- `prepare_lido_stake`, `prepare_lido_unstake`
- `prepare_eigenlayer_deposit`
- `prepare_swap` — LiFi-routed intra- or cross-chain swap/bridge
- `prepare_native_send`, `prepare_token_send`
- `prepare_tron_native_send`, `prepare_tron_token_send`, `prepare_tron_claim_rewards`, `prepare_tron_freeze`, `prepare_tron_unfreeze`, `prepare_tron_withdraw_expire_unfreeze`, `prepare_tron_vote` — TRON tx builders (native TRX send, canonical TRC-20 transfer, WithdrawBalance claim, Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze, VoteWitness)
- `send_transaction` — forwards a prepared tx for user approval. EVM handles go to Ledger Live via WalletConnect; TRON handles go to the USB-connected Ledger via `@ledgerhq/hw-app-trx` and are broadcast via TronGrid

## Requirements

- Node.js >= 18.17
- An RPC provider (Infura, Alchemy, or custom) for the EVM chains
- Optional: Etherscan API key, 1inch Developer Portal API key (enables swap-quote comparison), WalletConnect Cloud project ID (required for EVM Ledger signing), TronGrid API key (enables TRX + TRC-20 balance reads)
- For TRON signing: USB HID access to a Ledger device with the **Tron** app installed. On Linux, Ledger's [udev rules](https://github.com/LedgerHQ/udev-rules) must be installed or `hidraw` access fails with "permission denied". The `@ledgerhq/hw-transport-node-hid` dependency compiles `node-hid` natively at `npm install` time, which needs `libudev-dev` + a C/C++ toolchain on Debian/Ubuntu (`sudo apt install libudev-dev build-essential`).

## Install

### From npm (recommended)

```bash
npm install -g vaultpilot-mcp
vaultpilot-mcp-setup
```

### From source

```bash
git clone https://github.com/szhygulin/vaultpilot-mcp.git
cd vaultpilot-mcp
npm install
npm run build
```

## Setup

Run the interactive setup to pick an RPC provider, validate the key, optionally pair Ledger Live, and write `~/.vaultpilot-mcp/config.json`:

```bash
npm run setup
```

Environment variables always override the config file at runtime.

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "vaultpilot-mcp"
    }
  }
}
```

(If you installed from source rather than via `npm i -g`, swap `"command": "vaultpilot-mcp"` for `"command": "node"` and `"args": ["/absolute/path/to/vaultpilot-mcp/dist/index.js"]`.)

The setup script prints a ready-to-paste snippet.

## Environment variables

All are optional if the matching field is in `~/.vaultpilot-mcp/config.json`; env vars take precedence when both are set.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`, `BASE_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY` — contract verification lookups
- `ONEINCH_API_KEY` — enables 1inch quote comparison in `get_swap_quote`
- `TRON_API_KEY` — TronGrid API key (sent as `TRON-PRO-API-KEY`). Required in practice to read TRON balances — anonymous TronGrid calls are capped at ~15 req/min, which the portfolio fan-out exceeds. Free to create at [trongrid.io](https://www.trongrid.io).
- `WALLETCONNECT_PROJECT_ID` — required for Ledger Live signing
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)
- `VAULTPILOT_ALLOW_INSECURE_RPC=1` — opt out of the https/private-IP check on RPC URLs. Only set this when pointing at a local anvil/hardhat fork; never in production. (Old name `RECON_ALLOW_INSECURE_RPC` is still honored for one release.)
- `VAULTPILOT_FEEDBACK_ENDPOINT` — optional https URL for `request_capability` to POST directly (e.g. a maintainer-operated proxy that creates GitHub issues with a bot token). When unset (the default), `request_capability` returns a pre-filled GitHub issue URL for the user to click through; nothing is transmitted automatically. **Operator responsibility:** the vaultpilot-mcp client does not sign or authenticate POST requests. If you set this endpoint, the proxy MUST enforce its own auth (IP allowlist, Cloudflare Access, HMAC header validation, etc.) — otherwise any caller who learns the URL can submit to it. The on-process rate limiter (3/hour, 10/day) is a courtesy, not a security control. (Old name `RECON_FEEDBACK_ENDPOINT` is still honored for one release.)

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT — see [LICENSE](./LICENSE).
