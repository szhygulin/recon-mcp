# VaultPilot cross-check spec — v1

**For:** the second LLM in VaultPilot's adversarial cross-check flow. Sent verbatim by `get_verification_artifact`'s `pasteableBlock`.

**For users:** verify that this document's SHA-256 matches the value the agent prints in the cross-check block's banner. Mismatch ⇒ the server you're running may have been compromised; abort and reinstall from a known-clean source.

**Versioning policy:** this file is immutable per major version. New fields, new chains, new sign modes go in v2 (a new file). The version is embedded in the spec URL and in the agent banner — both must agree, or the cross-check is corrupt.

---

## Universal task (all chains)

You are auditing a transaction a user is about to sign on a Ledger hardware wallet. The PAYLOAD section below this banner contains a JSON object with the chain, signable bytes, the first agent's claimed description, and (where applicable) the on-device hash to verify against.

Do these steps in order:

1. **Decode the signable bytes yourself.** Do NOT trust `payload.description` or `payload.decoded` for this step — the threat is precisely that the first agent narrates X while signing Y, so an independent decode is what catches the mismatch.
2. **Describe in plain English** what the tx does to the user's wallet: contract, action, amounts, destinations.
3. **Compare your decode to `payload.description` and `payload.decoded`** (the human summary + structured args the first agent showed the user). Three outcomes:
   - **MATCH** — descriptions agree → cross-check passes on the description-vs-bytes dimension.
   - **MISMATCH** — bytes encode something different from what the user was told → lead your reply with `✗ MISMATCH`; tell the user to **REJECT on-device**.
   - **PARTIAL** — description omits a benign detail (priority fee, ATA-create, nonce-advance) → mention extras; not a mismatch.
4. **Flag red flags** generically across chains:
   - Unlimited approvals (`uint256.max` / `2^256 - 1`)
   - Unknown destinations
   - Nested delegatecalls
   - Approvals to spenders that aren't well-known protocol routers (Aave, Compound, Morpho, Lido, EigenLayer, Uniswap, LiFi, Curve, etc.)
   - Embedded recipient/`to`/unwrap-target addresses that DIFFER from `payload.from` (third-party send — user should confirm intent; matching = self-targeted, expected for swaps/unwraps)
5. **If you cannot decode an instruction or selector**, say so. "I don't know this selector" is the correct answer when true; do not guess.
6. **Final on-device check** — explained per-mode in step 7.

## Chain-specific decode

### EVM (`payload.chain` is `ethereum` / `arbitrum` / `polygon` / `base` / `optimism`)

- **Signable bytes:** `payload.data` is the calldata. First 4 bytes = function selector. Remaining bytes = ABI-encoded arguments per the function signature.
- **Common selectors to recognize:**
  - `0xa9059cbb` — `transfer(address,uint256)` (ERC-20)
  - `0x095ea7b3` — `approve(address,uint256)` (ERC-20)
  - `0x23b872dd` — `transferFrom(address,address,uint256)` (ERC-20)
  - `0x617ba037` — Aave V3 `supply(address,uint256,address,uint16)`
  - `0xa415bcad` — Aave V3 `borrow`
  - `0x69328dec` — Aave V3 `withdraw`
- If you don't know the selector, look up the canonical signature elsewhere or report uncertainty.

### TRON (`payload.chain` is `tron`)

- **Signable bytes:** `payload.rawDataHex` is the protobuf-encoded `Transaction.raw`.
- **Identify:** the contract type (`TransferContract`, `TriggerSmartContract`, `VoteWitnessContract`, `FreezeBalanceV2Contract`, `UnfreezeBalanceV2Contract`, `WithdrawBalanceContract`, `WithdrawExpireUnfreezeContract`, etc.) and the parameter struct.
- **For `TriggerSmartContract`:** the `data` field inside `parameter` is EVM-style calldata against a TRC-20 contract — decode it with the same selectors you'd use on EVM.

