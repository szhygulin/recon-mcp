import { createRequire } from "node:module";
import { assertBitcoinAddress, type BitcoinAddressType } from "./address.js";
import { getBitcoinIndexer } from "./indexer.js";
import { selectInputs, type CoinSelectInput } from "./coin-select.js";
import { issueBitcoinHandle } from "../../signing/btc-tx-store.js";
import {
  getPairedBtcByAddress,
  type BtcAddressType as PairedBtcAddressType,
} from "../../signing/btc-usb-signer.js";
import type { UnsignedBitcoinTx } from "../../types/index.js";
import { BTC_DECIMALS, SATS_PER_BTC } from "../../config/btc.js";

/**
 * Bitcoin native-send builder. Mirrors `buildTronNativeSend` /
 * `buildSolanaNativeSend` in shape: takes high-level args, fetches
 * UTXOs + fee estimates from the indexer, runs coin-selection, builds a
 * PSBT v0 via `bitcoinjs-lib`, and returns an `UnsignedBitcoinTx`
 * registered with the in-memory tx-store. The Ledger BTC app consumes
 * the PSBT bytes at signing time via `signPsbtBuffer`.
 *
 * Phase 1 simplification — change goes back to the source address.
 * Proper BIP-32 internal-chain change (`<purpose>'/0'/<account>'/1/<idx>`)
 * is a follow-up; deriving it requires either the account-level xpub
 * (which pairing doesn't currently cache) or an extra device round-trip
 * at prepare time. Sending change back to the source is functionally
 * correct and the Ledger still clear-signs every output — the user
 * recognizes their own address on the device. Trade-off documented in
 * the plan; the on-device review surface is unchanged.
 *
 * RBF — sequence `0xFFFFFFFD` on every input by default (BIP-125
 * replaceable). Pass `rbf: false` to set `0xFFFFFFFE` (final, not
 * replaceable). Locktime stays at 0.
 *
 * The PSBT is v0 (the only format `signPsbtBuffer` accepts). Every
 * input carries BOTH `witnessUtxo` (script + value, used by the segwit
 * sighash) AND `nonWitnessUtxo` (the full prev-tx hex). The latter is
 * mandatory on Ledger BTC app 2.x even for segwit/taproot inputs — the
 * device cryptographically verifies the input amount against the
 * prev-tx because BIP-143 sighash doesn't commit to input amount,
 * which is how a malicious offline signer could otherwise lie about
 * the input value to inflate the fee. Omitting it trips a
 * "Security risk: unverified inputs" device prompt and rejects with
 * 0x6985. Issue #213.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: new (opts?: { network?: unknown }) => {
    addInput(input: {
      hash: string | Buffer;
      index: number;
      sequence?: number;
      witnessUtxo?: { script: Buffer; value: number };
      nonWitnessUtxo?: Buffer;
    }): unknown;
    addOutput(output: { address?: string; script?: Buffer; value: number }): unknown;
    toBase64(): string;
  };
  address: {
    toOutputScript(address: string, network?: unknown): Buffer;
  };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

/**
 * Map BIP-32-purpose-to-our-paired-type. The source address's paired
 * entry tells us which BIP-44 purpose it lives under, which determines
 * the addressFormat passed to `signPsbtBuffer`.
 */
const ADDRESS_FORMAT_BY_TYPE: Record<
  PairedBtcAddressType,
  UnsignedBitcoinTx["addressFormat"]
> = {
  legacy: "legacy",
  "p2sh-segwit": "p2sh",
  segwit: "bech32",
  taproot: "bech32m",
};

/**
 * Bitcoin's `<purpose>'/0'/<account>'` account-level path (without the
 * trailing `change/index` leaf). `signPsbtBuffer` wants this so the
 * Ledger app can re-derive both receive and change leaves under it.
 */
function accountPathFromLeaf(leafPath: string): string {
  const parts = leafPath.split("/");
  if (parts.length < 5) {
    throw new Error(
      `Invalid Bitcoin leaf path "${leafPath}" — expected at least 5 segments ` +
        `(<purpose>'/0'/<account>'/<change>/<index>).`,
    );
  }
  // Drop last 2 segments (change + index) → keep purpose'/coin'/account'.
  return parts.slice(0, -2).join("/");
}

/** Estimate vbytes for a P2WPKH/P2TR tx — same shape coinselect uses. */
function roughVbytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}

/** Format sats as a BTC decimal string (8-decimal padding, trailing-zero strip). */
function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = abs - whole * SATS_PER_BTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

/**
 * Parse a human BTC amount ("0.001") or "max" to sats.
 *   - "max" returns null; the caller resolves it after coin-selection
 *     (because "max" depends on the fee, which depends on input count).
 */
function parseBtcAmountToSats(amount: string): bigint | null {
  if (amount === "max") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid BTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5") or "max" for the full balance minus fees.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(BTC_DECIMALS, "0");
  return BigInt(whole) * SATS_PER_BTC + BigInt(padded);
}

export interface BuildBitcoinNativeSendArgs {
  /** Paired BTC source address. Must be in `UserConfig.pairings.bitcoin`. */
  wallet: string;
  /** Recipient. Any of the four mainnet address types. */
  to: string;
  /** Decimal BTC string ("0.001"), or "max" for full-balance-minus-fee. */
  amount: string;
  /**
   * Fee rate in sat/vB. Optional — when omitted, uses the indexer's
   * `halfHourFee` recommendation (~3-block target). Override for
   * congestion-priority sends or low-fee draining.
   */
  feeRateSatPerVb?: number;
  /**
   * BIP-125 RBF. Default true → sequence `0xFFFFFFFD` (replaceable).
   * Pass false → `0xFFFFFFFE` (final, not replaceable). RBF lets the
   * user fee-bump a stuck tx via a follow-up `prepare_btc_rbf_bump`
   * (PR4+).
   */
  rbf?: boolean;
  /**
   * Override the fee-cap guard. The cap is `max(10 × feeRate × vbytes,
   * 2% of total output value)`; legitimate priority sends through
   * heavy congestion can exceed it. Default false.
   */
  allowHighFee?: boolean;
}

