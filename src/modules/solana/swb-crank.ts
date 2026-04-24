import {
  PublicKey,
  TransactionInstruction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";

// ─────────────────────────────────────────────────────────────────────────────
// Note for future maintainers — Solana Secp256k1 pre-compile `instruction_index`
//
// If you ever compose an SDK-emitted Secp256k1 verify ix (Switchboard crank,
// Wormhole guardian verify, or anything else that uses this pre-compile) into
// a larger tx, READ THIS FIRST. It cost live-probe iterations to get right,
// and the failure mode is silent Custom errors with no reference to this ix.
//
// What the pre-compile does:
//   Agave's Secp256k1 pre-compile verifies an EVM-style ECDSA signature over
//   a Keccak-256 digest and returns the recovered public key — all inside the
//   runtime, no BPF program. Switchboard uses it to attest that an oracle
//   price came from a specific quorum-signed gateway attestation; Wormhole
//   uses it for guardian-set signatures.
//
// Data layout (per Agave `sdk/secp256k1-program/src/lib.rs`):
//   [0]        num_signatures             (u8)       — patch assumes ==1
//   [1..=2]    signature_offset           (u16 LE)
//   [3]        signature_instruction_index (u8)      ← position-ABSOLUTE
//   [4..=5]    eth_address_offset         (u16 LE)
//   [6]        eth_address_instruction_index (u8)    ← position-ABSOLUTE
//   [7..=8]    message_data_offset        (u16 LE)
//   [9..=10]   message_data_size          (u16 LE)
//   [11]       message_instruction_index  (u8)       ← position-ABSOLUTE
//   [12..]     the actual signature / eth-address / message bytes
//
// The subtle bit:
//   The three `_instruction_index` fields are ABSOLUTE tx-relative indices,
//   NOT self-relative. `0` does NOT mean "this instruction" — it means
//   literally ix[0] of the outer tx. SDKs that build these ixs (Switchboard
//   `PullFeed.fetchUpdateManyIx`, Wormhole's guardian verifier) hardcode all
//   three to `0` because they expect to own the whole tx and sit at position
//   0 themselves.
//
// The 0xff sentinel is NOT valid here:
//   Some Solana pre-compiles interpret 0xff as "same instruction". Secp256k1
//   does not — live-probed against mainnet, 0xff returns Custom:4
//   (InvalidDataOffsets). Only absolute indices work.
//
// What happens when you get this wrong:
//   Splice the ix in at position 2 without rewriting the bytes, and the
//   pre-compile reads signature/eth-address/message data out of ix[0]'s
//   data (e.g. the `nonceAdvance` ix). Result: Custom:2 (InvalidPublicKey),
//   :3 (InvalidRecoveryId), or :4 (InvalidDataOffsets) depending on what
//   random bytes those fields land on. None of the error messages mention
//   offsets.
//
// The fix:
//   Rewrite bytes 3, 6, and 11 to the ix's final tx-relative position before
//   including it. `patchSecp256k1CrankIxPosition` below does exactly that.
//   Single-signature payloads only — multi-sig would need additional writes
//   at +11-byte strides, and we guard against that case.
//
// Provenance:
//   Issue #116 ask C; live-probed against Switchboard's Crossbar gateway
//   2026-04-24 via `createUpdateFeedIx` from @mrgnlabs/marginfi-client-v2
//   v6.4.1. The specific Agave runtime version: mainnet slot 2026-04-24.
// ─────────────────────────────────────────────────────────────────────────────

/** `KeccakSecp256k11111111111111111111111111111` — the pre-compile program. */
const SECP256K1_PROGRAM_ID = new PublicKey(
  "KeccakSecp256k11111111111111111111111111111",
);

/**
 * Build Switchboard Pull oracle crank instructions for the touched banks
 * of a MarginFi risk-engine tx (supply / withdraw / borrow / repay).
 *
 * Why this exists (issue #116 ask C):
 *
 *   MarginFi's risk engine rejects any balance-changing tx whose touched
 *   banks have oracle prices past their `oracleMaxAge`. SwitchboardPull
 *   oracles (the SOL bank, among others) are "always stale" by design —
 *   prices only land on-chain when someone submits a crank ix alongside
 *   the action. The MarginFi UI auto-prepends these cranks; our server
 *   previously didn't, so every borrow against SOL collateral hit
 *   `RiskEngineInitRejected (6009)` until a foreign cranker ran.
 *
 * Ix shape (live-probed 2026-04-24 via @mrgnlabs/marginfi-client-v2
 * v6.4.1's `createUpdateFeedIx`, which delegates to Switchboard
 * On-Demand's `PullFeed.fetchUpdateManyIx` with `numSignatures: 1`):
 *
 *   - ix[0]  Secp256k1 signature pre-compile verifying the oracle
 *            attestation (0 keys, 0 signers, ~129 bytes data)
 *   - ix[1]  Switchboard On-Demand `submit` ix
 *            (12 keys, 1 signer = payer, ~36 bytes data)
 *   - 2 LUTs, ~27 addresses total
 *   - ~463 bytes serialized for a single-oracle crank
 *
 * Ledger-compat: numSignatures=1, the only signer is the payer (user's
 * wallet). No ephemeral keypairs, no separate signers to stash.
 *
 * Dependency footprint: `createUpdateFeedIx` internally calls Switchboard's
 * Crossbar gateway over HTTP (`https://34.97.218.183.sslip.io` by default;
 * overridable via `NEXT_PUBLIC_SWITCHBOARD_CROSSSBAR_API`). This adds
 * ~3–5s of latency per prepare and a new failure mode (gateway unreachable).
 * The caller wraps this function in a try/catch and falls through on
 * failure — a busted crank leaves us no worse than before #115 landed,
 * and the sim gate + #116 diagnosis still explain the resulting revert.
 */

export interface SwbCrankResult {
  /** Switchboard instructions ready to prepend (AFTER nonceAdvance). */
  instructions: TransactionInstruction[];
  /** Address lookup tables the Switchboard ixs reference. Merge with MarginFi's own ALTs. */
  luts: AddressLookupTableAccount[];
  /**
   * Base58 oracle addresses cranked. Empty array means no SwitchboardPull
   * oracle was touched (nothing to crank). Stamped on the draft meta for
   * observability via `marginfiOracleCranks`.
   */
  oracles: string[];
}

/** Empty result when there's nothing to crank. */
const EMPTY: SwbCrankResult = { instructions: [], luts: [], oracles: [] };

/**
 * Minimum bank shape we need: oracle setup + primary oracle key.
 * `oracleSetup` comes back as the enum variant string (e.g. "SwitchboardPull")
 * — matches `OracleSetup.SwitchboardPull` in the SDK.
 */
interface BankLike {
  address: PublicKey;
  oracleKey?: PublicKey;
  config: {
    oracleSetup: unknown;
    oracleKeys?: PublicKey[];
  };
}

/**
 * Client-shaped just enough for this helper to read bank config off
 * `client.banks`. Mirrors the `MinimalClient` elsewhere in the codebase.
 */
interface ClientLike {
  banks: Map<string, BankLike>;
}

/**
 * Rewrite a Secp256k1 verify ix's three `_instruction_index` fields so they
 * point to the ix's actual position in the final tx. Required whenever the
 * crank isn't the first instruction (which is always, in our flow — see the
 * file-header reference block for why and what breaks if you skip this).
 *
 * Returns a NEW `TransactionInstruction` with a patched data buffer; the
 * input is left untouched so callers can still hold references to the
 * SDK-emitted original.
 */
export function patchSecp256k1CrankIxPosition(
  ix: TransactionInstruction,
  position: number,
): TransactionInstruction {
  if (!ix.programId.equals(SECP256K1_PROGRAM_ID)) return ix;
  if (position < 0 || position > 255) {
    throw new Error(
      `patchSecp256k1CrankIxPosition: position ${position} doesn't fit in u8. ` +
        `That would mean more than 255 instructions in the tx — nowhere near reachable.`,
    );
  }
  // Only the single-signature layout is supported (num_signatures === 1).
  // The Switchboard crank emits exactly one signature per feed and
  // `createUpdateFeedIx` batches multi-oracle cranks into a single SWB
  // submit ix, keeping the signature count at 1. Bail loudly if a future
  // SDK release changes that assumption so the silent-bad-offsets failure
  // mode can't regress.
  const numSigs = ix.data.readUInt8(0);
  if (numSigs !== 1) {
    throw new Error(
      `patchSecp256k1CrankIxPosition: expected 1 signature, got ${numSigs}. ` +
        `The pre-compile data layout assumes single-sig; multi-sig needs a different patch loop.`,
    );
  }
  const patched = Buffer.from(ix.data);
  patched.writeUInt8(position, 3);
  patched.writeUInt8(position, 6);
  patched.writeUInt8(position, 11);
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys,
    data: patched,
  });
}