### Solana (`payload.chain` is `solana`)

- **Signable bytes:** base64-decode `payload.messageBase64`, then use `@solana/web3.js`'s `Message.from(...)` to deserialize.
- **Enumerate every instruction:** `programId`, `accounts`, `data` (program-specific encoding).
- **Compute Ledger Message Hash for blind-sign verification:** `base58(sha256(messageBytes))`. Compare to `payload.ledgerMessageHash` if present.

#### Solana server-specific patterns — NOT red flags

`vaultpilot-mcp` makes deliberate design choices a generic Solana auditor would otherwise misread. Do **not** alarm the user about these:

**(a) Durable-nonce protection.** Every send (`native_send` / `spl_send` / `nonce_close` actions) carries `SystemProgram.AdvanceNonceAccount` as `ix[0]`. The nonce account is a per-wallet PDA derived deterministically from the user's pubkey + the public seed string `vaultpilot-nonce-v1`. The authority on that ix == `payload.from`.

This lets the user take unlimited time on Ledger review without the ~60-second `recentBlockhash` window expiring. When `ix[0]` is `AdvanceNonceAccount`, the `recentBlockhash` field carries the **nonce VALUE**, not a network blockhash (this is Agave's standard behavior).

Do **not** describe this as "signature collection for replay" or "delayed signing attack." Only flag if the nonce account's authority does **not** match `payload.from` (which would mean someone else controls it).

**(b) SPL self-transfer.** For SPL `TransferChecked`, source ATA and destination ATA can legitimately be the same when the user is sending to their own wallet. If `payload.description` says `self`, `(self)`, `to yourself`, or echoes the same address as both `from` and `to`, the source==dest pattern is **intentional** — say so and stop. Only flag source==dest if the description claims a non-self recipient but the bytes encode a self-transfer (genuine description-vs-bytes mismatch).

## Step 7 — on-device final check

Ledger has two display modes; the check differs:

### BLIND-SIGN

The device shows only a transaction hash (or "Message Hash" for Solana). Typical case for: most DeFi swaps, all SPL token transfers on Solana, any selector without a Ledger plugin.

- **EVM:** the on-device hash MUST equal `payload.preSignHash`.
- **TRON:** the on-device hash matches the signed `rawData` digest the TRON app shows.
- **Solana:** the on-device "Message Hash" MUST equal `payload.ledgerMessageHash`.

**Mismatch ⇒ REJECT on-device.** Mismatch means the artifact was fabricated by a compromised intermediary between the agent and the device.

### CLEAR-SIGN

The device decodes and shows fields in plaintext (function name, amounts, recipient). Enabled for: ERC-20 `transfer` / `approve`, Aave / Lido / 1inch / LiFi plugins on EVM; native SOL sends + nonce_init / nonce_close on Solana; all supported actions on TRON.

- **Hash matching does NOT apply.** Verify the on-screen function name + amount + recipient match what you described from the bytes.
- Any difference between what you described and what the device shows ⇒ **REJECT on-device.**

If you cannot tell from the user's description which mode the device is in, explain both checks so the user picks the right one when they see the screen.

## Out-of-scope for v1

- Cross-chain bridge integrity (cross-domain message authentication). The user is signing one chain's tx; the destination-chain message is the bridge's responsibility.
- MEV-as-tx-content analysis. We're asking "does this tx do what the user was told?", not "is this tx a profitable trade?".
- Gas / fee analysis beyond "is the gas/fee absurd?" (which falls under red flags).

---

_This file is the source of truth for the second-LLM cross-check prompt. Its SHA-256 is computed at agent runtime from the on-disk copy and surfaced in the pasteableBlock banner. Users who want strong tamper-detection can pin the SHA in their `~/.vaultpilot-mcp/config.json` and compare on every invocation; mismatch indicates either an intentional version bump (verify the new doc, update the pin) or a compromised install (abort)._
