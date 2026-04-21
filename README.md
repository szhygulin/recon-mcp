# VaultPilot MCP

[![npm version](https://img.shields.io/npm/v/vaultpilot-mcp.svg)](https://www.npmjs.com/package/vaultpilot-mcp)
[![license](https://img.shields.io/npm/l/vaultpilot-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/vaultpilot-mcp.svg)](package.json)
[![vaultpilot-mcp MCP server](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp/badges/score.svg)](https://glama.ai/mcp/servers/szhygulin/vaultpilot-mcp)

**Self-custodial crypto portfolio and DeFi, managed by AI agents — signed on your Ledger hardware wallet.**

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

The signing pipeline crosses several independent trust boundaries, each of which can be compromised in isolation:

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

The Ledger device is the only component whose display the user sees directly (not filtered through the agent) and which cannot be software-compromised at the host level. Everything else can fail. VaultPilot's defenses are layered so that **most single-layer compromises are caught, single-layer compromises are caught by at least one cross-check, and coordinated multi-layer attacks are either caught or honestly called out as unprotected**.

### Defenses and what each catches

| Layer | Threat it catches | Honest limits |
|---|---|---|
| **Prepare↔send `payloadFingerprint`** — domain-tagged `keccak256` over `{chainId, to, value, data}`, checked at send time | MCP-internal drift between prepare and send (bug or bytes-swap at send) | Not what Ledger displays. The server never claims this matches the device hash. |
| **Independent 4byte.directory cross-check** — auto-emitted `[CROSS-CHECK SUMMARY]` block on every `prepare_*` | Agent fabricating a "✓ cross-check passed" line; server-side ABI swap vs. the public selector registry | Function-signature only (no arg values). "error" / "not-applicable" states are surfaced verbatim rather than masked. |
| **Swiss-knife decoder URL + local ABI decode + three trust-boundary options (a)(b)(c)** in the VERIFY-BEFORE-SIGNING block | MCP-side calldata tampering — the user re-decodes the same bytes against Etherscan's ABI in a browser controlled by them, or against the agent's own model-weight ABI knowledge | Requires user action. Swiss-knife is a client-side Next.js SPA — agent `WebFetch` on the URL returns the JS shell; the useful check is decoding the URL's `?calldata=` query param, which the agent can do locally. |
| **`LEDGER BLIND-SIGN HASH` block** — EIP-1559 pre-sign RLP `keccak256` over `{chainId, nonce, maxFeePerGas, maxPriorityFeePerGas, gas, to, value, data}`, emitted by `preview_send` | Any bytes-tampering between MCP and the device: WC-relay MITM, Ledger Live malware, a USB-channel adversary on TRON. The value is what the device will display in blind-sign mode; the user matches on-device. | Bytes-integrity only — does not prove the bytes match user intent (calldata could still be malicious if MCP itself is compromised). Tapping "Edit gas" in Ledger Live invalidates the match by design; the in-block wording says "you may still approve, but the hash-match guarantee no longer applies." |
| **`PREPARE RECEIPT` block** — verbatim-relay of the raw args the agent passed to `prepare_*` | Narrow agent compromise: prompt injection from other tool output, malicious Claude skill, compromised subagent in a delegation chain — anything that rewrites args without also crafting a matching filter on the agent's output | Defense-in-depth, not a hard boundary. A fully-coordinated compromised agent can drop or mutate the block; "verbatim relay" is a social contract enforced by in-block prose. |
| **Agent-side independent pre-sign hash recomputation** — optional (d) offered by `preview_send`, instructed via an agent-task block | Compromised MCP that reports a hash inconsistent with the bytes it forwards to WC. The agent uses its own prepare-time `data` + MCP's returned pin + `viem` (a separate code trust boundary) to `keccak256(serializeTransaction(...))` and compare against MCP's claim. | Requires local code execution. For contract calls, depends on the agent first decoding `data` against its built-in ABI knowledge to sanity-check intent — otherwise the hash check tautologically agrees with any tuple. For native sends (`data = "0x"`), the agent knows the full tuple and the check is clean. |
| **`previewToken` + `userDecision` gate on `send_transaction`** — server-minted UUID (bound to the pin, re-minted on `refresh:true`) plus `z.literal("send")`, both required on every EVM send | Accidental preview-step collapse: agent going `preview_send` → `send_transaction` in one silent step, skipping the `EXTRA CHECKS YOU CAN RUN BEFORE REPLYING "SEND"` menu that `preview_send`'s agent-task block instructs it to surface. Missing/mismatched values cause a clear-error refusal naming the missing arg. | Schema-level, not user-physical. A fully-hostile agent can still fabricate `userDecision: "send"` after calling `preview_send` for a real token — the server has no channel to distinguish "user really said send" from "agent claims user said send". Closes careless mistakes, not coordinated lying. |
| **Ledger device display** — `To`, `Value`, hash in blind-sign; decoded fields when a plugin clear-signs (Aave, Lido, 1inch, LiFi, approve) | Any tampering that survived every software layer. The device serializes the bytes it received and hashes locally; the user's eyeball on the device screen is the final check. | Blind-sign shows no calldata decode. Intent-vs-bytes matching on contract calls happens off-device, through swiss-knife / agent model-weight decode. |

### Threat → what catches it

- **Prompt injection / malicious skill / compromised subagent (narrow):** `PREPARE RECEIPT` surfaces the args that hit MCP, bypassing the agent's natural-language retelling. For native sends, the Ledger device's `To` / `Value` display backstops even if the receipt is dropped. For contract calls (swaps, supplies, approvals) the calldata remains unverifiable on-device in blind-sign — the user should open the swiss-knife decoder URL or ask the agent to decode against its own model-weight ABI knowledge.
- **Fully-corrupted agent that coordinates on BOTH arg manipulation AND output filtering:** No protection. The user's entire view flows through the agent; there is no non-agent display channel for calldata in blind-sign mode. Conceded honestly — this threat is only reachable with a non-agent display channel (a hardware wallet with full clear-signing for the target calldata), which we do not have yet for most contract calls.
- **Compromised MCP (lies about hash, swaps bytes at send-time):** `LEDGER BLIND-SIGN HASH` catches bytes-tampering between MCP and device — the device recomputes from received bytes, and the user matches the agent-relayed value against the device-displayed one. Agent-side independent hash recomputation (optional (d)) gives an honest agent a first-line check before the device is involved.
- **Compromised Ledger Live or WalletConnect relay (middle-layer MITM):** `LEDGER BLIND-SIGN HASH` — the device is the source of truth; any substitution between MCP and the device produces a divergent on-device hash.
- **Agent accidentally skips the EXTRA CHECKS menu at preview time:** `previewToken` (server-minted at `preview_send`, stashed on the pin) + `userDecision: "send"` (schema literal) on `send_transaction`. Both required on the EVM path; missing/mismatched values cause a clear-error refusal naming the missing arg. A fully-hostile agent can still forge `userDecision` after a legitimate `preview_send`, so this is a careless-mistake backstop, not a coordinated-lying defense.
- **"Edit gas" in Ledger Live:** Hash mismatch is expected (the user changed a hashed field). The in-block wording explicitly allows "accept the tradeoff without the hash-match guarantee" — user owns the choice; not a bug.

### Asymmetry worth naming

For the compromised-MCP case, the honest agent is a real second trust boundary — it knows the user-intent args and can recompute the expected hash. For the compromised-agent case, MCP has no ground truth for user intent; forcing verbatim args relay (`PREPARE RECEIPT`) raises the tampering bar for narrow injections but does not close the gap against a coordinated attacker. Both halves of the asymmetry are enforced in code and covered by `test/integration-security.test.ts`.

### Verifying the server-side `payloadFingerprint` yourself

EVM preimage: `"VaultPilot-txverify-v1:" ‖ chainId (32-byte BE) ‖ to (20 bytes) ‖ value (32-byte BE) ‖ data`.

```sh
# Paste calldata, address, and chainId from the swiss-knife URL; value is shown in chat.
TAG=$(cast from-utf8 "VaultPilot-txverify-v1:")
CHAIN=$(cast to-uint256 1)         # chainId
TO=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
VALUE=$(cast to-uint256 0)         # wei, as shown in chat
DATA=0xa9059cbb...                 # from swiss-knife ?calldata=
cast keccak $(cast concat-hex "$TAG" "$CHAIN" "$TO" "$VALUE" "$DATA")
```

TRON preimage: `"VaultPilot-txverify-v1:tron:" ‖ rawDataHex`.

This fingerprint is a server-side prepare↔send integrity tag — it is **not** the hash Ledger's blind-sign screen displays (those are different preimages; Ledger hashes the full EIP-1559 RLP including nonce and fees). The blind-sign-matchable hash is emitted by `preview_send` in a separate `LEDGER BLIND-SIGN HASH` block.

### Second-agent verification (optional, for the coordinated-agent case)

The table above honestly concedes that a fully-coordinated agent compromise — where the same agent that invokes `prepare_*` with malicious args also filters what the user sees in chat — has no software-only defense, because the user's entire view flows through the agent.

`get_verification_artifact(handle)` narrows that gap. It returns a sparse artifact — `{chain, chainId, from, to, value, data, payloadHash, preSignHash?}` for EVM, analogous TRON shape — deliberately stripped of the server's own humanDecode, swiss-knife URL, and 4byte cross-check. Alongside the structured fields, the artifact carries a `pasteableBlock` string: a single self-contained paste target with explicit `===== COPY FROM THIS LINE =====` / `===== END — STOP COPYING HERE =====` markers, the instructions, and the embedded JSON payload between them. The user copies everything between the markers into a **second, independent LLM session** (ideally a different provider) and lets that agent decode the bytes from scratch with no shared context. If the two agents disagree on what the transaction does, the first agent was lying — abort. The `from` field lets the second agent auto-check in-calldata recipients (unwrapWETH9 target, bridge destination, transfer `to`) against the signer — mismatches get flagged; matches are silently accepted as expected self-targeted operations (swaps, unwraps, withdrawals).

The Ledger device is the fabrication anchor: a compromised first agent can't invent bytes whose `preSignHash` matches the hash the Ledger screen displays at sign time. The canned prompt reminds the user to compare the artifact's `preSignHash` against the device before tapping approve — any mismatch proves the artifact was forged mid-flight, and the tx is rejected on-device anyway.

Limits worth naming:

- Does not catch a supply-chain compromise of the MCP process itself (the bytes the server builds are still the bytes it ships).
- Does not catch a coordinated attack that simultaneously compromises both LLM providers (significantly harder than compromising one).
- Does not replace the normal `VERIFY-BEFORE-SIGNING` block — it is an additional tool for skeptical users on high-value or unfamiliar-contract flows.

## Supported chains

EVM: Ethereum, Arbitrum, Polygon, Base.

Non-EVM: TRON — full reads (balance, staking state, SR listing) and full write coverage (native TRX sends, canonical TRC-20 transfers, voting-reward claims, Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze, and VoteWitness) signed on a directly-connected Ledger over USB HID. Ledger Live's WalletConnect relay does not currently honor the `tron:` namespace (verified 2026-04-14), so TRON signing goes through `@ledgerhq/hw-app-trx` — the user's Ledger must be plugged into the host running the MCP, unlocked, with the TRON app open. Pair via `pair_ledger_tron` once per session.

Not every protocol is on every chain. Lido and EigenLayer are L1-only (Ethereum). Morpho Blue is currently enabled on Ethereum only — it is deployed on Base at the same address but the discovery scan needs a pinned deployment block, tracked as a follow-up. TRON has no lending/LP coverage in this server (none of Aave/Compound/Morpho/Uniswap are deployed there); balance reads return TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD) that together cover the vast majority of TRON token volume, and TRON-native staking (frozen TRX under Stake 2.0, pending unfreezes, claimable voting rewards) is surfaced via `get_tron_staking` and folded into the portfolio summary. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

- **MetaMask support** (WalletConnect) — alongside the existing Ledger Live integration. Will let users sign through a MetaMask-paired session when a hardware wallet isn't available.
- **Solana** — coming later. Non-EVM: introduces a separate SDK (`@solana/web3.js`), base58 addresses, and the WalletConnect `solana:` namespace for signing.
- **Server-integrated second-agent verification** — have the MCP call an independent second-provider LLM directly on every high-value or blind-sign-expected `send_transaction`, relay its verdict to the user, and block the send on disagreement. Structurally closes the coordinated-agent gap that today's copy-paste `get_verification_artifact` flow only narrows (the copy-paste path depends on the first agent not silently suppressing the artifact). Additive, opt-in feature — the self-custody trust model (no private keys on the server, no broadcast without device approval) is unchanged.

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
- `get_verification_artifact` — returns a sparse, copy-paste-friendly JSON artifact (raw calldata + chain + payloadHash + preSignHash if pinned) for a prepared tx, plus a canned prompt telling a second LLM how to independently decode it. Intended for adversarial cross-verification on high-value flows — see §"Second-agent verification" above

Meta:

- `request_capability` — agent-facing escape hatch: files a GitHub issue on this repo when the user asks for something vaultpilot-mcp can't do (new protocol, new chain, missing tool). Default mode returns a pre-filled issue URL (zero spam risk — user must click to submit). Operators can set `VAULTPILOT_FEEDBACK_ENDPOINT` to a proxy that posts directly. Rate-limited: 30s between calls, 3/hour, 10/day, 7-day dedupe on identical summaries.

Execution (Ledger-signed):

- `pair_ledger_live` (WalletConnect, EVM), `pair_ledger_tron` (USB HID, TRON), `get_ledger_status` — session management and account discovery; `get_ledger_status` returns per-chain EVM exposure (`accountDetails[]` with `address`, `chainIds`, `chains`) so duplicate-looking addresses across chains are disambiguated, and a `tron: [{ address, path, appVersion, accountIndex }, …]` array (one entry per paired TRON account) when `pair_ledger_tron` has been called. Pass `accountIndex: 1` (2, 3, …) to pair additional TRON accounts.
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
