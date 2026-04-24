# VaultPilot MCP — Security Model

This document describes VaultPilot's trust boundaries, the defenses that catch
attacks across them, and — equally important — the attacks that are *not*
covered. The goal is an honest map of what you're trusting when you let an AI
agent prepare transactions against your Ledger device.

For the product overview, install instructions, and tool reference, see the
main [README](./README.md).

## Why trust VaultPilot?

VaultPilot assumes the AI agent can be compromised, the MCP server can be
compromised, and your host computer can be compromised. Only your Ledger
hardware is trusted. Every transaction is cryptographically bound across
every layer so that tampering at any point — a swapped recipient, a
rewritten swap route, a smuggled approval — produces a visible mismatch
on your Ledger screen, giving you the chance to reject before anything
is signed.

In practice: the agent relays a hash it computed locally, the MCP relays
the bytes it intends to broadcast, and the Ledger re-derives its own hash
from the bytes it actually receives. You compare the two on the device's
own screen — the one display in the pipeline that no software on the host
can forge. No layer in between can fake a match it doesn't have.

## Trust boundaries

The signing pipeline crosses several independent trust boundaries, each of
which can be compromised in isolation:

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

The Ledger device is the only component whose display the user sees directly
(not filtered through the agent) and which cannot be software-compromised at
the host level. Everything else can fail. VaultPilot's defenses are layered so
that **most single-layer compromises are caught, single-layer compromises are
caught by at least one cross-check, and coordinated multi-layer attacks are
either caught or honestly called out as unprotected**.

## Defenses and what each catches

Two of the anti-compromised-MCP checks below — agent-side ABI decode and the
pair-consistency pre-sign hash recomputation — run **automatically at
`preview_send` time** and report their results in a `CHECKS PERFORMED` block
before the user replies "send". The agent is instructed to run them
unprompted; the user does not consent check-by-check. The second-LLM
verification is the one remaining opt-in, because it requires physical user
action (paste into another LLM). The swiss-knife decoder URL stays embedded
in the VERIFY-BEFORE-SIGNING block as a suggested manual fallback when the
agent's built-in ABI knowledge is low-confidence on the target selector.

| Layer | Threat it catches | Honest limits |
|---|---|---|
| **Prepare↔send `payloadFingerprint`** — domain-tagged `keccak256` over `{chainId, to, value, data}`, checked at send time | MCP-internal drift between prepare and send (bug or bytes-swap at send) | Not what Ledger displays. The server never claims this matches the device hash. |
| **Independent 4byte.directory cross-check** — auto-emitted `[CROSS-CHECK SUMMARY]` block on every `prepare_*` | Agent fabricating a "✓ cross-check passed" line; server-side ABI swap vs. the public selector registry | Function-signature only (no arg values). "error" / "not-applicable" states are surfaced verbatim rather than masked. |
| **Agent-side ABI decode** — auto-run at `preview_send` time; the agent decodes `data` from its built-in model-weight ABI knowledge and compares against the server's compact summary; `⚠ DECODE UNAVAILABLE` fallback surfaces the swiss-knife URL embedded in VERIFY-BEFORE-SIGNING for a third-party browser-context decode | MCP-side calldata tampering — if the server rewrote the bytes, the agent's independent decode disagrees with the compact summary | Depends on the agent's ABI coverage for the target selector. Low-confidence decodes hand off to swiss-knife, which is a client-side SPA — the user opens the URL in a browser the agent can't sandbox. |
| **`LEDGER BLIND-SIGN HASH` block** — EIP-1559 pre-sign RLP `keccak256` over `{chainId, nonce, maxFeePerGas, maxPriorityFeePerGas, gas, to, value, data}`, emitted by `preview_send` | Any bytes-tampering between MCP and the device: WC-relay MITM, Ledger Live malware, a USB-channel adversary on TRON. The value is what the device will display in blind-sign mode; the user matches on-device. | Bytes-integrity only — does not prove the bytes match user intent (calldata could still be malicious if MCP itself is compromised). Tapping "Edit gas" in Ledger Live invalidates the match by design; the in-block wording says "you may still approve, but the hash-match guarantee no longer applies." |
| **`PREPARE RECEIPT` block** — verbatim-relay of the raw args the agent passed to `prepare_*` | Narrow agent compromise: prompt injection from other tool output, malicious Claude skill, compromised subagent in a delegation chain — anything that rewrites args without also crafting a matching filter on the agent's output | Defense-in-depth, not a hard boundary. A fully-coordinated compromised agent can drop or mutate the block; "verbatim relay" is a social contract enforced by in-block prose. |
| **Agent-side pair-consistency pre-sign hash recomputation** — auto-run by the agent at `preview_send` time, results reported in the `CHECKS PERFORMED` block; uses `viem.serializeTransaction` + `keccak256` over the server-returned pinned tuple and compares against the server's claimed hash | Compromised MCP that reports a hash inconsistent with the bytes it forwards to WC. `viem` is a separate code trust boundary; the agent's recompute agreeing with the server's hash narrows the MCP-lying gap. | Requires local code execution. For contract calls, depends on the agent first decoding `data` against its built-in ABI knowledge to sanity-check intent — otherwise the hash check tautologically agrees with any tuple. For native sends (`data = "0x"`), the agent knows the full tuple and the check is clean. |
| **`previewToken` + `userDecision` gate on `send_transaction`** — server-minted UUID (bound to the pin, re-minted on `refresh:true`) plus `z.literal("send")`, both required on every EVM send | Accidental preview-step collapse: agent going `preview_send` → `send_transaction` in one silent step, skipping the `CHECKS PERFORMED` report that `preview_send`'s agent-task block instructs it to emit. Missing/mismatched values cause a clear-error refusal naming the missing arg. | Schema-level, not user-physical. A fully-hostile agent can still fabricate `userDecision: "send"` after calling `preview_send` for a real token — the server has no channel to distinguish "user really said send" from "agent claims user said send". Closes careless mistakes, not coordinated lying. |
| **WalletConnect session-topic cross-check** — `get_ledger_status` returns the WC session `topic`; the agent is instructed to surface the last 8 chars and ask the user to confirm a matching session exists in Ledger Live → Settings → Connected Apps before the first `send_transaction` of a session | WC peer impersonation — any peer can self-report `wallet: "Ledger Wallet"` and `peerUrl: "wc.apps.ledger.com"`, so the name/URL pair alone is not a trusted identity. The session topic, in contrast, is unique per pairing and visible at both ends. A mismatch means the MCP paired with a different peer than the user opened in Ledger Live. | Relies on the user actually performing the cross-check (one-time per session). If skipped, the defense degrades back to "trust the peer's self-report." The Ledger device's on-screen confirmation still backstops tx content, just not the WC session identity. |
| **Ledger device display** — `To`, `Value`, hash in blind-sign; decoded fields when a plugin clear-signs (Aave, Lido, 1inch, LiFi, approve) | Any tampering that survived every software layer. The device serializes the bytes it received and hashes locally; the user's eyeball on the device screen is the final check. | Blind-sign shows no calldata decode. Intent-vs-bytes matching on contract calls happens off-device, through agent model-weight decode with swiss-knife fallback. |
| **`vaultpilot-preflight` Claude Code skill** — separately-distributed skill at [`github.com/szhygulin/vaultpilot-skill`](https://github.com/szhygulin/vaultpilot-skill), installed by the user to `~/.claude/skills/vaultpilot-preflight/`. Instructs the agent to locally decode the signable bytes and recompute the expected on-device hash on every send, regardless of whether the MCP's response included its usual `[AGENT TASK — RUN THESE CHECKS NOW]` block. Starting with skill v0.1.1 + matching MCP release (0.5.3), `SKILL.md` carries an in-file integrity sentinel and this MCP pins the expected SHA-256 of the skill file in its server `instructions` — on every signing flow the agent is told to `sha256sum ~/.claude/skills/vaultpilot-preflight/SKILL.md`, compare to the pin, and confirm the sentinel is present in the content the `Skill` tool returned. Halts the flow with an explicit `vaultpilot-preflight skill integrity check FAILED` message on mismatch. | **Compromised MCP omits its own `CHECKS PERFORMED` directives.** Every CHECKS block today is authored by this server and emitted in tool results; a compromised server simply drops them and the agent has no static rule to fall back on. The skill lives on the user's disk, independent of this server's release pipeline — its trust root is the user's own clone of the skill repo. When the MCP detects the skill file is missing, it emits a `VAULTPILOT NOTICE — Preflight skill not installed` block on the first vaultpilot-mcp tool response of the session (read-only or signing, whichever comes first), deduped so the notice fires at most once per session. The block's shape deliberately avoids imperative "AGENT TASK" framing or pasteable shell commands because live testing showed stricter-sandboxed agents classifying that shape as prompt injection and dropping it; the current VAULTPILOT NOTICE prefix is documented as a legitimate server pattern in the top of the server-level `instructions` field. The integrity pin additionally catches (a) targeted tamper of `SKILL.md` on disk (attacker can't change content without changing SHA) and (b) plugin-collision where a different skill is registered under the same name (colliding content lacks the sentinel). | Still agent-prose enforcement — a coordinated compromise where the agent decides to ignore the skill's invariants is not caught here (the on-device Ledger hash match and `get_verification_artifact` second-LLM flow remain the backstops). The "skill not installed" warning is itself server-authored, so it is a UX nudge for honest-MCP cases, not a security boundary. The integrity pin anchors trust in THIS MCP's npm package — if the installed `vaultpilot-mcp` itself is compromised, it would ship the attacker's pin (same trust floor as the rest of the server, not a new gap). A mechanical `PreToolUse` hook that does the hash recompute as host-side code is on the roadmap to close the "agent chooses to skip the skill" residual. |

## Coverage by chain

The table above is chain-agnostic. Not every defense applies to every chain — WC session-topic is EVM-only; `previewToken` + `userDecision` gates only the EVM preview-send step; TRON uses USB-HID transport and the Ledger TRON app clear-signs every supported action, so some EVM-specific machinery has no equivalent on TRON and is deliberately absent. The matrix below resolves per-chain presence, with `—` plus a footnote reason when a defense is intentionally not present on a chain.

| Threat | EVM | Solana | TRON |
|---|---|---|---|
| **Narrow prompt injection / malicious skill / compromised subagent** | `PREPARE RECEIPT` at prepare time + agent-side ABI decode (CHECK 1) at preview time + Ledger clear-sign (native / ERC-20 transfer / ERC-20 approve / Aave / Lido / 1inch / LiFi) or blind-sign hash for other contracts | `PREPARE RECEIPT` at prepare time + agent-side instruction decode (CHECK 1) at `preview_solana_send` time + Ledger blind-sign Message Hash (SPL / MarginFi / Jupiter) or clear-sign (native SOL / nonce_init / nonce_close) | `PREPARE RECEIPT` at prepare time + Ledger TRON app clear-signs every supported action on-device (TransferContract, canonical TRC-20 TransferChecked, VoteWitness, FreezeBalanceV2, UnfreezeBalanceV2, WithdrawExpireUnfreeze, WithdrawBalance). Hash-match and agent-side calldata decode are moot when every supported action clear-signs — the user verifies decoded fields directly on the device. |
| **Fully-coordinated agent compromise (args AND output filter)** | `—` (no software-only defense; `get_verification_artifact` narrows via second-LLM) | `—` (same; `get_verification_artifact` narrows) | `—` (same; `get_verification_artifact` narrows) |
| **Compromised MCP (lies about hash, swaps bytes at send-time)** | `LEDGER BLIND-SIGN HASH` + agent-side pair-consistency hash recompute (CHECK 2) | `LEDGER MESSAGE HASH` + agent-side pair-consistency hash recompute (CHECK 2) for blind-sign paths (SPL / MarginFi / Jupiter) | `—` for hash-match (device clear-signs — no blind-sign hash channel). Device-shown decoded fields are the source of truth: an MCP that swapped bytes would cause the device screen's decoded values to disagree with the user's intent, which the user rejects on-device. |
| **Compromised middle-layer (WC relay / Ledger Live / USB transport)** | `LEDGER BLIND-SIGN HASH` — device recomputes from received bytes | `LEDGER MESSAGE HASH` — device recomputes from received bytes | Device clear-sign of decoded fields — device parses received bytes itself and shows action + args; any bytes-substitution changes what the user sees on-screen |
| **WalletConnect peer impersonation** | WC session-topic cross-check (user confirms in Ledger Live → Settings → Connected Apps) | `—` (USB HID — no WC session to impersonate) | `—` (USB HID — no WC session to impersonate) |
| **Agent accidentally skips the `CHECKS PERFORMED` report at preview time** | `previewToken` (server-minted at `preview_send`) + `userDecision: "send"` (schema literal) required on `send_transaction` | Implicit via protocol — `preview_solana_send` is what pins the durable-nonce value; skipping it makes `send_transaction` fail at the pin check with a stale-nonce error | `—` — TRON has no preview step. `prepare_tron_*` produces the signable artifact directly; `send_transaction` forwards it. The signable raw-data hash is stable from prepare onwards, so there is no preview window to accidentally collapse |
| **"Edit gas" in Ledger Live** | Hash mismatch expected (user changed a hashed field); in-block wording allows "accept tradeoff without hash-match guarantee" | `—` (USB HID — no Ledger Live edit-gas UI; Solana fees are pinned server-side via compute-unit price at preview time) | `—` (USB HID — no Ledger Live UI at all; TRON bandwidth/energy costs are deterministic and pinned in the rawData at prepare time) |
| **Post-broadcast cross-check** (informational; not a pre-sign defense) | `TRANSACTION BROADCAST` block with Etherscan URL per chain | `TRANSACTION BROADCAST` block with Solscan URL | `TRANSACTION BROADCAST` block with Tronscan URL. Additionally, `renderTronVerificationBlock` appends an explicit `AFTER BROADCAST (not a pre-sign check)` sub-header carrying the same Tronscan link, flagged as post-broadcast so the user does not conflate it with the preventive checks above it |

### Intentional absences (TRON)

TRON's surface is deliberately narrower than EVM's or Solana's because the Ledger TRON app clear-signs every supported action and the transport is direct USB HID (not WalletConnect). The following machinery has no TRON equivalent and will not be added; each is a design decision, not an oversight.

- **No agent-task `CHECKS PERFORMED` block.** Every supported TRON action clear-signs on-device — the user sees action type + decoded args on the Ledger screen directly. Adding server-authored hash-match or calldata-decode directives would train users to compare against values the device never shows, reinforcing rubber-stamp habits rather than preventing them.
- **No `LEDGER BLIND-SIGN HASH` block.** Same reason — there is no blind-sign hash channel on TRON because no supported action blind-signs.
- **No WalletConnect session-topic cross-check.** TRON signing goes over direct USB HID via `@ledgerhq/hw-app-trx`; there is no WC session to impersonate.
- **No `previewToken` + `userDecision` preview-step gate.** TRON has no preview step — `prepare_tron_*` produces the signable artifact in one call; `send_transaction` forwards it directly. The gate exists on EVM to catch accidental preview-step collapse, which is structurally impossible here.

## Threat → what catches it

- **Prompt injection / malicious skill / compromised subagent (narrow):** `PREPARE RECEIPT` surfaces the args that hit MCP, bypassing the agent's natural-language retelling. For native sends, the Ledger device's `To` / `Value` display backstops even if the receipt is dropped. For contract calls (swaps, supplies, approvals) the calldata remains unverifiable on-device in blind-sign — the agent's auto-run ABI decode at `preview_send` is the next line of defense, with the swiss-knife URL as a manual fallback when the agent's ABI knowledge is low-confidence.
- **Fully-corrupted agent that coordinates on BOTH arg manipulation AND output filtering:** No protection. The user's entire view flows through the agent; there is no non-agent display channel for calldata in blind-sign mode. Conceded honestly — this threat is only reachable with a non-agent display channel (a hardware wallet with full clear-signing for the target calldata), which we do not have yet for most contract calls.
- **Compromised MCP (lies about hash, swaps bytes at send-time):** `LEDGER BLIND-SIGN HASH` catches bytes-tampering between MCP and device — the device recomputes from received bytes, and the user matches the agent-relayed value against the device-displayed one. The agent's auto-run pair-consistency hash recompute (reported in `CHECKS PERFORMED`) gives an honest agent a first-line check before the device is involved.
- **Compromised Ledger Live or WalletConnect relay (middle-layer MITM):** `LEDGER BLIND-SIGN HASH` — the device is the source of truth; any substitution between MCP and the device produces a divergent on-device hash.
- **WalletConnect peer impersonation (adversary pairs with the MCP while the user believes they paired Ledger Live):** WC session-topic cross-check — the user verifies in Ledger Live → Settings → Connected Apps that a session exists whose topic matches the one the MCP holds. The peer's self-reported name/URL alone is not a trusted identity (any peer can claim "Ledger Wallet @ wc.apps.ledger.com").
- **Agent accidentally skips the `CHECKS PERFORMED` report at preview time:** `previewToken` (server-minted at `preview_send`, stashed on the pin) + `userDecision: "send"` (schema literal) on `send_transaction`. Both required on the EVM path; missing/mismatched values cause a clear-error refusal naming the missing arg. A fully-hostile agent can still forge `userDecision` after a legitimate `preview_send`, so this is a careless-mistake backstop, not a coordinated-lying defense.
- **"Edit gas" in Ledger Live:** Hash mismatch is expected (the user changed a hashed field). The in-block wording explicitly allows "accept the tradeoff without the hash-match guarantee" — user owns the choice; not a bug.

## Asymmetry worth naming

For the compromised-MCP case, the honest agent is a real second trust boundary — it knows the user-intent args and can recompute the expected hash. For the compromised-agent case, MCP has no ground truth for user intent; forcing verbatim args relay (`PREPARE RECEIPT`) raises the tampering bar for narrow injections but does not close the gap against a coordinated attacker. Both halves of the asymmetry are enforced in code and covered by `test/integration-security.test.ts`.

There is a second asymmetry worth calling out honestly: **every `CHECKS PERFORMED` and `VERIFY-BEFORE-SIGNING` directive is authored by this server and emitted in tool results**. The agent following them is following instructions that the MCP itself produced. A compromised MCP can silently omit those directives, and an honest agent with no static rule to fall back on will drop the checks. The [`vaultpilot-preflight`](https://github.com/szhygulin/vaultpilot-skill) Claude Code skill is the defense against this self-referential gap — it lives on the user's disk at `~/.claude/skills/vaultpilot-preflight/`, its trust root is the user's own clone of the skill repo, and the MCP cannot reach it to alter or suppress its content. When the MCP detects the skill is not installed, it surfaces a warning block asking the user to install it; that warning is itself server-authored, so a compromised MCP would suppress it — meaning the install step must not be deferred. A `PreToolUse` hook that performs the hash recompute as host-side code (removing the agent-prose dependency entirely) is on the roadmap.

## Verifying the server-side `payloadFingerprint` yourself

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

## Second-agent verification (optional, for the coordinated-agent case)

The table above honestly concedes that a fully-coordinated agent compromise — where the same agent that invokes `prepare_*` with malicious args also filters what the user sees in chat — has no software-only defense, because the user's entire view flows through the agent.

`get_verification_artifact(handle)` narrows that gap. It returns a sparse artifact — `{chain, chainId, from, to, value, data, payloadHash, preSignHash?}` for EVM, analogous TRON shape — deliberately stripped of the server's own humanDecode, swiss-knife URL, and 4byte cross-check. Alongside the structured fields, the artifact carries a `pasteableBlock` string: a single self-contained paste target with explicit `===== COPY FROM THIS LINE =====` / `===== END — STOP COPYING HERE =====` markers, the instructions, and the embedded JSON payload between them. The user copies everything between the markers into a **second, independent LLM session** (ideally a different provider) and lets that agent decode the bytes from scratch with no shared context. If the two agents disagree on what the transaction does, the first agent was lying — abort. The `from` field lets the second agent auto-check in-calldata recipients (unwrapWETH9 target, bridge destination, transfer `to`) against the signer — mismatches get flagged; matches are silently accepted as expected self-targeted operations (swaps, unwraps, withdrawals).

The Ledger device is the fabrication anchor: a compromised first agent can't invent bytes whose `preSignHash` matches the hash the Ledger screen displays at sign time. The canned prompt reminds the user to compare the artifact's `preSignHash` against the device before tapping approve — any mismatch proves the artifact was forged mid-flight, and the tx is rejected on-device anyway.

Limits worth naming:

- Does not catch a supply-chain compromise of the MCP process itself (the bytes the server builds are still the bytes it ships).
- Does not catch a coordinated attack that simultaneously compromises both LLM providers (significantly harder than compromising one).
- Does not replace the normal `VERIFY-BEFORE-SIGNING` block — it is an additional tool for skeptical users on high-value or unfamiliar-contract flows.

## Reporting a vulnerability

If you believe you've found a security issue, please open a GitHub security advisory at <https://github.com/szhygulin/vaultpilot-mcp/security/advisories/new> rather than a public issue. Include a reproduction, the affected version, and your assessment of the impact. I'll aim to acknowledge within a few days.
