## Crypto/DeFi Transaction Preflight Checks
- Before preparing any on-chain tx, verify: native gas/bandwidth (TRX bandwidth on TRON), lending pause flags (`isWithdrawPaused` / `isSupplyPaused`), min borrow/supply thresholds, ERC-20 approval status.
- Never use `uint256.max` for collateral withdrawal — fetch the exact balance.
- Multi-step (approve + action): wait for the approval to confirm before sending the dependent tx.

## Git/PR Workflow
- PR-based always. Never push to `main` or to the wrong branch.
- Confirm with the user before force-pushing or rebasing a pushed branch. `--force-with-lease` only on feature branches; never plain `--force`, never on `main`.
- **One worktree per feature/fix** under `.claude/worktrees/<branch-name>`. Never edit in the main worktree at `/home/szhygulin/dev/recon-mcp` — parallel agents race the index, working tree, and `node_modules`. Recipe: `cd /home/szhygulin/dev/recon-mcp && git fetch origin main && git worktree add .claude/worktrees/<short-name> -b <branch-name> origin/main`. Exceptions: `claude-work/` (gitignored) and `~/.claude/projects/.../memory/` (per-user) are editable from anywhere.
- **`cd /home/szhygulin/dev/recon-mcp` BEFORE every `git worktree add`** — the recipe path is relative. From a previous worktree, the new one silently nests at `<prior>/.claude/worktrees/<new>` and every `git status` / build / push afterwards runs against a confused tree. Run `pwd` after the cd if uncertain. Past incidents 2026-04-28: SunSwap → readme-roadmap, pnl-mtd → claude-md-close-keyword.
- **Sync to `origin/main` before starting any work** (`git fetch origin main && git rebase origin/main`). Stale main causes spurious conflicts and risks overlap with another agent's in-flight change. New worktrees from the recipe start at fresh main — still run it; consistency beats remembering when it matters. Re-rebasing a pushed/PR-open branch needs user confirmation.
- **Branch every new PR off `origin/main` — never stack PRs**, even when two in-flight PRs touch shared registration files (`src/index.ts` imports + `registerTool`, `src/modules/execution/index.ts` exports, `src/modules/execution/schemas.ts` zod inputs). Second-to-merge resolves at PR time: rebase after the prior lands, fix conflicts, `--force-with-lease`. Stacking creates fragile queues — base squash-merges orphan downstream; out-of-order merges break the chain.
- **Don't watch CI unless asked.** After push: report the PR as a Markdown hyperlink (`[#553](url)` or `[PR title](url)` — never the raw URL) + one-line summary, then stop. Same rule applies any time a fresh PR / issue / release is created: link it via `[label](url)`, not bare `https://…`. If asked to watch: `gh pr checks <PR>` or `gh run watch <id> --exit-status`. Most runs 1–3 min; release workflows (npm + MCP Registry) 90s–2min. Past ~5 min over typical → assume stuck runner: `gh run rerun <id> --failed` or push an empty commit for a fresh `synchronize`.
- **PR body must use `Closes #N` paired directly with the issue number.** GitHub's parser only fires when the keyword (`Closes` / `Fixes` / `Resolves`) is bound to `#N`. Works: `Closes #432.`; `Closes part of #439 — the gap`. Doesn't: `Closes the smoke-test gap` (keyword bound to prose); `feat(x): add Y (#447)` in title (parenthetical, not close keyword). Lead the PR body with `Closes #N` on its own line. PR #525 merged but #447 stayed open due to bare prose `#447` references.

## Tool Usage Discipline
- Don't repeat the same informational tool call within a single turn — cache mentally.
- Ambiguous / empty result: verify once with a different method; don't loop without user consent.
- **Before issuing a similar-shaped query, check earlier tool outputs for the answer.** The cache-mentally bullet above is for exact repetition; this is for "different query shape, same underlying answer." Past incident 2026-05-01: confirmed "no LiFi route via 1inch for stETH→ETH" across paraswap / 0x / odos / kyberswap / uniswap probes when the first `get_swap_quote` already exposed it — the 1inch number was a side-channel benchmark, not a LiFi-buildable route.

## SDK Scope-Probing Discipline
- **Scope-probe new third-party SDKs BEFORE committing the plan.** Invoke `rnd`. 15-30 min: `npm view <pkg>` for runtime deps + last-published; install into `/tmp/<pkg>-probe/`, read `dist/*.d.ts`; check transit graph for `*-contracts`, hardhat, ethersproject v5, parallel core libs; confirm the API exposes UNSIGNED tx output (Ledger-compatible), not internally-signing helpers.
- Document the verdict in the plan: SDK / version / red flags / decision (adopt / cherry-pick / skip).
- Cost of skipping: PR #334 adopted `@uniswap/v3-sdk`; shallow d.ts inspection missed the `swap-router-contracts → hardhat → solc/sentry/undici/mocha` transit graph that Snyk caught at PR-CI. ~2h refactor to drop the SDK and port the math to native bigint with fixture-locked bit-exactness.
- Reward: Phase 2/3 (Curve + Balancer) planning rejected `@curvefi/api` (ethers-coupled signing) and `@balancer-labs/sdk` V2 (ethersproject-bound, stale), accepted `@balancer/sdk` V3 (viem-native + V2 helpers). 1 SDK adopted instead of 3.

## Security Incident Response Tone
- Diagnose malware/compromise with evidence-based scoping before recommending destructive actions (wipe, nuke, rotate-all). Never delete evidence files before reading them.

## Chat Output Formatting
- Markdown hyperlinks over raw URLs everywhere: `[label](url)`. Long URLs (swiss-knife decoders, Etherscan tx, tenderly/phalcon simulations) wrap the terminal into unreadable walls when raw. Apply in user replies AND in any text the server tells the agent to render. Raw URLs OK only when short and scannable (bare domains) or required for machine-readable JSON paste-blocks.

## Push-Back Discipline
- **Push back BEFORE acting if the request is built on a faulty premise that won't achieve the user's stated goal.** Mid-response caveats ("won't actually fix the thing you asked for") prove the wrong action got taken.
- Tells: re-running a workflow on a tag that predates the fix; re-broadcasting a tx with a confirmed nonce; wrapping a destructive action with "won't really do what you want, but doing it anyway".
- Format: one sentence on the mismatch + 2-3 alternatives + a question. Short — unblock the decision, don't lecture.
- If the user says "do it anyway", proceed.
- Past incident 2026-04-27: user asked to retrigger release-binaries.yml on the v0.9.4 tag for a missing macos-arm64 upload; tag predated #346 / #349 / #361 (size + retry fixes). Right move was flag the frozen-tag problem and recommend cutting v0.9.5.

## System-Rejection Reframing
- **When a tool, server, or library rejects valid-looking input, "fix the rejection logic" is a real option — not just "route around it."** Push-Back Discipline questions a faulty user premise; this rule questions a faulty system premise. Both can be wrong.
- Tells: the rejection logic lives in this repo (own the code); the rejected case is a legitimate usage the gate didn't anticipate (hard refusals where a soft advisory would do); workarounds are clunky enough that the user typically asks for the fix anyway.
- Format: when blocked by system behavior, present BOTH paths — "(a) workaround: <alternatives>" AND "(b) fix the gate: <one-line change>". Let the user choose. Don't silently default to (a) — that costs the user a turn to redirect when they wanted (b).
- Past incident 2026-05-01: `prepare_curve_swap (steth_to_eth)` blocked by the MCP approve-spender allowlist (a hard refusal that should have been a security recommendation per [#617](https://github.com/szhygulin/vaultpilot-mcp/issues/617) / [#618](https://github.com/szhygulin/vaultpilot-mcp/pull/618)). First response offered Lido queue / LiFi-via-kyberswap / 1inch web UI / `request_capability` — never named "soften the allowlist to advisory" as an option. User redirected after one round.

## Issue Analysis
- **When asked to work on an issue, read the comments too — not just the body — and fold relevant content into the analysis.** Comments are where reviewers add follow-up scope, push back on the original framing, or specify defense layers the body left implicit. Skipping them ships a half-answer to the wrong question. `gh api repos/<owner>/<repo>/issues/<N>/comments` returns the thread.
- Past incident 2026-04-29: implemented #556 (burn-address approval refusal) from the body alone. The user's follow-up comment ("agent should route this through the approve tool, not prepare_custom_call") was the second defense layer the issue actually required — caught only after the user pointed it out, costing a round-trip.

## Cross-Repo Scope Splits
- **When an issue's solution splits between MCP code and skill rendering / agent-flow guidance, file the skill half as a tracked issue in [`vaultpilot-security-skill`](https://github.com/szhygulin/vaultpilot-security-skill) before merging the MCP PR — and link both ways.** "Skill-side, out of scope" buried in a PR-description bullet drops the work. A real issue with the proposed rules + explicit scope statement keeps it visible and lets the skill repo pull it in on its next release.
- **Run the cross-repo sweep at PR-write time, not when the user asks.** Before opening the MCP PR, walk: (a) does this change a behavior the skill cross-checks? (b) does it add/remove a tool the skill's `Scope` section enumerates? (c) does it change MCP-emitted block shapes the skill expects verbatim? (d) does it add a defense layer worth mirroring as skill-side ground truth (Inv #6 / Inv #1.a / Inv #11 patterns)? Yes to any → file the skill issue NOW. Past incident 2026-05-01: PR [#618](https://github.com/szhygulin/vaultpilot-mcp/pull/618) softened the MCP approve-allowlist; the skill-side companion (mirrored spender allowlist + ⚠ NON-CANONICAL SPENDER advisory) was foreseeable from the diff but filed at [vaultpilot-security-skill#26](https://github.com/szhygulin/vaultpilot-security-skill/issues/26) only after the user asked.
- Tells the split is happening: the issue's suggested fix names a tool the MCP doesn't expose (`list_contacts(label=…)` re-derivation before a non-recipient-parameter tool); the proposed defense is "agent should call X first" (skill rules bind cooperating agents); the proposed defense is "emit a CHECKS PERFORMED block listing …" (skill renders the block, not the MCP).
- Format for the skill issue: link the MCP issue + PR; one-paragraph context on what MCP-side shipped; the proposed rules in numbered sections; explicit scope label "cooperating-agent guidance only — rogue agent ignores any rule" (per Rogue-Agent-Only Finding Triage).
- Past application 2026-04-29: vaultpilot-mcp#557 (share_strategy / import_strategy bypass preflight Step 0). MCP-side ship: strict-shape gate ([PR #571](https://github.com/szhygulin/vaultpilot-mcp/pull/571)). Skill-side filed at [vaultpilot-security-skill#23](https://github.com/szhygulin/vaultpilot-security-skill/issues/23) — list_contacts re-derive, CHECKS PERFORMED, schema-relay refusal as defense in depth.

## Post-PR Lessons-Learned Discipline
- **After opening a PR, proactively propose any meta-skill lessons from the work to the user — don't wait to be asked.** Distinguish meta-skills (process habits — "treat system rejections as possibly fixable", "re-check earlier outputs before re-querying", "run the cross-repo sweep at PR-write time") from project facts (codebase-specific knowledge that belongs in memory, not CLAUDE.md). Surface only meta-skills.
- Format: 2-3 candidate rules ranked by strength + a one-line recommendation per rule. Cite the past-incident from the just-finished work as the dated example. The user accepts, rejects, or asks for variants.
- **If accepted, bundle the CLAUDE.md edit into the SAME PR as the work that triggered it** — not a follow-up chore PR. The lesson lands with the example that motivated it; cleaner than chaining a separate PR + cross-link.
- Skip when: routine bug fix / dependency bump / docs typo where no genuinely new pattern emerged. Apply when: a non-trivial design decision was made, a system blocker was encountered, a cross-repo consequence surfaced, or the user pushed back on the agent's framing.
- Past application 2026-05-01: PR [#618](https://github.com/szhygulin/vaultpilot-mcp/pull/618) (allowlist advisory) → user prompted the analysis post-merge → three lessons proposed → accepted → filed as chore PR [#620](https://github.com/szhygulin/vaultpilot-mcp/pull/620). This rule itself was added to #620 mid-PR per user ask, codifying both the proactive timing and the bundle-in-same-PR requirement so future runs don't repeat the chore-PR-after-the-fact pattern.

## Smallest-Solution Discipline
- **Push back with the smallest solution that solves the stated problem.** Minimum change first; escalate only if it demonstrably doesn't cover the requirement. Issue/plan text is a problem description, not a license to build infrastructure.
- Tells the proposal is too big: persistence layer for a one-shot operation; new module when an inline call-site change would do; background worker/scheduler for an action that fires once per request; generalizing for hypothetical future callers; "while I'm here" refactors bundled into a fix PR.
- Format: smallest fix + what the larger proposal adds + which scope to pursue. If the issue/plan author specified the heavy approach, surface the lighter one explicitly — don't silently downscope either.
- If the user says the larger scope is intended, proceed.

## Install-State-Aware Recommendations
- **Before recommending a command that depends on how a tool is installed (npm-global vs local clone vs pipx vs system-package vs MCP-server registration), verify the actual install state first.** This is the `rnd` skill's "name the source before you name the fact" applied to recommendations: the source of truth is the user's actual installed state, not a plausible guess about how they installed it. One cheap read (`which <bin>`, `claude mcp get <name>`, `cat <config>`, `ls <expected dir>`) costs less than a command that silently switches the user off their dev build, points at the wrong binary, or installs a duplicate alongside the real one. Generalizes: any recommendation whose correctness depends on user-side state — shell, package manager, version, scope, env — verifies that state before naming the command.
- Tells you're about to recommend without verifying:
  - `npx -y <pkg>` for a tool the user runs from `node /path/to/dist/index.js`.
  - `pip install` when the user has it under pipx / conda / system-package.
  - `brew` on Linux, `apt` on macOS, or any pkg-manager that doesn't match the platform.
  - `claude mcp add <name>` without `claude mcp get <name>` first to capture existing scope, command, args, env.
  - `~/.bashrc` edits when the user runs zsh (or vice versa).
- Format: lead with one observation line ("`claude mcp get` shows scope=local, launches via `node /path/dist/index.js`, no env vars set"), then the command tailored to that state. The observation line lets the user catch mismatches you missed.
- Past incident 2026-04-29: drafted `claude mcp add vaultpilot-mcp --env SAFE_API_KEY=<key> -- npx -y vaultpilot-mcp` for a `SAFE_API_KEY` setup, assuming the published npm package. User actually runs a local dev clone at `/home/szhygulin/dev/recon-mcp/dist/index.js`. The recommended command would have switched their MCP off the dev build onto npm-latest, silently dropping unmerged local work. Caught only because the user asked for the exact command, forcing me to read `claude mcp get` first. Right move: read first, recommend second.

## Typed-Data Signing Discipline
- **No typed-data signing tool ships without paired Inv #1b (typed-data tree decode) + Inv #2b (digest recompute) in the same release.** Tools: `prepare_eip2612_permit`, `prepare_permit2_*`, `prepare_cowswap_order`, `sign_typed_data_v4`, any `eth_signTypedData_v4` exposure. Tracked at [#453](https://github.com/szhygulin/vaultpilot-mcp/issues/453).
- Why: hash-recompute alone passes tautologically over a tampered tree — a rogue MCP swaps `spender` inside `Permit{owner, spender, value, nonce, deadline}` and the digest still matches because it's computed over the swap. Worst blast radius in EVM signing: ONE permit signature → perpetual transfer authority for `deadline`'s lifetime (Permit2 batch with 5-year USDT expiration, smoke-test 126, irrevocable once signed).
- Hard precondition: Ledger must clear-sign the typed-data type. If it blind-signs the digest, the agent has no on-device intent verification — the tool MUST refuse (user can't tell `Permit{spender: TRUST_ROUTER}` from `Permit{spender: ATTACKER}` on screen).
- Inv #1b: decode `domain` / `types` / `primaryType` / `message` locally; surface every address-typed field (`spender`, `to`, `receiver`, `verifyingContract`) in CHECKS PERFORMED with bold + inline-code; surface `deadline` / `validTo` / `expiration` with delta-from-now and flag if > 90 days; pin `verifyingContract` against a curated map (Permit2 = `0x000000000022D473030F116dDEE9F6B43aC78BA3`, USDC permit, CowSwap settlement) and refuse on mismatch; apply Inv #11 unlimited / long-lived rules per entry when `primaryType` ∈ `{Permit, PermitSingle, PermitBatch, Order}`.
- Inv #2b: independently recompute `keccak256("\x19\x01" || domainSeparator || hashStruct(message))` from the decoded tree, match against MCP-reported digest.
- Apply at PR-review and design time — push back on plans that bundle "ship the tool, add invariants later." Today's defense is gap-by-design (no typed-data tools); the moment that gap closes without #1b + #2b, every existing skill defense is silently bypassed.

## Rogue-Agent-Only Finding Triage
- **When the threat is "rogue agent generates harmful advisory text" or "rogue agent fabricates/suppresses MCP results" with no signing flow, close as architectural — don't ship MCP/skill mitigations pretending to fix it.** The skill is text in the agent's context; a hostile agent reads any rule and ignores it. Real defenses live at model-safety-tuning (Anthropic) or chat-client output-filter (Claude Code / Cursor / Desktop) — neither in scope here.
- Tells: output is purely advisory text (no `prepare_*` / `preview_send` / `send_transaction`); agent fabricates a security UI (fake `CHECKS PERFORMED` with `{✓}` verdicts); agent suppresses or falsifies MCP results; proposed fix is "add a rule to SKILL.md" with no other layer.
- **Don't confuse with rogue-MCP + cooperating-agent (Role B).** Skill rules genuinely bind a cooperating agent; read-only response-spoofing, fabricated `compare_yields` rows are real targets for skill-side guidance.
- **Don't confuse with device-layer architectural** (e.g. Ledger blind-sign) — different escalation path (vendor, not model/UI safety).
- Closing template: brief comment naming the architectural gap, citing #536 (canonical) + vaultpilot-mcp-smoke-test#21 (Role A scope-reframing methodology), one-line recap of why skill rules don't help.
- Cooperating-agent guidance with an explicit honest scope label IS acceptable (skill v0.7.0 / vaultpilot-security-skill PR #20). The rule above forbids dressing it up as a defense against the rogue case it isn't actually defending — security theater. Scope label "guides cooperating agents; does NOT defend against a rogue agent that ignores it" must be in the rule body, not just the PR description.

## Security Documentation Vocabulary
- **In user-facing docs (PR descriptions, SECURITY.md, README threat-model sections, issue-close comments), use established security-engineering vocabulary** — not informal "honest threat model" / "honest scope label". Professional readers parse "honest" as a credibility claim, not a technical property.
- Substitutions:
  - "Honest about what we can't defend" → **"residual risk"** / a **"Limitations"** section.
  - "Honest scope label" → **"explicit scope statement"** / **"explicit assumptions"** with in-scope vs. out-of-scope named.
  - "Honest threat model" → **"comprehensive"** (covers attack surface), **"rigorous"** (STRIDE/PASTA/attack trees), or **"documented"**.
  - "When the agent / MCP is honest" → **"cooperating agent"** / **"honest-MCP threat model"** (contrast with compromised). Umbrella: **compromise model** — what each component does when attacker-controlled.
- Cheatsheet: **trust boundary**, **defense in depth**, **fail-safe defaults** (uncertainty defaults to denial), **attack surface**, **threat actor** / **adversary model**, **tamper-evident** / **-resistant** / **-proof** (Ledger is tamper-resistant; skill-pin SHA gives tamper-evidence), **cryptographic integrity** (`payloadFingerprint`, skill-pin SHA, BIP-143 sighashes — name it).
- Scope: user-facing docs only. Internal plans, memory, chat replies, commit messages can stay informal.
- No churn PRs to bulk find-and-replace existing usages — migrate opportunistically.

## Documentation Style — concise, non-redundant, sharp
- **In user-facing docs (READMEs, AGENTS.md, INSTALL, prose sections of SECURITY.md, ROADMAP, AND CLAUDE.md itself), state each idea once, in its most natural place.** Long docs accumulate redundancy as features land incrementally — taglines, callouts, intro paragraphs, and feature bullets all end up restating the same pitch because each was written in isolation.
- Tells: same fact in 3+ places; intro region with tagline + callout + multi-paragraph "what this is" (pick one); tool descriptions explaining what the name implies; bullet lists duplicating prose immediately above; "Limitations" sections re-covering body ground.
- Apply at write time:
  - Lead with the strongest sentence. Don't ramp up.
  - One fact, one home — link from secondary locations instead of duplicating.
  - Cut adjectives that don't change meaning ("comprehensive" / "robust" / "powerful" / "seamless").
  - Tool/feature descriptions: state what's NON-obvious from the name; otherwise just list the name.
  - **Stay high-level. Don't over-explain.** Prefer one sharp sentence over an explanatory paragraph; one canonical example over four; a brief reference over a transcript. Readers can ask follow-ups; they cannot un-read filler. Factual accuracy is non-negotiable — high-level is fine, vague-bordering-on-wrong is not. If you're tempted to add a third example "for clarity," the first two were probably enough.
- Apply at edit time:
  - Read top-to-bottom; flag every sentence you've read before. Keep the best location, delete the rest, link if navigation value is lost.
  - Opportunistic dedup is fine while editing for another reason. Standalone churn PRs aren't.
- Scope: user-facing docs and PR descriptions. Internal plans, memory, code comments, chat replies can stay verbose.
- Past incident 2026-04-28: README grew to 258 lines with the intro restated four times, Solana durable-nonce in three sections, WC-Tron/Solana fact in two. Rewrite cut to 227 without losing technical content. CLAUDE.md rewritten same day from 110 to 103 by trimming filler — dense rule content compresses less than feature/marketing prose.
- **Don't re-explain synonyms.** Once a term is named clearly, don't paraphrase it in the next sentence "for clarity" — readers parse repetition as either condescension or signal that the first phrasing was wrong. Pick the strongest term, use it, move on.

## Reference framework: fastmcp
- When writing MCP server code, consult [punkpeye/fastmcp](https://github.com/punkpeye/fastmcp) for ergonomic patterns. **Don't take the dependency** — its transitive surface (`hono`, `undici`, `execa`, `file-type`, `fuse.js`, `mcp-proxy`) re-inflates the slim binary, and its value sits in HTTP/SSE/OAuth/edge layers irrelevant to a stdio server. Stay on `@modelcontextprotocol/sdk` directly.
- **Apply now: MCP tool annotations on every `registerTool` call (currently zero coverage in `src/index.ts`).** The wrapper passes `opts` through to `server.registerTool`, which accepts `{ title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }`. `annotations` carries `{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` and the SDK forwards them to the host (Claude Code / Desktop) for UI warnings and caching. Defaults by family:
  - `get_*` / `list_*` / `preview_*` / `explain_*` / `check_*` / `resolve_*` / `verify_*` / `simulate_*` / `read_*` → `readOnly + openWorld`.
  - `prepare_*` → `destructive + idempotent` (returns unsigned tx; re-prepare just rebuilds a draft).
  - `send_transaction` → `destructive + openWorld`, NOT idempotent (nonce-bound; rebroadcasting a confirmed tx reverts).
  - `pair_ledger_*` / `set_*_api_key` / `add_contact` / `register_btc_multisig_wallet` / `import_*` → `idempotent`, local config only (`openWorldHint: false`).
  - `request_capability` → `openWorld`, NOT idempotent (creates a GitHub issue).
  - `combine_*` / `finalize_*` / `sign_*` / `submit_*` (PSBT/signature plumbing) → `destructive + idempotent`, NOT openWorld (local artifact ops; broadcast happens elsewhere). Exception: `finalize_btc_psbt` with `broadcast=true` is effectively `send_transaction`-class — annotate the safer default branch and document the broadcast path in `description`.
  - `revoke_*` / `remove_*` / `unregister_*` → `destructive + idempotent`, local-only (re-delete is a no-op).
  - `rescan_*` → `readOnly + openWorld` (cache write is a memoization detail; observable behavior = fetch from indexer).
  - `share_*` → read family (`readOnly + openWorld`); the snapshot is an anonymized read+transform of on-chain state, no mutation.
  - Per-tool overrides:
    - `prepare_solana_nonce_init` / `prepare_solana_nonce_close` → NOT idempotent (consume a one-shot account slot; re-running fails).
    - `exit_demo_mode` → read family but local-only (`readOnly + idempotent + NOT openWorld`); produces a guide, no chain read, no state change.
    - `generate_readonly_link` → `destructive + NOT idempotent + NOT openWorld` (mints a fresh token per call and writes its sha256 to the issuer-side store; no chain interaction).
  - Always set `annotations.title` for a human-readable label distinct from the snake_case name.
- **Don't replace the `registerTool` wrapper with fastmcp's `server.addTool` builder.** The wrapper carries demo-mode dispatch (whale-persona auto-select for `prepare_*`, broadcast-tool simulation envelope, always-/conditionally-gated refusal branches) and conditional scope-loading via `isToolEnabled` — fastmcp's API has no slot for either.
- **Defer until a real "feels stuck" report justifies it:** progress notifications (`_meta.progressToken` + `notifications/progress` via the handler `extra` arg) for fanout tools, and `UserError`-style typed user-vs-programmer error split.
