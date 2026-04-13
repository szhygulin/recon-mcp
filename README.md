# Recon MCP

An MCP server that gives AI agents (Claude Code, Claude Desktop, Cursor) real-time intelligence about DeFi positions, protocol security, staking, and multi-chain portfolios — plus transaction signing through Ledger Live over WalletConnect.

## Features

- **Positions** — lending/borrowing (Aave, Compound, Morpho), LP positions, and health-factor alerts
- **Portfolio** — cross-chain balances, DeFi position aggregation, USD-denominated summaries; optionally folds Bitcoin holdings in alongside EVM
- **Staking** — Lido, EigenLayer, reward aggregation, yield estimation
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, protocol risk scoring
- **Swaps** — LiFi-routed intra-chain and cross-chain quotes; intra-chain routes are also cross-checked against 1inch (when an API key is configured) with a `bestSource` hint and output-delta savings
- **Bitcoin** — read-only balances via mempool.space, plus unsigned-send preparation with a consolidation-oriented UTXO selection (spends every spendable UTXO, dust-absorbing) and raw-tx broadcast. Trades a higher one-time fee for a cleaner wallet (0 or 1 UTXO remaining post-confirmation). No PSBT — the returned plan is signed externally (Sparrow, Electrum, hardware wallet)
- **Execution** — tx preparation for Aave, Compound, Morpho, Lido, EigenLayer, native/token sends, swaps; signing via Ledger Live (WalletConnect) for EVM chains
- **Utilities** — ENS forward/reverse resolution, token balances, transaction status

## Supported chains

EVM: Ethereum, Arbitrum, Polygon. Bitcoin mainnet (read + send preparation, no on-device signing yet).

## Requirements

- Node.js >= 18.17
- An RPC provider (Infura, Alchemy, or custom) for the EVM chains
- Optional: Etherscan API key, 1inch Developer Portal API key (enables swap-quote comparison), WalletConnect Cloud project ID (required for Ledger signing)
- No API key required for Bitcoin — mempool.space is used directly

## Install

```bash
npm install
npm run build
```

## Setup

Run the interactive setup to pick an RPC provider, validate the key, optionally pair Ledger Live, and write `~/.recon-mcp/config.json`:

```bash
npm run setup
```

Environment variables always override the config file at runtime.

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recon-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/recon-mcp/dist/index.js"]
    }
  }
}
```

The setup script prints a ready-to-paste snippet.

## Environment variables

All are optional if the matching field is in `~/.recon-mcp/config.json`; env vars take precedence when both are set.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY` — contract verification lookups
- `ONEINCH_API_KEY` — enables 1inch quote comparison in `get_swap_quote`
- `WALLETCONNECT_PROJECT_ID` — required for Ledger Live signing
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT
