import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import type { PairedBitcoinMultisigWallet } from "../../types/index.js";

/**
 * Address derivation for registered multi-sig wallets. Pure crypto —
 * no device touch, no indexer call. Used by PR2's balance/UTXO readers
 * and (when those land) PR3's initiator flow.
 *
 * For a `wsh(sortedmulti(M, @0/**, @1/**, ..., @N/**))` descriptor:
 *   1. Derive each cosigner's compressed pubkey at the (chain, index) leaf
 *      from their stored xpub via `@scure/bip32`.
 *   2. Sort lexicographically (sortedmulti requirement).
 *   3. Build the witnessScript:
 *        OP_M <pubkey1> <pubkey2> ... <pubkeyN> OP_N OP_CHECKMULTISIG
 *   4. Wrap in P2WSH (sha256 of the script + bech32 encoding).
 *
 * Phase 3 PR2 supports `wsh` only. PR4 adds `tr` (taproot script-path).
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  payments: {
    p2wsh(opts: {
      redeem: { output: Buffer };
      network?: unknown;
    }): { output?: Buffer; address?: string };
  };
  script: { compile(chunks: Array<number | Buffer>): Buffer };
  opcodes: Record<string, number>;
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

/** Look up an OP_n opcode (1..16). Throws on out-of-range. */
function opN(n: number): number {
  if (n < 1 || n > 16 || !Number.isInteger(n)) {
    throw new Error(`OP_n out of range: ${n} (must be integer 1..16).`);
  }
  // OP_1 = 0x51, OP_2 = 0x52, ..., OP_16 = 0x60.
  return 0x50 + n;
}

/**
 * Derive one cosigner's compressed (33-byte) pubkey at the given
 * (chain, index) leaf from their stored xpub. Throws on derivation
 * failure (corrupt xpub or xpub not at the expected level).
 */
export function deriveCosignerPubkey(
  xpub: string,
  change: number,
  addressIndex: number,
): Buffer {
  let hd: HDKey;
  try {
    hd = HDKey.fromExtendedKey(xpub);
  } catch (err) {
    throw new Error(
      `Cosigner xpub failed to parse: ${(err as Error).message}. The descriptor ` +
        `may have been corrupted in storage.`,
    );
  }
  const child = hd.derive(`m/${change}/${addressIndex}`);
  if (!child.publicKey) {
    throw new Error(
      `Cosigner xpub derivation produced no pubkey at /${change}/${addressIndex}.`,
    );
  }
  // @scure/bip32's publicKey is already the 33-byte compressed form
  // for non-taproot keys — what bitcoinjs-lib expects.
  return Buffer.from(child.publicKey);
}

export interface MultisigAddressInfo {
  /** The bech32 address (e.g. `bc1q...`). */
  address: string;
  /** scriptPubKey bytes (witness program). */
  scriptPubKey: Buffer;
  /** witnessScript bytes — `OP_M <p1>...<pN> OP_N OP_CHECKMULTISIG`. Used in PSBT inputs. */
  witnessScript: Buffer;
  /** Compressed cosigner pubkeys at this leaf, in slot order (NOT sorted). */
  cosignerPubkeys: Buffer[];
}

/**
 * Derive the multi-sig address at the given (change, addressIndex) leaf
 * for a registered wallet. Pure crypto.
 *
 * Phase 3 PR2 supports `scriptType === "wsh"` only. Adding `tr` is the
 * job of PR4.
 */
export function deriveMultisigAddress(
  wallet: PairedBitcoinMultisigWallet,
  change: 0 | 1,
  addressIndex: number,
): MultisigAddressInfo {
  if (wallet.scriptType !== "wsh") {
    throw new Error(
      `deriveMultisigAddress: scriptType "${wallet.scriptType}" not supported in this ` +
        `module — taproot (\`tr\`) ships in a follow-up PR.`,
    );
  }
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error(
      `addressIndex must be a non-negative integer, got ${addressIndex}.`,
    );
  }
  // 1. Derive each cosigner's pubkey at the leaf.
  const cosignerPubkeys = wallet.cosigners.map((c) =>
    deriveCosignerPubkey(c.xpub, change, addressIndex),
  );
  // 2. sortedmulti = lexicographic sort of pubkeys.
  const sorted = [...cosignerPubkeys].sort(Buffer.compare);
  // 3. Build witnessScript.
  const witnessScript = bitcoinjs.script.compile([
    opN(wallet.threshold),
    ...sorted,
    opN(wallet.totalSigners),
    bitcoinjs.opcodes.OP_CHECKMULTISIG,
  ]);
  // 4. Wrap in P2WSH.
  const p2wsh = bitcoinjs.payments.p2wsh({
    redeem: { output: witnessScript },
    network: NETWORK,
  });
  if (!p2wsh.output || !p2wsh.address) {
    throw new Error(
      `Internal error: bitcoinjs.payments.p2wsh returned undefined output/address ` +
        `for wallet "${wallet.name}" at leaf ${change}/${addressIndex}.`,
    );
  }
  return {
    address: p2wsh.address,
    scriptPubKey: p2wsh.output,
    witnessScript,
    cosignerPubkeys,
  };
}
