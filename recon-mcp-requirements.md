# Recon MCP Server — Project Requirements Brief

## Vision

A single MCP server that gives AI agents (Claude Code, Claude Desktop, Cursor) real-time intelligence about a user's DeFi positions, protocol security, staking operations, and multi-chain portfolio — replacing the need to manually check dozens of dashboards and block explorers.

## Target users

- Developers using Claude Code who interact with DeFi protocols daily
- Protocol teams monitoring their own deployments and integrations
- Security researchers assessing protocol risk before or during audits
- Power users managing positions across multiple chains and protocols

---

## Module 1: DeFi position management

**Problem:** No existing MCP lets Claude understand a user's actual DeFi positions or warn about risks like liquidation.

**Core tools:**

- `get_lending_positions(wallet, chains?)` — fetch all lending/borrowing positions across Aave, Compound, Morpho, Maker, Spark, etc. Return collateral, debt, health factor, liquidation price
- `get_lp_positions(wallet, chains?)` — fetch liquidity provider positions across Uniswap, Curve, Balancer. Return token pair, value, impermanent loss estimate, fee earnings
- `get_vault_positions(wallet, chains?)` — fetch yield vault positions (Yearn, Beefy, Pendle, etc.). Return deposited amount, current value, APY, underlying strategy
- `get_health_alerts(wallet)` — return positions approaching liquidation thresholds (configurable, e.g. health factor < 1.5)
- `simulate_position_change(wallet, action, params)` — simulate adding/removing collateral or debt, show resulting health factor

**Chains (MVP):** Ethereum, Polygon, Arbitrum, Base, Optimism

**Data sources:** On-chain RPC calls via viem/ethers, DefiLlama API for protocol metadata, subgraph queries where available

---

## Module 2: Protocol security analysis

**Problem:** No MCP assesses the security posture of protocols a user is about to interact with.

**Core tools:**

- `check_contract_security(address, chain)` — run basic static analysis checks: is it verified on Etherscan? Is it upgradeable (proxy pattern)? Does the admin have unlimited mint/pause powers? Has it been audited (check audit registries)?
- `get_protocol_risk_score(protocol_name)` — aggregate risk signals: TVL trend (growing/shrinking), audit history, time since last exploit, number of audits, bug bounty program active (check Immunefi), contract age
- `check_token_risk(token_address, chain)` — check for honeypot patterns, unusual tax functions, owner mint capabilities, liquidity lock status
- `get_audit_history(protocol_name)` — fetch known audits from public registries (Sherlock, Code4rena reports, Solodit, DeFiSafety)
- `check_permission_risks(contract_address, chain)` — enumerate privileged roles (owner, admin, pauser, minter), check if they're EOA vs multisig, check timelock presence

**Data sources:** Etherscan/Blockscout APIs (contract verification, ABI), GoPlus Security API, DeFiSafety scores, Immunefi program registry, on-chain role enumeration

---

## Module 3: Staking operations

**Problem:** No MCP aggregates staking positions or helps compare validator/restaking performance.

**Core tools:**

- `get_staking_positions(wallet, chains?)` — fetch all staking positions: native ETH staking (Lido, Rocket Pool, Coinbase), restaking (EigenLayer, Symbiotic, Babylon), L1 staking (Polygon validators, Cosmos)
- `get_staking_rewards(wallet, period?)` — aggregate rewards earned across all staking positions for a given time period
- `compare_validators(protocol, count?)` — compare top validators by APY, uptime, commission, slashing history
- `get_restaking_exposure(wallet)` — map restaking dependencies: which AVSs is a user exposed to through EigenLayer operators, what's the slashing risk
- `estimate_staking_yield(protocol, amount)` — project expected yield based on current rates, including any lock-up periods

**Data sources:** Protocol-specific APIs (Lido, Rocket Pool, EigenLayer subgraphs), on-chain queries, validator explorer APIs, StakingRewards API

---

## Module 4: Multi-chain portfolio intelligence

**Problem:** Existing portfolio MCPs (CoinStats) do basic token tracking but don't understand DeFi-specific P&L, yield, or cross-chain exposure.

**Core tools:**

- `get_portfolio_summary(wallet, chains?)` — complete portfolio view: wallet balances + DeFi positions + staking + LP + vaults, denominated in USD with chain breakdown
- `get_portfolio_pnl(wallet, period)` — calculate actual profit/loss including: trading gains, yield earned, impermanent loss, gas costs, staking rewards
- `get_chain_exposure(wallet)` — show percentage allocation across chains, flag concentration risks
- `get_protocol_exposure(wallet)` — show percentage allocation across protocols, flag single-protocol concentration
- `get_historical_performance(wallet, period)` — track portfolio value over time including all DeFi positions, not just token holdings
- `export_tax_summary(wallet, year)` — generate a tax-relevant summary of transactions, yields, and realized gains (informational, not tax advice)

**Data sources:** Aggregation of Modules 1-3, token price APIs (CoinGecko/DefiLlama), Covalent/Moralis for historical transaction data, Zapper/Zerion APIs as fallback

---

## Architecture

```
User (Claude Code / Desktop / Cursor)
         │
         ▼
   Recon MCP Server (local npm package)
         │
    ┌────┴──────────────────────┐
    │   Tool Router             │
    │   ├── positions module    │
    │   ├── security module     │
    │   ├── staking module      │
    │   └── portfolio module    │
    └────┬──────────────────────┘
         │
    ┌────┴──────────────────────┐
    │   Data Layer              │
    │   ├── RPC (viem)          │
    │   ├── Subgraphs (urql)    │
    │   ├── REST APIs           │
    │   └── Cache (in-memory)   │
    └───────────────────────────┘
```

**Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), viem for on-chain reads, zod for input validation

**Distribution:** npm package, local stdio transport. User provides their own RPC URLs (Alchemy/Infura/QuickNode) via environment variables. No hosting required.

**Caching:** In-memory cache with configurable TTL per data type (e.g. prices = 30s, audit data = 24h, contract metadata = 7d)

---

## MVP scope (Phase 1)

Focus on read-only operations to ship fast and validate demand:

- Module 1: Aave V3 + Uniswap V3 positions only (Ethereum + Arbitrum)
- Module 2: Contract verification check + basic permission enumeration + Immunefi bounty lookup
- Module 3: Lido stETH + EigenLayer positions only
- Module 4: Basic portfolio summary aggregating the above

**Not in MVP:** Transaction execution, historical P&L, tax exports, vault positions, validator comparison

## Phase 2

- Expand protocol coverage (Compound, Morpho, Curve, Pendle, Rocket Pool)
- Add chains (Base, Optimism, Polygon)
- Historical P&L and performance tracking
- Token risk analysis (honeypot detection)
- Validator comparison and restaking exposure mapping

## Phase 3

- Transaction execution tools (deposit, withdraw, stake, unstake)
- Tax summary export
- Remote hosted tier with pre-indexed data and real-time alerts
- Premium features behind API key

---

## Success metrics

- GitHub stars and npm weekly downloads (adoption signal)
- Number of active MCP connections (if telemetry is opted in)
- Community contributions (PRs, protocol adapters)
- Conversion to premium tier (Phase 3)

## Competitive moat

No single MCP server combines DeFi positions + security intelligence + staking + portfolio analytics. Existing alternatives are either generic EVM tools (read balances, send transactions) or narrow market data feeds (prices, charts). This server understands protocols at the application layer — it knows what a health factor means, what impermanent loss is, and what a proxy upgrade pattern implies for security.
