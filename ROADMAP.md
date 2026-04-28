# VaultPilot Roadmap

**In flight**

- **Kamino lending** (Solana) — PR #151 landed the `@solana-program/kit` bridge foundation; supply / withdraw / borrow / repay tools follow.

**New protocols (EVM)**

- **Curve + Convex + Pendle + GMX V2** — stable-LP / yield-trading / perps. Direct ABI integration for Curve / Convex / GMX; `@pendle/sdk-v2` for Pendle. ([plan](./claude-work/plan-defi-expansion-roadmap.md))
- **Balancer V2 + V3 + Aura** — Vault-centric LP + V3 Hooks pools + Aura boost. ([plan](./claude-work/plan-balancer-v2-v3-aura.md))
- **DEX liquidity verb set** — Uniswap V3 `mint` / `collect` / `decrease_liquidity` / `burn` / `rebalance` (reads already shipped), Curve LP, Balancer LP. ([plan](./claude-work/plan-dex-liquidity-provision.md))
- **Canonical L1↔L2 / L2↔L2 bridges** — Optimism / Base (Bedrock, shared ABI), Arbitrum, Polygon PoS. Trust-minimized alternative to LiFi: slow (7-day proof window for OP-Stack rollups, ~30 min – 3 h for Polygon PoS exit) but L1-anchored. Phased per-bridge; Phase 1 (OP+Base) is the smallest unit. ([plan](./claude-work/plan-canonical-bridges.md))

**New chains**

- **Bitcoin** via Ledger USB HID — native segwit + taproot sends, portfolio integration, mempool.space fee estimation, BIP-125 RBF by default. ([plan](./claude-work/plan-bitcoin-ledger-phase1.md))
- **Hyperliquid L1** — full parity (perps + spot + vaults + staking + TWAP). Ledger-per-trade blind-sign signing; no API-wallet shortcut. ([plan](./claude-work/plan-hyperliquid-full-parity.md))
- **Aptos + Sui** (Move-VM) — read first (balance + staking + Sui objects), then Ledger USB HID pair + native send + stake delegate per chain. WalletConnect doesn't carry Move namespaces, so signing follows the TRON / Solana USB precedent. Phase 1 (Aptos read-only) is the smallest unit. ([plan](./claude-work/plan-aptos-sui-chain-support.md))

**More Solana protocols**

- **Drift + Solend lending** — after Kamino lands.
- **Jito liquid-staking writes** — reads ship today; writes blocked on the SDK's ephemeral-signer pattern, raw-ix builder workaround tracked.
- **Multi-tx send pipeline** — unblocks flows that exceed the single-v0-tx size limit (needed for parts of Kamino / Drift).

**New tools**

- **`check_liquidation_risk`** — per-asset "ETH drops X% triggers liquidation" math across Aave V3 / Compound V3 / Morpho Blue. Replaces today's raw-HF-number output with actionable price deltas. ([plan](./claude-work/plan-health-factor-monitoring.md))
- **`get_pnl_summary`** — wallet-level net PnL over preset periods across EVM / TRON / Solana. Balance-delta minus net user contribution, priced via DefiLlama historical. ([plan](./claude-work/plan-pnl-summary-tool.md))
- **`prepare_eth_validator_deposit`** — solo-validator activation: 32 ETH deposit to the Beacon Deposit Contract (`0x00000000219ab540356cBB839Cbe05303d7705Fa`) using a `deposit_data.json` produced off-chain by `staking-deposit-cli`. Optional batch shape for multi-validator activations. Today's `prepare_lido_stake` produces stETH (LST exposure, not validator ownership) and `prepare_eigenlayer_deposit` is restaking on top of an existing LST — neither activates a solo validator. ([#430](https://github.com/szhygulin/vaultpilot-mcp/issues/430))