export async function buildBitcoinNativeSend(
  args: BuildBitcoinNativeSendArgs,
): Promise<UnsignedBitcoinTx> {
  // 1. Validate source + destination format.
  assertBitcoinAddress(args.wallet);
  assertBitcoinAddress(args.to);

  // 2. Resolve the paired entry for the source. Without it we don't know
  //    the BIP-44 purpose / address type / leaf path, so we can't tell
  //    Ledger which account is signing.
  const paired = getPairedBtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Bitcoin address ${args.wallet} is not paired. Run \`pair_ledger_btc\` ` +
        `to register the four standard address types (legacy/p2sh-segwit/segwit/taproot) ` +
        `for an account, then pass any of those addresses as \`wallet\`.`,
    );
  }
  // Phase 1 send-side scope: native segwit + taproot only. Legacy /
  // P2SH-wrapped sends require `nonWitnessUtxo` (full prev-tx hex) on
  // every input, which is a separate code path. Reads work for all
  // four types — only sends are restricted.
  if (paired.addressType !== "segwit" && paired.addressType !== "taproot") {
    throw new Error(
      `Bitcoin sends from ${paired.addressType} (${paired.path}) addresses are not ` +
        `supported in Phase 1 — only native segwit (bc1q...) and taproot (bc1p...). ` +
        `Move funds to your paired segwit or taproot address first.`,
    );
  }

  const indexer = getBitcoinIndexer();

  // 3. Resolve fee rate.
  let feeRate: number;
  if (args.feeRateSatPerVb !== undefined) {
    feeRate = args.feeRateSatPerVb;
  } else {
    const fees = await indexer.getFeeEstimates();
    feeRate = fees.halfHourFee;
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error(
      `Resolved fee rate ${feeRate} sat/vB is not positive. Pass an explicit ` +
        `\`feeRateSatPerVb\` or check the indexer URL.`,
    );
  }

  // 4. Fetch UTXOs.
  const utxos = await indexer.getUtxos(args.wallet);
  if (utxos.length === 0) {
    throw new Error(
      `No UTXOs at ${args.wallet} — the wallet has zero spendable balance. ` +
        `Verify with \`get_btc_balance\` and confirm at least one tx has confirmed ` +
        `(unconfirmed mempool UTXOs are eligible for selection but very-young ones ` +
        `may be rejected by the relay).`,
    );
  }

  // 5. Resolve "max" → fee-aware amount, or convert decimal-BTC → sats.
  const csUtxos: CoinSelectInput[] = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
  }));
  let amountSats: bigint;
  if (args.amount === "max") {
    // For max: assume all UTXOs are inputs, single output, no change.
    // coinselect's internal vbyte estimate can differ from ours by 1-2
    // bytes (taproot signatures land slightly under our P2WPKH estimate;
    // segwit signatures match closely). Add a small headroom so the
    // exact-fit branch coinselect picks still leaves room — without it,
    // a 1-byte estimator drift turns a feasible "max" into an
    // INSUFFICIENT-FUNDS error.
    const totalSats = csUtxos.reduce((sum, u) => sum + u.value, 0);
    const vbytes = roughVbytes(csUtxos.length, 1);
    const feeMax = Math.ceil(feeRate * vbytes) + Math.ceil(feeRate * 5);
    if (totalSats <= feeMax) {
      throw new Error(
        `Cannot "max": total balance ${satsToBtcString(BigInt(totalSats))} BTC is at or below ` +
          `the estimated fee ${satsToBtcString(BigInt(feeMax))} BTC at ${feeRate} sat/vB. ` +
          `Lower the feeRate or wait for more confirmations.`,
      );
    }
    amountSats = BigInt(totalSats - feeMax);
  } else {
    const parsed = parseBtcAmountToSats(args.amount);
    if (parsed === null) {
      throw new Error(`Internal error: parseBtcAmountToSats returned null for ${args.amount}`);
    }
    amountSats = parsed;
  }
  if (amountSats <= 0n) {
    throw new Error(
      `Resolved send amount ${amountSats} sats is not positive. Increase the amount.`,
    );
  }

  // 6. Coin-selection. Phase-1 simplification: change goes back to the
  //    source address (see file docstring for the reasoning).
  const selection = selectInputs({
    utxos: csUtxos,
    outputs: [{ address: args.to, value: Number(amountSats) }],
    feeRate,
    changeAddress: args.wallet,
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });

  // 7. Fetch full prev-tx hex for every UNIQUE input txid. Required by
  //    Ledger BTC app 2.x's segwit-fee-inflation defense — see file
  //    docstring + issue #213. Dedup by txid so a multi-vout-from-the-
  //    same-prev-tx selection only fans out once. Parallel fan-out so
  //    the wall-time stays bounded even with many distinct prev txs.
  const uniqueTxids = [...new Set(selection.inputs.map((i) => i.txid))];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);

  // 8. Build PSBT.
  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  const sequence = args.rbf === false ? 0xfffffffe : 0xfffffffd;
  const sourceScript = bitcoinjs.address.toOutputScript(args.wallet, NETWORK);
  for (const input of selection.inputs) {
    const prevTxHex = prevTxHexByTxid.get(input.txid);
    if (!prevTxHex) {
      throw new Error(
        `Internal error: prev-tx hex missing for selected input ${input.txid}:${input.vout} ` +
          `after fan-out fetch.`,
      );
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence,
      // `witnessUtxo` (script + value) feeds the segwit sighash;
      // `nonWitnessUtxo` (full prev-tx) is what Ledger BTC app 2.x
      // uses to cryptographically verify the input amount. Both are
      // required — see file docstring.
      witnessUtxo: { script: sourceScript, value: input.value },
      nonWitnessUtxo: Buffer.from(prevTxHex, "hex"),
    });
  }
  for (const output of selection.outputs) {
    const outScript = bitcoinjs.address.toOutputScript(
      output.address ?? args.wallet,
      NETWORK,
    );
    psbt.addOutput({ script: outScript, value: output.value });
  }
  const psbtBase64 = psbt.toBase64();

  // 9. Decoded-output projection for the verification block. Each
  //    output gets a sats + BTC-decimal string + isChange flag. The
  //    Ledger walks every entry on-screen — this projection is what
  //    `render-verification.ts` mirrors for the user to cross-check.
  const decodedOutputs = selection.outputs.map((o) => ({
    address: o.address ?? args.wallet,
    amountSats: o.value.toString(),
    amountBtc: satsToBtcString(BigInt(o.value)),
    isChange: o.isChange,
  }));

  const accountPath = accountPathFromLeaf(paired.path);
  const vsize = roughVbytes(selection.inputs.length, selection.outputs.length);
  const description = `Send ${satsToBtcString(amountSats)} BTC to ${args.to}`;

  const tx: Omit<UnsignedBitcoinTx, "handle" | "fingerprint"> = {
    chain: "bitcoin",
    action: "native_send",
    from: args.wallet,
    psbtBase64,
    accountPath,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    description,
    decoded: {
      functionName: "bitcoin.native_send",
      args: {
        from: args.wallet,
        to: args.to,
        amount: satsToBtcString(amountSats),
        feeRate: `${feeRate} sat/vB`,
      },
      outputs: decodedOutputs,
      feeSats: selection.fee.toString(),
      feeBtc: satsToBtcString(BigInt(selection.fee)),
      feeRateSatPerVb: feeRate,
      rbfEligible: args.rbf !== false,
    },
    vsize,
  };
  return issueBitcoinHandle(tx);
}