export async function buildSwitchboardCrankIxs(
  conn: Connection,
  payer: PublicKey,
  touchedBanks: string[],
  client: unknown,
): Promise<SwbCrankResult> {
  if (touchedBanks.length === 0) return EMPTY;
  const c = client as ClientLike;

  // Collect the SwitchboardPull oracle keys we'd need to crank.
  // `oracleSetup` serializes as the enum string ("SwitchboardPull") in the
  // hydrated bank. We also guard for the kaminoSwitchboardPull / drift /
  // solend variants — they ride the same Switchboard-Pull underlying feed
  // and fail the same way when stale. (Integrator banks are filtered out
  // earlier by the hardened fetch, but paranoia is cheap here.)
  const swbOracles: PublicKey[] = [];
  const swbOracleBase58: string[] = [];
  for (const bankAddr of touchedBanks) {
    const bank = c.banks.get(bankAddr);
    if (!bank) continue;
    const setup = String(bank.config.oracleSetup);
    if (
      setup !== "SwitchboardPull" &&
      setup !== "KaminoSwitchboardPull" &&
      setup !== "DriftSwitchboardPull" &&
      setup !== "SolendSwitchboardPull"
    ) {
      continue;
    }
    const oracleKey =
      bank.oracleKey ??
      (bank.config.oracleKeys && bank.config.oracleKeys[0]) ??
      undefined;
    if (!oracleKey) continue;
    const b58 = oracleKey.toBase58();
    if (swbOracleBase58.includes(b58)) continue; // dedupe shared feeds
    swbOracles.push(oracleKey);
    swbOracleBase58.push(b58);
  }
  if (swbOracles.length === 0) return EMPTY;

  // Dynamic import so the Anchor + Switchboard + CrossbarClient footprint
  // stays off the cold-start path for wallets that never touch a
  // SwitchboardPull bank.
  const { AnchorProvider } = await import("@coral-xyz/anchor");
  const { createUpdateFeedIx } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );

  // Stub wallet — `createUpdateFeedIx` only reads `provider.publicKey` as
  // the payer; it never calls `signTransaction` / `signAllTransactions`.
  // The fail-throwing stubs double as a tripwire: if the SDK ever starts
  // invoking them in this path, the stale-tx-assembly bug will surface
  // with an explicit message instead of silently producing a tx with a
  // zero signature. Same shape we use in marginfi.ts for the broader
  // client load.
  const stubWallet = {
    publicKey: payer,
    signTransaction: async () => {
      throw new Error(
        "SWB crank stub wallet: unexpected signTransaction call. " +
          "createUpdateFeedIx should only read publicKey; signing happens later via Ledger.",
      );
    },
    signAllTransactions: async () => {
      throw new Error(
        "SWB crank stub wallet: unexpected signAllTransactions call.",
      );
    },
  };
  const provider = new AnchorProvider(conn, stubWallet as never, {
    commitment: "confirmed",
  });

  const { instructions, luts } = await createUpdateFeedIx({
    swbPullOracles: swbOracles,
    provider,
  });
  return { instructions, luts, oracles: swbOracleBase58 };
}