**`compare_yields` adapter expansion** — v1 covers Aave V3 + Compound V3 + Lido (PR #282); v2 bundles Marinade + Jito + Kamino-lend + Morpho-Blue via DefiLlama. The remaining three protocols ship as separate adapters; full scope and rationale in [plan-yields-v2-followups.md](./claude-work/plan-yields-v2-followups.md).

- **MarginFi lending adapter** — DefiLlama doesn't carry MarginFi borrow-lend (only their LST product); needs an on-chain wallet-less bank reader split out from `getMarginfiPositions`. Same shape `getCompoundMarketInfo` already establishes.
- **EigenLayer + Solana native-stake adapters** — structurally different (per-operator / per-validator rows, not per-protocol APR); each needs its own plan file before implementation.

**NFT tooling — Solana follow-ups to #433**

The portfolio reader landed Solana NFT support via Helius DAS in #433; the per-feature readers and pricing are deferred follow-ups.

- **Solana branch on `get_nft_history`** — wire Helius DAS `getSignaturesForAsset` (per-asset granularity), mapped to the existing `NftHistoryItem` shape (mint / sale / transfer / etc.). Probably a `solanaAsset` arg distinct from the EVM `wallet` shape. ([#474](https://github.com/szhygulin/vaultpilot-mcp/issues/474))
- **Solana branch on `get_nft_collection`** — DAS `getAssetsByGroup({groupKey: "collection"})` for collection metadata + Magic Eden's `/v2/collections/{symbol}/stats` for floor / volume / royalty. Degrades cleanly when Magic Eden is rate-limited (collection metadata still surfaces). ([#475](https://github.com/szhygulin/vaultpilot-mcp/issues/475))
- **Solana NFT portfolio floor pricing** — fan out per-collection floor lookups via Magic Eden (Tensor as fallback) so `floorEth` / `floorUsd` / `totalFloorUsd` populate on Solana rows; drops the current `notes[]` advisory that calls out the gap. ([#476](https://github.com/szhygulin/vaultpilot-mcp/issues/476))

**Bitcoin / Litecoin tooling**

- **BIP-322 message signing** — `sign_message_btc` ships BIP-137 today, which fails (or falls back to legacy-address tricks) for `bc1q` (P2WPKH) and `bc1p` (Taproot) addresses. Modern verifiers (exchanges, proof-of-reserves tools, Sparrow / Coldcard ecosystem) expect BIP-322. Deferred pending a scope probe of the Ledger BTC app's BIP-322 firmware floor + which SDK exposes the entrypoint (`@ledgerhq/hw-app-btc` vs the newer `ledger-bitcoin` v2 client) — implementing the wrong flavor (simple / full / legacy) yields valid signatures verifiers reject, and signature-flavor bugs are silent (sig generates, verifier rejects, user is confused). ([#438](https://github.com/szhygulin/vaultpilot-mcp/issues/438))
- **`dryRun` mode for `prepare_btc_send` / `prepare_ltc_send`** — `dryRun: true` synthesizes a placeholder `paired` shape (addressType inferred from prefix, source-as-change loopback, `signable: false` flag) so an agent can build + return calldata without first running `pair_ledger_btc` / `pair_ledger_ltc`. The pairing-cache lookup is woven through the build flow at multiple points (`addressType` / `accountIndex` / `path` for PSBT input + `pickChangeEntry` derivation), so this is real surgery (~80 LoC per chain), not a one-line guard. Today's pairing-required flow covers the actual signing case; `dryRun` is forward-looking inspection. ([#479](https://github.com/szhygulin/vaultpilot-mcp/issues/479))

**Wallet integrations**

- **MetaMask Mobile** via WalletConnect v2 — alongside Ledger Live. Reduced final-mile anchor (software wallet) surfaced clearly in docs + pairing receipt. Browser-extension bridge deferred to a follow-up. ([plan](./claude-work/plan-metamask-mobile-walletconnect.md))

**Deployment modes**

- **Hosted MCP endpoint** — OAuth 2.1 + bearer tokens for headless users, operator-supplied API keys, EVM-only for v1. TRON / Solana USB HID tools stay local. ([plan](./claude-work/plan-hosted-mcp-endpoint.md))

**Security hardening**

- **Server-integrated second-agent verification** — MCP calls an independent LLM directly on high-value sends and blocks on disagreement. Structurally closes the coordinated-agent gap that today's copy-paste `get_verification_artifact` flow only narrows.
- **PreToolUse hook for mechanical hash enforcement** — host-side code that recomputes the pre-sign hash and blocks the MCP tool call on divergence, making the check mechanical rather than prose-based. Ships as a separate `vaultpilot-hook` repo.
- **Contacts unsigned/verified state machine** (follow-up to [#428](https://github.com/szhygulin/vaultpilot-mcp/issues/428)) — persistent on-disk unsigned entries + `promote_unsigned_contacts` sign-on-pair upgrade flow + tamper-aware merge between signed and unsigned overlays. Today's #428 fix covers the user-visible "first-run users can label addresses without a Ledger" gap with a process-local in-memory store; the deferred state machine adds restart-survivable persistence and the upgrade-on-pair semantics. ([plan](./claude-work/plan-contacts-unsigned-state-machine.md))
- **Sandwich-MEV hint expansion to L2s** — mainnet hint ships in `prepare_swap` / `prepare_uniswap_swap` (slippage × notional flagged at 0.5% on Ethereum). L2 expansion (Optimism / Base / Arbitrum / Polygon PoS / zk-rollups) needs per-chain thresholds + wording that honestly reflects the lower-but-nonzero risk on each ordering model. ([plan](./claude-work/plan-mev-hint-l2-expansion.md))
- **Tier-1 bridge facet decoders — MCP-side mechanical (Inv #6b hardening)** — adversarial scripts 136 / 137 confirmed the trust boundary the preflight skill explicitly accepts is exploitable: outer LiFi `BridgeData` passes Inv #6 cleanly, but the attacker recipient lives one decode-layer deeper (`NearData.receiverAccountId`, `MayanData.nonEvmRecipient`, etc.) and the Ledger ETH app blind-signs the swap. Skill v8 Inv #6b mandates the agent extract + compare; the deferred work is the complementary MCP-side mechanical decoder for Wormhole TokenBridge / Mayan / NEAR Intents / Across V3 — server-side `✗ BRIDGE-FACET RECIPIENT MISMATCH — DO NOT SIGN` check that fires regardless of agent cooperation. Coordinated MCP + skill release: skill sentinel bump that hardens Inv #6b from "agent-extracts" to "MCP-decodes-and-asserts", paired with the MCP decoder shipping in lockstep. Blocked on a per-bridge scope probe of facet tuple shapes against real explorer calldata samples — wrong-tuple decode parses garbage as a "valid" recipient and ships a silent vuln. ([#451](https://github.com/szhygulin/vaultpilot-mcp/issues/451))
- **Tier-2 bridge facet decoders** — skill v8 ships Tier-1 (Wormhole / Mayan / NEAR Intents / Across V3) recipient cross-checks under Inv #6b. Tier-2 (deBridge / DLN, Stargate composeMsg, Hop, Symbiosis) is deferred until usage data justifies the per-bridge probe + decoder cost. Falls back to best-effort agent address-extraction + mandatory second-LLM check (Inv #12.5) until shipped. ([plan](./claude-work/plan-bridge-facet-decoder-tier2.md))
- **Typed-data signing surface — gated on Inv #1b + #2b** — `prepare_eip2612_permit`, `prepare_permit2_*`, `prepare_cowswap_order`, `sign_typed_data_v4`. Today's defense is gap-by-design (no typed-data tool exists). The moment one ships without paired Inv #1b (typed-data tree decode + verifyingContract pin + address-field surfacing) and Inv #2b (digest recompute over the decoded tree), every existing skill defense is silently bypassed — a hash-recompute check passes tautologically over a tampered tree, and Inv #11's selector check is for the on-chain submission path, not the upstream typed-data signing where the attack lands. Hard precondition: Ledger device must clear-sign the typed-data type for the target token / domain. Policy enforced via the [Typed-Data Signing Discipline](./CLAUDE.md#typed-data-signing-discipline) section in CLAUDE.md. ([#453](https://github.com/szhygulin/vaultpilot-mcp/issues/453))
- **`prepare_eip7702_authorization` builder + skill v9 release** — EIP-7702 setCode is the highest-blast-radius signature an EOA can produce (full code-execution rights, persistent across sessions, `chain_id = 0` drains every EVM chain at once). Skill v8 §16 currently refuses 7702 setCode unconditionally as defense-by-gap until the MCP arm + skill v9 ship together. **MCP arm** — `prepare_eip7702_authorization({ implementation, chainId, nonce })` targeting **ERC-5792 `wallet_sendCalls`** (NOT bare `eth_signAuthorization` — WC namespaces don't standardize a 7702 method, ERC-5792 is the wallet-side convergence point) with `chain_id ≠ 0` enforcement, paired revocation-tuple emission, Inv #12.5 mandatory second-LLM precondition, and out-of-band implementation-address re-statement. Curated MCP/skill implementation allowlist NOT needed — Ledger ETH app v1.18.0+ enforces it on-firmware (the strongest layer; can't be bypassed by compromised MCP/agent/skill). **Skill arm** — bump v8 → v9 with §16 lifted, MCP-side `EXPECTED_SKILL_SHA256` updated in lockstep. Blocked on a scope probe of Ledger Live's WalletConnect bridge support for ERC-5792 `wallet_sendCalls` — without that transport the builder is unreachable on this server's signing path even with skill v9. ([#481](https://github.com/szhygulin/vaultpilot-mcp/issues/481))

**Recently shipped** (previously on this list)

- **`compare_yields`** — ranked supply-side yield comparison across integrated lending / staking protocols. Covers Aave V3 (5 EVM chains), Compound V3 (5 EVM chains, multi-market), Lido stETH, plus DefiLlama-backed Marinade / Jito / Kamino-lend / Morpho-Blue curated vaults. Surfaces data, doesn't pick — the user decides. Remaining adapters (MarginFi on-chain, EigenLayer, Solana native-stake) on the roadmap above (#282 v1, #431 v2 bundle).
- **Nonce-aware dropped-tx polling** (Solana) — on-chain nonce is the authoritative signal for whether a durable-nonce tx can still land; replaces the `lastValidBlockHeight` path that's meaningless for nonce-protected sends (#137).
- **Solana liquid + native staking** — Marinade / Jito / native stake-account reads (#141, portfolio fold-in #143), Marinade writes (#145), native SOL delegate / deactivate / withdraw (#149).
- **LiFi cross-chain EVM ↔ Solana routing** (#153, #155).
