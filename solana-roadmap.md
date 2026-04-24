# Solana post-Phase-3 roadmap

## Context

Solana Phase 3 (Milestones A-D from `okay-lets-make-sure-scalable-cake.md`) is fully shipped — Jupiter swap, MarginFi lending, portfolio integration, plus follow-up hardening (#104-#110, #115, #117). The `feat/marginfi-sim-diagnosis` branch has uncommitted diagnostic work that should resolve separately before starting the next large thread.

This plan covers **everything left** on the Solana roadmap from `okay-lets-make-sure-scalable-cake.md:167-196`, laid out in the recommended execution order. Each section is self-contained enough to hand off into its own PR(s).

### What's shipped

- v0 + ALT foundation (A, #99)
- Jupiter swap (B, #99)
- MarginFi lending + `prepare_marginfi_init` PDA path (C, #100)
- Portfolio integration for MarginFi (D, #100)
- Pre-sign simulation gate for MarginFi/Jupiter (#115)

### What's left (this plan)

| Order | Item | Size | PR count (est) |
|---|---|---|---|
| 1 | Nonce-aware dropped-tx polling | Small | 1 |
| 2 | Solana staking reads (Marinade, Jito, native) | Medium | 1-2 |
| 3 | Solana staking writes (Marinade, Jito, native delegation) | Medium | 2-3 |
| 4 | Multi-tx send pipeline | Medium-large | 1-2 |
| 5 | Kamino lending | Large | 3-4 |
| 6 | Drift / Solend lending | Medium each | 2-3 each |

Order rationale: small cleanup first → user-visible read surface → user-visible write surface → pipeline refactor prerequisite → biggest payoff (Kamino) → optional tail.

---

## 1. Nonce-aware dropped-tx polling

### Problem

Memory `project_solana_phase2_live_findings.md` documents: `get_transaction_status` reports `pending` forever for dropped **nonce-protected** txs, because `lastValidBlockHeight` is meaningless for them (nonces don't expire by block height). This affects every send we've shipped: `native_send`, `spl_send`, `nonce_close`, `jupiter_swap`, all four `marginfi_*` actions.

### Why a nonce-based check works

A durable-nonce tx bakes the current nonce value into its `recentBlockhash` field. On broadcast, Agave executes `ix[0] = nonceAdvance` which rotates the nonce. So:

- **On-chain nonce == nonce baked in tx** → tx hasn't landed; could still land → `pending`.
- **On-chain nonce != nonce baked in tx** → the nonce was rotated. Either (a) our tx landed and its signature aged out of the status cache, or (b) another tx against the same nonce account landed first. Case (b) means our tx can never land. Collapse to `dropped` after one last `searchTransactionHistory: true` lookup to cover case (a).

This is authoritative — it's the exact state Agave checks.

### Design

**Extend `getSolanaTransactionStatus` in `src/modules/solana/status.ts`** with optional `durableNonce?: { noncePubkey: string; nonceValue: string }`. When `getSignatureStatuses` returns null:

```
1. If durableNonce supplied:
     current = getNonceAccountValue(conn, noncePubkey)
     if current is null OR current.nonce !== durableNonce.nonceValue:
       re-query getSignatureStatuses with searchTransactionHistory: true
         — if now found, return success/failed from that entry
       else return { status: "dropped", nonceAccount, bakedNonce, currentNonce }
     else return { status: "pending" }
2. Else if lastValidBlockHeight supplied (existing legacy branch — unchanged)
3. Else return { status: "pending" }
```

Extend `SolanaTransactionStatus` with diagnostic fields: `nonceAccount?`, `bakedNonce?`, `currentNonce?` (parallel to existing `lastValidBlockHeight` / `currentBlockHeight` at `src/modules/solana/status.ts:33-34`). If the nonce account was closed, set `currentNonce: "closed"`.

**Expose durable-nonce info on `send_transaction` return.** `UnsignedSolanaTx` already carries `nonce?: { account, value }` (`src/signing/solana-tx-store.ts:261`). Change the return in `sendSolanaTransaction` at `src/modules/execution/index.ts:698-704`:

```ts
...(tx.nonce
  ? { durableNonce: { noncePubkey: tx.nonce.account, nonceValue: tx.nonce.value } }
  : {}),
```

Update the `send_transaction` return-type declaration at `src/modules/execution/index.ts:1269-1291`.

**Accept `durableNonce` on `get_transaction_status` input.**
- `src/modules/execution/schemas.ts:449-472` — add `durableNonce: z.object({ noncePubkey: z.string(), nonceValue: z.string() }).optional()` with a description parallel to `lastValidBlockHeight`.
- `src/modules/execution/index.ts:1370-1376` — thread through to `getSolanaTransactionStatus`.

**Update agent-facing tool descriptions in `src/index.ts`.**
- `get_transaction_status` at `:1597` — "For durable-nonce Solana txs (native/SPL sends, MarginFi actions, Jupiter swaps, nonce_close), ALSO pass the `durableNonce` object from `send_transaction`. Without it the poller cannot distinguish 'dropped' (nonce rotated) from 'still pending' and defaults to `pending`."
- Polling guidance at `:784` — mention `durableNonce` alongside `lastValidBlockHeight`.

### Files

| File | Change |
|---|---|
| `src/modules/solana/status.ts` | Add `durableNonce` input + nonce-check branch + diagnostic output fields |
| `src/modules/execution/index.ts` | Emit `durableNonce` from send; thread to status tool |
| `src/modules/execution/schemas.ts` | Add `durableNonce` field to `getTransactionStatusInput` |
| `src/index.ts` | Tool description updates |
| `src/types/index.ts` | Extend `send_transaction` return if typed there |
| `test/solana-status.test.ts` | 4 new cases (pending / dropped / history-hit / closed-nonce) |

### Reused (do not duplicate)

- `getNonceAccountValue()` — `src/modules/solana/nonce.ts:87`
- `getSolanaConnection()` — `src/modules/solana/rpc.ts`

### Verification

- Unit: existing `lastValidBlockHeight` cases stay green; new cases cover pending / dropped / history-hit / closed-nonce.
- Full suite + `npm run build`.
- Live sanity: send a native tx → status returns `pending` → `success`. Then deliberately rotate the nonce with a second send while holding onto the first's signature → status on the first returns `dropped` with `bakedNonce !== currentNonce`.
- Memory update after merge: annotate `project_solana_phase2_live_findings.md` — dropped-detection symptom resolved.

---

## 2. Solana staking reads

### Scope

Parallel to EVM `getLidoStakingPosition` / `getEigenlayerStakingPosition`. Enumerate user's Solana staking positions across:

- **Marinade** — mSOL (LST) balance; convert to SOL via Marinade's on-chain exchange rate.
- **Jito** — jitoSOL (LST) balance; convert to SOL via Jito stake pool state.
- **Native stake accounts** — SPL stake-program accounts delegated to any validator, with activation status (activating / active / deactivating / inactive).

All three are read-only, no write-path changes.

### Surface

- **New module** `src/modules/positions/solana-staking.ts` with:
  - `getMarinadeStakingPosition(conn, wallet): Promise<{ mSolBalance, solEquivalent, exchangeRate, apy? }>`
  - `getJitoStakingPosition(conn, wallet): Promise<{ jitoSolBalance, solEquivalent, exchangeRate }>`
  - `getNativeStakePositions(conn, wallet): Promise<Array<{ stakePubkey, validator, stakeLamports, status, activationEpoch, deactivationEpoch? }>>`
- **One consolidated tool** `get_solana_staking_positions(wallet)` returning all three sections — matches user mental model ("show me my Solana staking"). Separate sub-functions preserved for portfolio integration.
- **Portfolio integration** — extend the Solana branch of `get_portfolio_summary` (`src/modules/portfolio/index.ts:~273`, same site that already integrates MarginFi) to fold the SOL-equivalent subtotals into net worth, flagging stake account lockup (inactive lamports ≠ withdrawable lamports).

### Dependencies

- Marinade state: fetch the Marinade state account directly via RPC + known layout, OR use `@marinade.finance/marinade-ts-sdk`. Scope-probe first per `feedback_verify_sdk_before_planning.md` — the SDK pulls `@solana/web3.js` v1; should be compatible.
- Jito: `@jito-foundation/stake-pool-sdk` or the generic `@solana/spl-stake-pool` SDK against Jito's stake-pool address. Same probe.
- Native stakes: enumerated via `getParsedProgramAccounts` on `StakeProgram.programId` filtered by the user's stake authority. Pure web3.js — no new dep.

### Files

| File | Change |
|---|---|
| `src/modules/positions/solana-staking.ts` (new) | Three position readers |
| `src/modules/portfolio/index.ts` | Fold staking subtotals into Solana branch |
| `src/modules/execution/index.ts` | `get_solana_staking_positions` tool handler |
| `src/modules/execution/schemas.ts` | Input schema |
| `src/index.ts` | Tool registration + description |
| `test/solana-staking-positions.test.ts` (new) | Mock RPC + assert shape per protocol |

### Verification

- Mock RPC at `Connection` boundary (same pattern as `test/solana-marginfi.test.ts`).
- Live sanity: a wallet with known mSOL + jitoSOL + one native stake account; cross-check against a public explorer.

---

## 3. Solana staking writes

### Scope

Same verb surface as MarginFi actions, one prepare tool per action per protocol:

- `prepare_marinade_stake(wallet, solAmount)` — deposit SOL, receive mSOL.
- `prepare_marinade_unstake(wallet, mSolAmount, mode)` — delayed (queue for next epoch) vs immediate (via liquidity pool, with fee).
- `prepare_jito_stake(wallet, solAmount)` — deposit SOL, receive jitoSOL.
- `prepare_jito_unstake(wallet, jitoSolAmount)` — deactivate the pool's stake; note SPL stake-pool unstakes produce a **stake account**, not SOL back to the wallet, so the user has an active/deactivating stake position after this. UX copy needs to be explicit about this.
- `prepare_native_stake_delegate(wallet, validator, solAmount)` — create a stake account + delegate.
- `prepare_native_stake_deactivate(stakeAccount)` — start deactivation (takes 1 epoch ≈ 2-3 days).
- `prepare_native_stake_withdraw(stakeAccount, amount)` — withdraw from an inactive stake account.

All use the existing durable-nonce pipeline — add `nonceAdvance` as `ix[0]`, then stack action ixs. Same `PreparedSolanaTx` shape.

### Preflight checks (per CLAUDE.md "Crypto/DeFi Transaction Preflight Checks")

- **Pool paused flags** on Marinade / Jito stake pools.
- **Min stake amount** (pools reject below minimum).
- **Native unstake: epoch status** — refuse `withdraw` on still-activating/deactivating accounts.
- **Sufficient SOL** for stake + rent.

### Pre-sign simulation gate

Extend the existing `simulatePinnedSolanaTx` gate at `src/modules/execution/index.ts:579-640` to cover the new actions. No infrastructure change — the gate already fires for everything except `nonce_init`.

### Render verification

Update `src/signing/render-verification.ts` to add program-ID labels for Marinade, Jito, and the native stake program — agent can name them in CHECK 1. Native stake-program clear-signs on Ledger (it's in the Ledger app's allowlist for `Delegate` / `Deactivate` / `Withdraw`); Marinade and Jito blind-sign (program-IDs not in allowlist) — same treatment as Jupiter/MarginFi.

### Files

| File | Change |
|---|---|
| `src/modules/solana/marinade.ts` (new) | Action builders + SDK wrapper |
| `src/modules/solana/jito.ts` (new) | Action builders + SDK wrapper |
| `src/modules/solana/native-stake.ts` (new) | Action builders using web3.js `StakeProgram` |
| `src/modules/execution/index.ts` | 7 new tool handlers |
| `src/modules/execution/schemas.ts` | 7 input schemas |
| `src/types/index.ts` | Action variants `marinade_stake`, `marinade_unstake`, `jito_stake`, `jito_unstake`, `native_stake_delegate`, `native_stake_deactivate`, `native_stake_withdraw` |
| `src/signing/render-verification.ts` | Program-ID labels + action labels |
| `src/index.ts` | 7 tool registrations |
| `test/solana-marinade.test.ts`, `test/solana-jito.test.ts`, `test/solana-native-stake.test.ts` (new) | Mock SDK + assert ix lists + preflight failures |

### Reused (do not duplicate)

- `buildAdvanceNonceIx()` — `src/modules/solana/nonce.ts:117`
- `issueSolanaDraftHandle()` — `src/signing/solana-tx-store.ts:96`
- Pre-sign gate — `src/modules/execution/index.ts:579`

### Verification

- Per-protocol unit tests mocking SDK output.
- Live devnet dry-run per protocol (small amounts).
- Regression: full suite green.

### Non-goals

- **Jito tips / MEV rewards** — only principal stake flow.
- **Validator comparison tool** — separate future plan.
- **Lockup creation on native stakes** — not exposed by our tools; all stakes created are immediately deactivatable.

---

## 4. Multi-tx send pipeline

### Problem

Current draft store (`src/signing/solana-tx-store.ts`) holds a single tx per handle. Some operations legitimately produce a **sequence**:

- Kamino's `buildXxxTxns` can return setup + main + cleanup txs.
- EVM approve + supply chaining currently requires the agent to babysit two separate handles per `feedback_no_simulate_after_approval.md`.

This item is a prerequisite for Kamino (section 5) and a UX cleanup for EVM approve-chains.

### Design sketch

Extend the draft store to hold an **ordered sequence** of pinned txs per handle. Introduce:

- `PreparedSolanaTxSequence = { chain: "solana", txs: UnsignedSolanaTx[], ... }`.
- `preview_solana_send(handle)` pins the entire sequence — all txs get Ledger hashes the user sees at once.
- `send_transaction(handle)` signs + broadcasts them sequentially, stopping on first failure. Returns an array of signatures + per-tx status.
- **Between-tx state refresh** — after tx N confirms, tx N+1's `recentBlockhash` / nonce value is refreshed before signing (tx N may have rotated the nonce).

### Open design questions (flag before starting)

- **Confirmation depth between txs.** `processed` vs `confirmed` tradeoff: `processed` is fast (~0.4s) but can fork; `confirmed` is safer (~2s). Default to `confirmed` for safety, surface as an option later if we need speed.
- **Failure recovery.** If tx 2 of 3 fails, the user may need a different tx 2 (retry with new state) while tx 1 stands. The pipeline should let them resume from tx 2 with a fresh handle rather than re-running tx 1.
- **Ledger UX for sequences.** 3 Ledger approvals back-to-back with no user context between them is risky. Mitigation: surface every tx's Ledger hash in the initial preview block — user reviews all three before any signs, then approves each in turn without surprise.
- **Timeout / abort.** User can abort mid-sequence; partial-sequence state must be cleaned up (handle retires) without leaving orphan resources.

### Scope of this item

Build the **primitive**, not the callers:
- Extended store + sequence handle + signing loop.
- `preview_solana_send` / `send_transaction` branching on single-tx vs sequence handle.
- Full tests on a synthetic two-tx sequence (create nonce + immediately close = good test fixture with real on-chain effect).

Kamino adoption (section 5) and EVM approve-chaining cleanup are consumers — tracked as follow-ups.

### Files

- `src/signing/solana-tx-store.ts` — sequence variant of the draft type + pin-all logic.
- `src/modules/execution/index.ts` — multi-tx `send_transaction` branch.
- New test file `test/solana-tx-sequence.test.ts`.

---

## 5. Kamino lending

### Why it's hard (from `okay-lets-make-sure-scalable-cake.md:173-180`)

- `@kamino-finance/klend-sdk@^7` uses `@solana/kit` as its primary type system; our codebase is uniformly `@solana/web3.js` v1. SDK bundles `@solana/compat` but that's an integration layer, not a line of code.
- **Obligation accounts**: per-user state that must exist before any borrow/withdraw. First-time users need `initUserMetadata` (similar to MarginFi's `prepare_marginfi_init` but split into a separate ceremony by Kamino).
- **Scope oracle refresh**: every borrow/withdraw must be preceded by Scope refresh ixs.
- **Elevation groups**: SOL-LST group, stablecoin group — affects LTV; wrong choice can fail.
- **V1 vs V2 ix toggle** (`useV2Ixs`).
- **Multi-tx returns** — `buildXxxTxns` is plural by design; needs the sequence pipeline from section 4.

### Shape (post-prerequisites)

After section 4 ships:

1. **Type-bridge utility** `src/modules/solana/kit-bridge.ts` — `@solana/kit` ⇄ `@solana/web3.js` v1 conversion (ix list, `Address` ↔ `PublicKey`, signer abstraction). Isolated so the rest of the codebase stays on web3.js v1.
2. **Scope refresh helper** — takes an obligation + target mints, emits Scope refresh ixs to prepend.
3. **Obligation lifecycle helper** — detect "no obligation yet", auto-init as prefix on first deposit, OR separate `prepare_kamino_init_obligation` tool (pick via plan-mode Q&A with user at that time; MarginFi precedent is a separate tool).
4. **Four `prepare_kamino_*` tools** (supply / withdraw / borrow / repay) + `get_kamino_positions`.
5. **Portfolio integration** — fold Kamino into `get_portfolio_summary` Solana branch.

### Dep

- `@kamino-finance/klend-sdk@^7` — scope-probe at planning time per `feedback_verify_sdk_before_planning.md`.

### Files (rough)

- `src/modules/solana/kit-bridge.ts` (new)
- `src/modules/solana/kamino.ts` (new)
- `src/modules/positions/kamino.ts` (new)
- 5 new tool handlers + 5 input schemas + 5 action variants
- Portfolio integration + render-verification labels
- Full test coverage per protocol

### Verification

- Mainnet devnet dry-run on small amounts for each of supply / withdraw / borrow / repay.
- `get_kamino_positions` reflects on-chain state.

---

## 6. Drift / Solend lending

Additive once MarginFi shape is proven. Same pattern:

- `prepare_drift_supply / withdraw / borrow / repay` + `get_drift_positions`.
- `prepare_solend_supply / withdraw / borrow / repay` + `get_solend_positions`.
- Both fold into `get_portfolio_summary` Solana branch.

Scope-probe SDKs first. These are deferred until Kamino proves the shape — treat as separate plans when approached.

---

## Suggested execution order + gate points

1. **Resolve `feat/marginfi-sim-diagnosis`** (separate — ship, abandon, or fold).
2. **Nonce-aware dropped-tx polling** (section 1) — small, closes a known UX gap for everything already shipped. 1 PR.
3. **Solana staking reads** (section 2) — user-visible surface, no write risk. 1-2 PRs.
4. **Solana staking writes** (section 3) — extends write surface, uses existing pipeline. 2-3 PRs, one per protocol.
5. **Multi-tx send pipeline** (section 4) — prerequisite for Kamino; also benefits EVM. 1-2 PRs.
6. **Kamino lending** (section 5) — largest Solana lending TVL. 3-4 PRs.
7. **Drift / Solend** (section 6) — optional tail, separate plans.

**Gates between items:**
- After (3): decide whether multi-tx pipeline is worth building for Kamino now or deferred (maybe the EVM approve-chaining win alone justifies it).
- After (5): full-suite live regression across all Solana flows before Drift/Solend.

## Files touched across the whole plan

- Core infra: `src/signing/solana-tx-store.ts`, `src/signing/render-verification.ts`, `src/modules/solana/status.ts`, `src/modules/solana/rpc.ts` (likely untouched).
- New modules: `src/modules/solana/{marinade,jito,native-stake,kit-bridge,kamino,drift,solend}.ts`, `src/modules/positions/{solana-staking,kamino,drift,solend}.ts`.
- Execution layer: `src/modules/execution/{index.ts,schemas.ts}` — ~20 new tool handlers over the full arc.
- Types: new action variants for each new prepare tool.
- Tool registration: `src/index.ts` — ~20 new tools.
- Portfolio: `src/modules/portfolio/index.ts` Solana branch gets three new position integrations (staking, Kamino, Drift/Solend).
- Tests: one new test file per protocol + `test/solana-status.test.ts` extension + `test/solana-tx-sequence.test.ts`.

## Verification plan (whole arc)

- Per-item: unit tests mocking SDK/RPC at boundary (pattern from `test/solana-marginfi.test.ts`).
- Per-item: full suite green + `npm run build` clean.
- Per-item: live devnet/mainnet dry-run with small amounts.
- Cross-item: after each protocol adds a position reader, `get_portfolio_summary` regression check with a test wallet holding MarginFi + the new protocol.
- Memory updates after the nonce item ships: annotate `project_solana_phase2_live_findings.md` as resolved.

## Non-goals (whole arc)

- Jupiter perp / limit-order modes.
- MarginFi liquid restaking / emode.
- Jito tips/MEV rewards.
- Native stake lockup creation.
- Multi-authority nonce schemes.
- Token-2022 extensions (confidential transfers, transfer hooks).
- Automated keepers / scheduling for staking rewards or rebalancing.