/** Validate a BTC address against the four mainnet types. Re-export for tests. */
export function _isSendableAddressType(
  type: BitcoinAddressType,
): type is "p2wpkh" | "p2tr" {
  return type === "p2wpkh" || type === "p2tr";
}

/**
 * Sign a UTF-8 message with the paired Bitcoin address using the
 * Bitcoin Signed Message format (BIP-137). The Ledger BTC app prompts
 * the user to confirm the message text on-device before producing the
 * signature — same clear-sign UX as send-side flows.
 *
 * Taproot is refused (BIP-322 not yet exposed by Ledger). Legacy /
 * P2SH-wrapped / native segwit all return base64-encoded compact
 * signatures with header bytes that match the address-type convention
 * Sparrow / Electrum / Bitcoin Core's `verifymessage` accept.
 *
 * The returned `format: "BIP-137"` field tells the verifier which scheme
 * to use; useful for cross-wallet verification flows where the verifier
 * needs to know whether to expect BIP-137 or BIP-322.
 */
export interface SignBitcoinMessageArgs {
  wallet: string;
  message: string;
}

export interface SignedBitcoinMessage {
  address: string;
  message: string;
  signature: string;
  format: "BIP-137";
  addressType: PairedBtcAddressType;
}

export async function signBitcoinMessage(
  args: SignBitcoinMessageArgs,
): Promise<SignedBitcoinMessage> {
  assertBitcoinAddress(args.wallet);
  if (typeof args.message !== "string" || args.message.length === 0) {
    throw new Error("`message` must be a non-empty string.");
  }
  if (args.message.length > 10_000) {
    throw new Error(
      `Message length ${args.message.length} exceeds the 10000-char ceiling. Sign-In-` +
        `with-Bitcoin-style flows are typically a few hundred chars; rejecting the long ` +
        `tail because the Ledger BTC app's on-device review surface chunks the message ` +
        `into 16-char windows and a multi-KB string is not realistically reviewable.`,
    );
  }
  const paired = getPairedBtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Bitcoin address ${args.wallet} is not paired. Run \`pair_ledger_btc\` to register ` +
        `the four standard address types and retry with one of the resulting addresses.`,
    );
  }
  const { signBtcMessageOnLedger } = await import(
    "../../signing/btc-usb-signer.js"
  );
  const messageHex = Buffer.from(args.message, "utf-8").toString("hex");
  const result = await signBtcMessageOnLedger({
    expectedFrom: args.wallet,
    path: paired.path,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    messageHex,
    addressType: paired.addressType,
  });
  return {
    address: args.wallet,
    message: args.message,
    signature: result.signature,
    format: result.format,
    addressType: paired.addressType,
  };
}
