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

## Phase 2 — broader coverage and richer reads

### Chain expansion
- Add EVM chains (Base, Optimism, Polygon) — reuses existing viem/LiFi/Aave V3 tooling
- Add non-EVM chains:
  - Tron — native TRX + TRC-20 (notably USDT-TRC20) balances, portfolio integration, and native/TRC-20 send txs signed via Ledger Live WalletConnect `tron:` namespace. Requires a separate SDK (e.g. `tronweb`) and address/validation layer
  - Bitcoin — native BTC balance, portfolio integration, and send txs via a UTXO library plus a REST indexer (mempool.space / Blockstream). Signing via Ledger Live WalletConnect `bip122:` namespace. Smart-contract-dependent tools (Aave, Uniswap, staking, security) are N/A

### Protocol expansion
- Lending: Compound V3, Morpho Blue, Spark
- DEX/LP: Curve, Balancer, PancakeSwap (BSC extension if added)
- Staking/restaking: Rocket Pool (rETH), Frax (sfrxETH), Karak, Symbiotic
- Yield: Pendle (PT/YT positions, maturity warnings), Ethena (sUSDe)
- Perps: GMX, Hyperliquid position reads (no execution in Phase 2)

### Arbitrary-token portfolio
- **Any-token balance lookup**: `get_token_balance(wallet, token_address, chain)` — accepts any ERC-20 / TRC-20 contract the user specifies, not just the curated "top tokens" list. Resolves symbol, decimals, and price via on-chain reads + DefiLlama (fallback to CoinGecko contract-address endpoint).
- **Multi-wallet portfolio**: `get_portfolio_summary` extended to accept an array of addresses and/or a named "wallet set" saved in user-config; outputs a consolidated view plus per-wallet breakdown.
- **ENS / name resolution**: accept `vitalik.eth`, `domain.tron`, or hex addresses interchangeably; reverse-resolve hex → primary name in outputs.
- **NFT holdings**: ERC-721 / ERC-1155 enumeration via Alchemy/QuickNode NFT APIs, with floor-price + last-sale hints from Reservoir / OpenSea.
- **Token metadata enrichment**: add `get_token_info(address, chain)` that returns contract verification, top holders, trading volume, LP depth, honeypot-risk indicators.

### Analytics / intelligence
- Historical P&L and cost-basis tracking (FIFO, lot-level) per wallet
- Realized vs. unrealized gains, per-token and portfolio-level
- Position-level APR / yield tracking with 7d and 30d averages
- Token risk analysis: honeypot detection, liquidity-lock checks, mint authority, ownership concentration
- Approval audit: list active ERC-20/721 approvals, flag high-risk ones, return a pre-built `revoke` tx per item (revoke.cash-style) — read in Phase 2, action in Phase 3
- Validator / operator comparison for staking + restaking (uptime, slashing history, commission)
- Airdrop eligibility checks against known campaigns (requires maintained snapshot data)
- Liquidation-risk projections across all lending protocols (not just Aave)
- Gas oracle + 30-day historical fee distributions per chain

### Safety reads
- Phishing/scam address lookup (Scamsniffer, Chainabuse, OFAC)
- Contract security extended: on-chain verification on non-Etherscan explorers (Blockscout, Arbiscan, Polygonscan, Tronscan)
- Simulated outcome preview for any tx — `simulate_tx(unsignedTx)` using `eth_call` + state-override / Tenderly integration; returns balance deltas, slippage vs. expected, and side-effects

## Phase 3 — expanded execution

All execution tools route through Ledger Live via WalletConnect (existing safety pattern: explicit `confirmed: true`, human-readable preview, simulated outcome).

### Send / receive
- `prepare_native_send(chain, to, amount)` — ETH / MATIC / ARB / BTC / TRX
- `prepare_token_send(chain, token, to, amount)` — any ERC-20 / TRC-20 (including `amount: "max"`)
- `prepare_nft_send(chain, collection, tokenId, to)` — ERC-721 and ERC-1155 with quantity
- `prepare_batch_send` — multiple transfers bundled via Multicall3 or EIP-7702 delegated batching

### Swap / bridge (already in MVP via LiFi — extend)
- Limit-order tool on top of CoW Swap / 1inch Fusion
- DCA (dollar-cost-average) via scheduled tx generation — user signs a batch manifest; MCP returns the next-due slice on request
- Slippage-aware repricing for long-running quotes
- Refuel bridge for cross-chain gas top-ups

