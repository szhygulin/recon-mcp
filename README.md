# Recon Crypto MCP

[![npm version](https://img.shields.io/npm/v/recon-crypto-mcp.svg)](https://www.npmjs.com/package/recon-crypto-mcp)
[![license](https://img.shields.io/npm/l/recon-crypto-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/recon-crypto-mcp.svg)](package.json)
[![recon-crypto-mcp MCP server](https://glama.ai/mcp/servers/szhygulin/recon-crypto-mcp/badges/score.svg)](https://glama.ai/mcp/servers/szhygulin/recon-crypto-mcp)

**Self-custodial crypto portfolio and DeFi, managed by AI agents — signed on your Ledger hardware wallet.**

Recon Crypto MCP is a Model Context Protocol server that lets AI agents — **Claude Code, Claude Desktop, Cursor**, and any MCP-compatible client — read your on-chain positions across **Ethereum, Arbitrum, Polygon, Base**, and **TRON** and prepare EVM transactions that you sign on your **Ledger device via WalletConnect**. Your private keys never leave the hardware wallet, and every transaction is previewed in human-readable form before you approve it on the device.

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

## Supported chains

EVM: Ethereum, Arbitrum, Polygon, Base.

Non-EVM: TRON (phase 1 — balance reads only; transaction preparation and Ledger signing land in follow-up phases).

Not every protocol is on every chain. Lido and EigenLayer are L1-only (Ethereum). Morpho Blue is currently enabled on Ethereum only — it is deployed on Base at the same address but the discovery scan needs a pinned deployment block, tracked as a follow-up. TRON has no DeFi/LP/staking coverage in this server (none of Aave/Compound/Morpho/Uniswap/Lido/EigenLayer are deployed there); balance reads return TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD) that together cover the vast majority of TRON token volume. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

- **TRON transaction preparation + Ledger signing** — phase 2 and phase 3 of TRON support. Phase 2 prepares native TRX and TRC-20 sends. Phase 3 signs them via **direct USB integration with `@ledgerhq/hw-app-trx`** — Ledger Live's WalletConnect relay does *not* currently honor the `tron:` namespace (verified 2026-04-14 via a SunSwap pairing attempt), so TRON signing diverges from the Ledger-Live-at-a-distance flow used for EVM: the user's Ledger must be plugged into the host running the MCP, with the TRON app open on the device.
- **MetaMask support** (WalletConnect) — alongside the existing Ledger Live integration. Will let users sign through a MetaMask-paired session when a hardware wallet isn't available.
- **Solana** — coming later. Non-EVM: introduces a separate SDK (`@solana/web3.js`), base58 addresses, and the WalletConnect `solana:` namespace for signing.

## Tools exposed to the agent

Read-only (no Ledger pairing required):

- `get_portfolio_summary` — cross-chain portfolio aggregation with USD totals; pass an optional `tronAddress` (base58, prefix T) alongside an EVM `wallet` to fold TRX + TRC-20 balances into the same total (returned under `breakdown.tron` and `tronUsd`)
- `get_lending_positions` — Aave V3 collateral/debt/health-factor per wallet
- `get_compound_positions` — Compound V3 (Comet) base + collateral positions
- `get_morpho_positions` — Morpho Blue positions; auto-discovers the wallet's markets via event-log scan when `marketIds` is omitted (pass explicit ids for a fast path)
- `get_lp_positions` — Uniswap V3 LP positions, fee tier, in-range, IL estimate
- `get_staking_positions`, `get_staking_rewards`, `estimate_staking_yield` — Lido + EigenLayer
- `get_health_alerts` — Aave positions near liquidation
- `simulate_position_change` — projected Aave health factor for a hypothetical action
- `simulate_transaction` — run `eth_call` against a prepared or arbitrary tx to preview success/revert before signing; prepared txs are re-simulated automatically at send time
- `get_token_balance`, `get_token_price` — balances and DefiLlama prices; `get_token_balance` accepts `chain: "tron"` with a base58 wallet and a base58 TRC-20 address (or `token: "native"` for TRX), returning a `TronBalance` shape
- `resolve_ens_name`, `reverse_resolve_ens` — ENS forward/reverse
- `get_swap_quote` — LiFi quote (optionally cross-checked against 1inch)
- `check_contract_security`, `check_permission_risks`, `get_protocol_risk_score` — risk tooling
- `get_transaction_status` — poll inclusion by hash

Meta:

- `request_capability` — agent-facing escape hatch: files a GitHub issue on this repo when the user asks for something recon-crypto-mcp can't do (new protocol, new chain, missing tool). Default mode returns a pre-filled issue URL (zero spam risk — user must click to submit). Operators can set `RECON_FEEDBACK_ENDPOINT` to a proxy that posts directly. Rate-limited: 30s between calls, 3/hour, 10/day, 7-day dedupe on identical summaries.

Execution (Ledger-signed via WalletConnect):

- `pair_ledger_live`, `get_ledger_status` — session management and account discovery; `get_ledger_status` returns per-chain exposure (`accountDetails[]` with `address`, `chainIds`, `chains`) so duplicate-looking addresses across chains are disambiguated
- `prepare_aave_supply` / `_withdraw` / `_borrow` / `_repay`
- `prepare_compound_supply` / `_withdraw` / `_borrow` / `_repay`
- `prepare_morpho_supply` / `_withdraw` / `_borrow` / `_repay` / `_supply_collateral` / `_withdraw_collateral`
- `prepare_lido_stake`, `prepare_lido_unstake`
- `prepare_eigenlayer_deposit`
- `prepare_swap` — LiFi-routed intra- or cross-chain swap/bridge
- `prepare_native_send`, `prepare_token_send`
- `send_transaction` — forwards a prepared tx to Ledger Live for user approval

## Requirements

- Node.js >= 18.17
- An RPC provider (Infura, Alchemy, or custom) for the EVM chains
- Optional: Etherscan API key, 1inch Developer Portal API key (enables swap-quote comparison), WalletConnect Cloud project ID (required for Ledger signing), TronGrid API key (enables TRX + TRC-20 balance reads)

## Install

### From npm (recommended)

```bash
npm install -g recon-crypto-mcp
recon-crypto-mcp-setup
```

### From source

```bash
git clone https://github.com/szhygulin/recon-crypto-mcp.git
cd recon-crypto-mcp
npm install
npm run build
```

## Setup

Run the interactive setup to pick an RPC provider, validate the key, optionally pair Ledger Live, and write `~/.recon-crypto-mcp/config.json`:

```bash
npm run setup
```

Environment variables always override the config file at runtime.

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recon-crypto-mcp": {
      "command": "recon-crypto-mcp"
    }
  }
}
```

(If you installed from source rather than via `npm i -g`, swap `"command": "recon-crypto-mcp"` for `"command": "node"` and `"args": ["/absolute/path/to/recon-crypto-mcp/dist/index.js"]`.)

The setup script prints a ready-to-paste snippet.

## Environment variables

All are optional if the matching field is in `~/.recon-crypto-mcp/config.json`; env vars take precedence when both are set.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`, `BASE_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY` — contract verification lookups
- `ONEINCH_API_KEY` — enables 1inch quote comparison in `get_swap_quote`
- `TRON_API_KEY` — TronGrid API key (sent as `TRON-PRO-API-KEY`). Required in practice to read TRON balances — anonymous TronGrid calls are capped at ~15 req/min, which the portfolio fan-out exceeds. Free to create at [trongrid.io](https://www.trongrid.io).
- `WALLETCONNECT_PROJECT_ID` — required for Ledger Live signing
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)
- `RECON_ALLOW_INSECURE_RPC=1` — opt out of the https/private-IP check on RPC URLs. Only set this when pointing at a local anvil/hardhat fork; never in production.
- `RECON_FEEDBACK_ENDPOINT` — optional https URL for `request_capability` to POST directly (e.g. a maintainer-operated proxy that creates GitHub issues with a bot token). When unset (the default), `request_capability` returns a pre-filled GitHub issue URL for the user to click through; nothing is transmitted automatically. **Operator responsibility:** the recon-crypto-mcp client does not sign or authenticate POST requests. If you set this endpoint, the proxy MUST enforce its own auth (IP allowlist, Cloudflare Access, HMAC header validation, etc.) — otherwise any caller who learns the URL can submit to it. The on-process rate limiter (3/hour, 10/day) is a courtesy, not a security control.

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT — see [LICENSE](./LICENSE).
