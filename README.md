# VaultPilot MCP

[![npm version](https://img.shields.io/npm/v/vaultpilot-mcp.svg)](https://www.npmjs.com/package/vaultpilot-mcp)
[![license](https://img.shields.io/npm/l/vaultpilot-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/vaultpilot-mcp.svg)](package.json)
[![vaultpilot-mcp MCP server](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp/badges/score.svg)](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp)

**Hardware-verified DeFi for AI agents. The agent proposes, you approve on your Ledger — designed for when the AI can be compromised.**

![VaultPilot MCP demo](./demo.gif)

VaultPilot MCP is a Model Context Protocol server that lets AI agents — Claude Code, Claude Desktop, Cursor, and any MCP-compatible client — read your on-chain positions across **Ethereum, Arbitrum, Polygon, Base, TRON, and Solana** and prepare transactions you sign on your **Ledger device**. EVM flows go through Ledger Live over WalletConnect; TRON and Solana go through a directly-connected Ledger over USB HID (Ledger Live's WalletConnect bridge does not support either namespace today). Private keys never leave the hardware wallet; every transaction is previewed in human-readable form before you approve it on the device.

Supported protocols: **Aave V3, Compound V3, Morpho Blue, Uniswap V3 LP, Lido, EigenLayer** on EVM, **MarginFi** lending on Solana, plus **LiFi** (EVM swap/bridge) and **Jupiter v6** (Solana swap) aggregation, with **1inch** as an optional EVM quote cross-check.

This is an agent-driven portfolio management tool, not a wallet replacement. The MCP never holds keys or broadcasts anything you haven't approved on your Ledger device.

## Features

- **Portfolio** — cross-chain balances (EVM + TRON + Solana), DeFi position aggregation, USD totals
- **Positions** — Aave, Compound, Morpho, Uniswap V3 LP, MarginFi; health-factor alerts
- **Staking** — Lido + EigenLayer on EVM, TRON Stake 2.0 (freeze/unfreeze/vote/claim)
- **Swaps** — LiFi on EVM (optionally cross-checked against 1inch), Jupiter v6 on Solana
- **Execution** — prepare/sign tx for every supported protocol + native/token sends on EVM, TRON, and Solana. Solana sends are protected by a per-wallet durable-nonce account so Ledger review time doesn't race the blockhash window, and every Solana prepare runs a pre-sign `simulateTransaction` gate so program-level reverts fail loudly at prepare time rather than on broadcast.
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, DefiLlama-backed protocol risk score
- **Utilities** — ENS resolution, token balances, transaction status

## Security model

**VaultPilot assumes the AI agent, MCP server, and host computer can all be compromised. Only your Ledger device is trusted.** Every transaction is cryptographically bound across every layer so that tampering — a swapped recipient, a rewritten swap route, a smuggled approval — produces a visible mismatch on the device screen, giving you the chance to reject before anything is signed.

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

Layered defenses catch most single-layer compromises: a server-side prepare↔send fingerprint, an independent 4byte.directory selector check, agent-side ABI decode + pre-sign hash recomputation, on-device clear-sign or blind-sign-hash match, a WalletConnect session-topic cross-check, a `previewToken`/`userDecision` gate, and — for skeptical users on high-value flows — a `get_verification_artifact` that routes bytes to an independent second LLM. **See [SECURITY.md](./SECURITY.md)** for the full defenses table, threat mapping, honest limits, and verification recipes.

### Agent-side hardening (strongly recommended)

The `CHECKS PERFORMED` / `VERIFY-BEFORE-SIGNING` directives VaultPilot emits are authored by the MCP server itself — a compromised server could silently omit them. Install the companion [`vaultpilot-skill`](https://github.com/szhygulin/vaultpilot-skill) so the agent runs the bytes-decode + hash-recompute invariants regardless of what the MCP says:

```bash
git clone https://github.com/szhygulin/vaultpilot-skill.git \
  ~/.claude/skills/vaultpilot-preflight
```

Restart Claude Code after installing. When the skill is missing, the MCP emits a one-shot `VAULTPILOT NOTICE` until you install it. The skill file's expected SHA-256 is pinned in the server source and verified on every signing flow, so on-disk tamper or plugin-collision attempts produce a visible `integrity check FAILED`.

## Supported chains

**EVM**: Ethereum, Arbitrum, Polygon, Base. Lido reads work on both Ethereum and Arbitrum; Lido writes (`prepare_lido_stake` / `_unstake`) are Ethereum-only. EigenLayer is Ethereum-only. Morpho Blue is currently Ethereum-only (Base deployment tracked as a follow-up).

**TRON**: full reads + writes via USB HID (`@ledgerhq/hw-app-trx`). Balance coverage: TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD). Staking: Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze + voting-reward claims. No lending/LP (Aave/Compound/Morpho/Uniswap aren't deployed on TRON). Pair once per session via `pair_ledger_tron`.

**Solana**: SOL + SPL balances, MarginFi lending positions, Jupiter v6 swap quotes, plus write coverage for SOL/SPL transfers, MarginFi supply/withdraw/borrow/repay, and Jupiter-routed swaps. Signing via `@ledgerhq/hw-app-solana`. Sends are protected by a per-wallet durable-nonce account (~0.00144 SOL rent, reclaimable) so the ~60s blockhash validity window doesn't expire during Ledger review. One-time setup via `prepare_solana_nonce_init`; teardown via `prepare_solana_nonce_close`. Pair once per session via `pair_ledger_solana`. SOL native transfers clear-sign on device; SPL, MarginFi, and Jupiter flows blind-sign against a Message Hash — enable **Allow blind signing** in the Solana app's on-device Settings.

Ledger Live's WalletConnect bridge does not honor the `tron:` namespace (verified 2026-04-14) or expose Solana accounts (verified 2026-04-23), which is why both paths use USB HID. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

- **MetaMask support** (WalletConnect) — alongside the existing Ledger Live integration.
- **More Solana protocols** — Kamino, Drift, Solend lending; Marinade/Jito/native staking.
- **Nonce-aware dropped-tx polling** (Solana) — use the on-chain nonce as the authoritative signal for whether a durable-nonce tx can still land; replaces the `lastValidBlockHeight` path that's meaningless for nonce-protected sends.
- **Server-integrated second-agent verification** — MCP calls an independent LLM directly on high-value sends and blocks on disagreement. Structurally closes the coordinated-agent gap that today's copy-paste `get_verification_artifact` flow only narrows.
- **PreToolUse hook for mechanical hash enforcement** — host-side code that recomputes the pre-sign hash and blocks the MCP tool call on divergence, making the check mechanical rather than prose-based. Ships as a separate `vaultpilot-hook` repo.

## Tools

**Read-only:**

- `get_portfolio_summary` — cross-chain USD totals; optional `tronAddress` / `solanaAddress` fold those chains into the same totals (`breakdown.tron` / `breakdown.solana`)
- `get_lending_positions`, `get_compound_positions`, `get_morpho_positions`, `get_marginfi_positions` — per-protocol lending positions + health factors
- `get_compound_market_info` — wallet-less market snapshot for a single Comet (base-token metadata, supply/borrow/utilization/APR, pause flags, full collateral list with caps + LTV factors)
- `get_market_incident_status` — "is anything on fire" scan across all Compound or Aave markets on a chain; flags paused / frozen / utilization ≥ 95% conditions and surfaces a top-level `incident` bit
- `get_marginfi_diagnostics` — surfaces banks the bundled SDK had to skip, with root cause
- `get_lp_positions` — Uniswap V3 LP + IL estimate
- `get_staking_positions`, `get_staking_rewards`, `estimate_staking_yield` — Lido + EigenLayer
- `get_health_alerts`, `simulate_position_change` — liquidation-risk tooling
- `simulate_transaction` — EVM `eth_call` preview; the Solana equivalent runs automatically inside `preview_solana_send`
- `get_token_balance`, `get_token_price`, `get_token_metadata` — balances + DefiLlama prices (EVM, TRON, Solana); `get_token_metadata` fetches ERC-20 symbol/name/decimals and detects EIP-1967 proxy implementations
- `get_transaction_history` — merged recent-tx reader across external / ERC-20 / internal (and Solana `program_interaction`) with 4byte-decoded methods and historical USD values (Etherscan for EVM, TronGrid for TRON, Solana RPC for Solana)
- `get_tron_staking`, `list_tron_witnesses` — TRON staking state + SR list
- `get_solana_setup_status` — cheap probe of a wallet's Solana setup PDAs (nonce + MarginFi account existence)
- `resolve_ens_name`, `reverse_resolve_ens` — ENS forward/reverse
- `get_swap_quote` (LiFi, EVM), `get_solana_swap_quote` (Jupiter v6)
- `check_contract_security`, `check_permission_risks`, `get_protocol_risk_score` — risk tooling
- `get_transaction_status` — poll inclusion by hash
- `get_tx_verification` — re-emit the VERIFY-BEFORE-SIGNING block + prepared-tx JSON for a handle when the original prepare_* output has dropped out of context (15-minute TTL); never scrape tool-result files from disk
- `get_verification_artifact` — sparse JSON artifact (calldata / Solana message bytes + hashes) for second-LLM cross-verification; see [SECURITY.md](./SECURITY.md#second-agent-verification-optional-for-the-coordinated-agent-case)

**Execution (Ledger-signed):**

- `pair_ledger_live` (EVM/WalletConnect), `pair_ledger_tron` (USB HID), `pair_ledger_solana` (USB HID), `get_ledger_status` — session + account discovery
- `prepare_aave_*`, `prepare_compound_*`, `prepare_morpho_*` — EVM lending actions
- `prepare_lido_stake` / `_unstake`, `prepare_eigenlayer_deposit` — staking
- `prepare_swap` (LiFi), `prepare_native_send`, `prepare_token_send` — EVM sends + swap
- `prepare_uniswap_swap` — direct Uniswap V3 swap, same-chain only; auto-picks best fee tier across 100/500/3000/10000 bps. Use only when the user explicitly asks for Uniswap; otherwise prefer `prepare_swap` (LiFi) which compares venues
- `prepare_tron_*` — native TRX + TRC-20 transfers, WithdrawBalance claim, Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze, VoteWitness
- `prepare_solana_nonce_init` / `_close` — one-time setup/teardown of the durable-nonce PDA
- `prepare_solana_native_send`, `prepare_solana_spl_send`, `prepare_solana_swap` — SOL, SPL (auto-includes `createAssociatedTokenAccount` when needed), Jupiter swap
- `prepare_marginfi_init` + `prepare_marginfi_supply` / `_withdraw` / `_borrow` / `_repay` — MarginFi lending
- `preview_solana_send` — pins the current nonce/blockhash, serializes the message, computes the Message Hash the user matches on-device, runs the pre-sign simulation gate, emits the CHECKS PERFORMED block. Required between every `prepare_solana_*` and `send_transaction`.
- `send_transaction` — forwards to Ledger: EVM via WalletConnect, TRON/Solana via USB HID

**Meta:**

- `request_capability` — files a GitHub issue for missing protocols/chains/tools. Default returns a pre-filled URL (no auto-submit); rate-limited 3/hour.

## Requirements

- Node.js >= 18.17
- **Zero-config path (portfolio reads):** no API keys needed. The server falls back to PublicNode (EVM) and Solana public mainnet when nothing is configured — rate-limited, but enough for first-contact and light use.
- **For real use:** set your own RPC provider (Infura / Alchemy / custom) for EVM chains and a Solana RPC (Helius / QuickNode / Triton) when the public endpoints rate-limit you. One env var per chain (`ETHEREUM_RPC_URL`, `SOLANA_RPC_URL`, …) or `vaultpilot-mcp-setup`.
- **Optional (prompted on demand):** Etherscan API key, 1inch API key (enables swap-quote comparison), WalletConnect project ID (required for EVM Ledger signing), TronGrid API key (raises the ~15 req/min anonymous cap).
- **For TRON/Solana signing:** USB HID access to a Ledger with the **Tron** / **Solana** app installed. On Linux, install Ledger's [udev rules](https://github.com/LedgerHQ/udev-rules) — `vaultpilot-mcp-setup` prints the exact one-liner if they're missing. `node-hid` compiles natively so Debian/Ubuntu needs `sudo apt install libudev-dev build-essential`. For SPL/MarginFi/Jupiter flows, enable **Allow blind signing** in the Solana app's on-device Settings. SOL native transfers clear-sign and do not need this.

## Install

From npm (recommended):

```bash
npm install -g vaultpilot-mcp
vaultpilot-mcp-setup
```

From source:

```bash
git clone https://github.com/szhygulin/vaultpilot-mcp.git
cd vaultpilot-mcp
npm install
npm run build
```

## Setup

Run the interactive setup to pick RPC providers, validate keys, optionally pair Ledger Live, and write `~/.vaultpilot-mcp/config.json`:

```bash
npm run setup
```

Environment variables always override the config file.

## Use with Claude Desktop

```json
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "vaultpilot-mcp"
    }
  }
}
```

From source: replace with `"command": "node"` and `"args": ["/absolute/path/to/vaultpilot-mcp/dist/index.js"]`.

## Environment variables

All optional if the matching field is in `~/.vaultpilot-mcp/config.json`; env vars take precedence.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`, `BASE_RPC_URL`, `SOLANA_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY` — contract verification lookups
- `ONEINCH_API_KEY` — enables 1inch quote comparison
- `TRON_API_KEY` — TronGrid (sent as `TRON-PRO-API-KEY`)
- `WALLETCONNECT_PROJECT_ID` — required for Ledger Live signing
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)
- `VAULTPILOT_ALLOW_INSECURE_RPC=1` — opt out of https/private-IP RPC checks (local anvil/hardhat only)
- `VAULTPILOT_FEEDBACK_ENDPOINT` — optional https proxy for `request_capability` direct POSTs. **The client does not sign or authenticate requests — the proxy MUST enforce its own auth.**
- `VAULTPILOT_SKILL_MARKER_PATH` — suppresses the preflight-skill notice for read-only users who accept the tradeoff

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT — see [LICENSE](./LICENSE).