### Lending / borrowing — expand beyond Aave
- Same verb set (supply, withdraw, borrow, repay, `set_collateral_mode`, `migrate_position`) for Compound, Morpho, Spark
- Health-factor-aware `suggest_repay` / `suggest_deleverage` that builds the minimum-sized tx to reach a target HF
- Flashloan-backed deleveraging on Aave V3 (single-tx collateral swap)

### Staking / restaking / yield
- `prepare_claim_rewards(protocol, wallet)` — Lido rewards are auto-compounding, but add Rocket Pool, Pendle PT claim at maturity, EigenLayer + Karak rewards
- `prepare_restake_delegation(operator)` — EigenLayer operator switch
- `prepare_pendle_buy_pt` / `prepare_pendle_redeem` — yield-fixing workflows
- `prepare_unstake_timer_check` — return the unlock timestamp for any locked staking position

### LP management
- `prepare_uniswap_v3_mint` / `collect_fees` / `decrease_liquidity` / `burn`
- `prepare_uniswap_v3_rebalance` — out-of-range → in-range reposition in one batched tx
- `prepare_curve_add_liquidity` / `remove_liquidity`
- `prepare_balancer_join_pool` / `exit_pool`

### NFT marketplace
- `prepare_nft_list(collection, tokenId, price, marketplace)` — Seaport / Blur / OpenSea
- `prepare_nft_buy(listing_id, marketplace)`
- `prepare_nft_cancel_listing`
- `prepare_nft_accept_offer`

### Governance
- `list_open_proposals(protocol, wallet)` — outstanding votes for any protocol the user has governance tokens in (Snapshot + on-chain Governor)
- `prepare_vote(proposal_id, support, reason?)`
- `prepare_delegate(protocol, delegatee)`
- `prepare_claim_governance_reward`

### Approval management
- `list_active_approvals(wallet, chain)` — ERC-20 + ERC-721 `setApprovalForAll` + Permit2 allowances
- `prepare_revoke_approval(token, spender)` — one-tx revoke
- `prepare_batch_revoke` — revoke all high-risk approvals in one bundle

### Airdrops / claims
- `check_airdrop_eligibility(wallet)` — across known open claims
- `prepare_airdrop_claim(campaign, wallet)` — produce the merkle-proofed claim tx

### Pre-trade safety (execution side)
- Every `prepare_*` tool returns a `simulation` field: expected balance deltas, gas cost in USD, price impact vs. reference, and recipient reputation flag
- `check_destination(address)` — is it a known mixer, sanctioned, phishing report, contract with admin override?
- Mandatory safety gate on transfers > threshold the user configures

### Account abstraction (opt-in)
- EIP-7702 session delegation: a one-time signed authorization that lets the MCP execute a narrow, time-bounded policy (e.g. "auto-rebalance LP below 1% impact, only on Arbitrum, for 24 hours") without further signing
- Gasless UX via paymasters on L2s

### Automation scaffolding (MCP-side)
- `schedule_tx(cron, preparedTx)` — persist a tx template; on each `/tick` the MCP returns the next-due instance for the agent to prompt and sign
- `watch_condition(rule, tx_template)` — e.g. "if HF < 1.4, prepare a 20% repay tx" — the tool returns the pre-signed-but-not-broadcast tx when the rule fires (full on-chain keepers are out of scope)

### Non-crypto adjacencies
- Tax summary export: CSV in Koinly/CoinTracker format, lot-level with cost basis
- Portfolio reports: PDF / Markdown snapshot for record keeping
- Address book: named contacts with chain + tag metadata

### Infrastructure
- Remote hosted tier with pre-indexed data (subgraphs + internal indexer) for sub-second reads
- Real-time push alerts (health factor, liquidation, whale movement, exploit-pause, governance notices) via webhooks/email/Telegram
- Premium features behind API key

---

## Success metrics

- GitHub stars and npm weekly downloads (adoption signal)
- Number of active MCP connections (if telemetry is opted in)
- Community contributions (PRs, protocol adapters)
- Conversion to premium tier (Phase 3)

## Competitive moat

No single MCP server combines DeFi positions + security intelligence + staking + portfolio analytics. Existing alternatives are either generic EVM tools (read balances, send transactions) or narrow market data feeds (prices, charts). This server understands protocols at the application layer — it knows what a health factor means, what impermanent loss is, and what a proxy upgrade pattern implies for security.
