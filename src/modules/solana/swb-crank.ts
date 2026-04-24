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
//   [0]                           num_signatures  (u8, call it N)
//   [1 + 11·k ..= 2 + 11·k]       signature_offset            (u16 LE)  k in [0..N)
//   [3 + 11·k]                    signature_instruction_index (u8)      ← position-ABSOLUTE
//   [4 + 11·k ..= 5 + 11·k]       eth_address_offset          (u16 LE)
//   [6 + 11·k]                    eth_address_instruction_index (u8)    ← position-ABSOLUTE
//   [7 + 11·k ..= 8 + 11·k]       message_data_offset         (u16 LE)
//   [9 + 11·k ..= 10 + 11·k]      message_data_size           (u16 LE)
//   [11 + 11·k]                   message_instruction_index   (u8)      ← position-ABSOLUTE
//   [1 + 11·N ..]                 N × (signature || recoveryId || ethAddress) blocks
//   [trailing]                    common message bytes (shared across all N sigs)
//
// The subtle bit:
//   The three `_instruction_index` fields (three per signature) are ABSOLUTE
//   tx-relative indices, NOT self-relative. `0` does NOT mean "this instruction"
//   — it means literally ix[0] of the outer tx. SDKs that build these ixs
//   (Switchboard `PullFeed.fetchUpdateManyIx`, Wormhole's guardian verifier)
//   hardcode all three to `0` because they expect to own the whole tx and sit
//   at position 0 themselves.
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
//   Rewrite the three instruction-index bytes in every offset block to the
//   ix's final tx-relative position before including it. For k in [0..N):
//   bytes (3 + 11·k), (6 + 11·k), (11 + 11·k).
//   `patchSecp256k1CrankIxPosition` below does exactly that.
//
// Provenance:
//   Issue #116 ask C (single-sig implementation, 2026-04-24) and issue #120
//   (multi-sig — the NUM_SIGNATURES=3 default tunes for 5–15s Ledger review
//   windows, and the patch loop handles N offset blocks). Live-probed against
//   Switchboard's Crossbar gateway + Agave mainnet 2026-04-24 via
//   `@switchboard-xyz/on-demand`'s `PullFeed.fetchUpdateManyIx`.
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
 * Number of Switchboard oracle samples to request per crank.
 *
 * Why not 1 (MarginFi's `createUpdateFeedIx` hardcodes that): each sample
 * has a `max_staleness` window measured in slots, and the on-chain SWB
 * program rejects any sample older than that at the slot the tx lands at.
 * With 1 sample, a Ledger blind-sign review of 5–15s (12–40 slots at
 * ~400ms) can age the sample past `max_staleness` and yield
 * `NotEnoughSamples` (Anchor 6030 / 0x178e) even though the crank
 * simulated fine at preview time — issue #120.
 *
 * Three samples give ~3× the staleness headroom with minimal tx-size
 * cost (each extra sample adds 96 bytes to the secp256k1 ix: 11 offset
 * bytes + 85 signature/eth-address bytes). Single-oracle crank at N=3
 * is ~650 bytes, leaving ~580 bytes inside the 1232-byte wire ceiling
 * for the MarginFi borrow ixs.
 *
 * Matches Switchboard's own default for `fetchUpdateManyIx` when
 * `numSignatures` is omitted (`minSampleSize + 33%`, typically 2–3).
 */
const NUM_SIGNATURES = 3;

/**
 * Switchboard uses this sentinel oracle pubkey to mark an "empty" slot
 * in a bank's 5-slot oracle-key array (most banks only use slot 0).
 * MarginFi's own `createUpdateFeedIx` filters this same address; we
 * iterate the raw config so mirror the filter.
 */
const SWB_EMPTY_SLOT_SENTINEL = new PublicKey(
  "DMhGWtLAKE5d56WdyHQxqeFncwUeqMEnuC2RvvZfbuur",
);

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
 * Size of one Secp256k1 offset block. See the file-header reference for the
 * exact layout. There are N of these starting at byte 1 (after the u8
 * num_signatures count).
 */
const SIGNATURE_OFFSETS_SERIALIZED_SIZE = 11;

/**
 * Rewrite a Secp256k1 verify ix's `_instruction_index` fields (three per
 * signature) so they point to the ix's actual position in the final tx.
 * Required whenever the crank isn't the first instruction (which is always,
 * in our flow — see the file-header reference block for why and what breaks
 * if you skip this).
 *
 * Handles N signatures: Switchboard requests `numSignatures` oracle samples
 * per crank (default 3, issue #120 NUM_SIGNATURES) and packs them into a
 * single Secp256k1 ix. For each signature k in [0..N), the three
 * `instruction_index` bytes sit at absolute positions (3 + 11·k,
 * 6 + 11·k, 11 + 11·k) — one `num_signatures` count byte at offset 0
 * plus k complete 11-byte offset blocks before the k-th block's internal
 * triplet at relative positions 2/5/10.
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
  const numSigs = ix.data.readUInt8(0);
  if (numSigs === 0) {
    throw new Error(
      `patchSecp256k1CrankIxPosition: num_signatures=0; no offset blocks to patch.`,
    );
  }
  // Sanity-check the buffer carries the declared number of offset blocks.
  // A short buffer means the SDK emitted malformed data OR a new format —
  // better to fail loudly than to write past the intended offsets.
  const requiredLen = 1 + numSigs * SIGNATURE_OFFSETS_SERIALIZED_SIZE;
  if (ix.data.length < requiredLen) {
    throw new Error(
      `patchSecp256k1CrankIxPosition: ix.data too short for declared ` +
        `num_signatures=${numSigs} (need ≥${requiredLen} bytes, got ${ix.data.length}).`,
    );
  }
  const patched = Buffer.from(ix.data);
  for (let k = 0; k < numSigs; k++) {
    const blockStart = 1 + k * SIGNATURE_OFFSETS_SERIALIZED_SIZE;
    patched.writeUInt8(position, blockStart + 2); // signature_instruction_index
    patched.writeUInt8(position, blockStart + 5); // eth_address_instruction_index
    patched.writeUInt8(position, blockStart + 10); // message_instruction_index
  }
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
    if (oracleKey.equals(SWB_EMPTY_SLOT_SENTINEL)) continue;
    const b58 = oracleKey.toBase58();
    if (swbOracleBase58.includes(b58)) continue; // dedupe shared feeds
    swbOracles.push(oracleKey);
    swbOracleBase58.push(b58);
  }
  if (swbOracles.length === 0) return EMPTY;

  // Dynamic import so the Switchboard + CrossbarClient footprint stays off
  // the cold-start path for wallets that never touch a SwitchboardPull bank.
  //
  // Call `PullFeed.fetchUpdateManyIx` DIRECTLY rather than going through
  // MarginFi's `createUpdateFeedIx` wrapper — that wrapper hardcodes
  // `numSignatures: 1`, which is exactly the root cause of issue #120's
  // `NotEnoughSamples` race. The setup mirrors what the wrapper does
  // internally: load the Switchboard program, wrap each oracle key in a
  // PullFeed, get a CrossbarClient + gateway URL. Just with our own
  // tuned sample count.
  const { AnchorProvider } = await import("@coral-xyz/anchor");
  const { PullFeed, AnchorUtils } = await import(
    "@switchboard-xyz/on-demand"
  );
  const { CrossbarClient } = await import("@switchboard-xyz/common");

  // Stub wallet — `fetchUpdateManyIx` only reads `provider.publicKey` as
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
          "fetchUpdateManyIx should only read publicKey; signing happens later via Ledger.",
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

  const swbProgram = await AnchorUtils.loadProgramFromConnection(
    provider.connection,
  );
  const pullFeeds = swbOracles.map(
    (pubkey) => new PullFeed(swbProgram, pubkey),
  );
  const crossbarClient = CrossbarClient.default();
  const gateway = await pullFeeds[0]!.fetchGatewayUrl(crossbarClient);

  const [instructions, luts] = await PullFeed.fetchUpdateManyIx(swbProgram, {
    feeds: pullFeeds,
    gateway,
    numSignatures: NUM_SIGNATURES,
    payer,
    crossbarClient,
  });
  return { instructions, luts, oracles: swbOracleBase58 };
}
