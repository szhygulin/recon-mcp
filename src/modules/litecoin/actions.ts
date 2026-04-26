import { createRequire } from "node:module";
import { assertLitecoinAddress, type LitecoinAddressType } from "./address.js";
import { getLitecoinIndexer } from "./indexer.js";
import { selectInputs, type CoinSelectInput } from "./coin-select.js";
import { issueLitecoinHandle } from "../../signing/ltc-tx-store.js";
import {
  getPairedLtcByAddress,
  getPairedLtcAddresses,
  type LtcAddressType as PairedLtcAddressType,
} from "../../signing/ltc-usb-signer.js";
import type { UnsignedLitecoinTx } from "../../types/index.js";
import { LTC_DECIMALS, LITOSHIS_PER_LTC } from "../../config/litecoin.js";

/**
 * Litecoin native-send builder. Mirror of `src/modules/btc/actions.ts`.
 * Same PSBT v0 / coin-selection / fee-cap pattern; only network params
 * and chain identifiers differ.
 *
 * bitcoinjs-lib does not ship a Litecoin network preset, so we
 * construct one inline (mainnet only). pubKeyHash 0x30 (L-prefix),
 * scriptHash 0x32 (M-prefix; modern Litecoin P2SH version), bech32
 * HRP `ltc`. The xpub/xprv version bytes match BTC's `0x0488B21E` /
 * `0x0488ADE4` — Litecoin Core uses the standard BIP-32 versions
 * (Ltub/Ltpv exist in some third-party wallets but Core does not
 * emit them).
 *
 * Legacy 3-prefix (0x05) Litecoin P2SH addresses are READ-side only:
 * `assertLitecoinAddress` accepts them, but the SEND path rejects
 * them because bitcoinjs-lib's `address.toOutputScript` validates the
 * version byte against the configured `scriptHash` and we only carry
 * one `scriptHash` per network object. Recipients on 3-prefix P2SH
 * are vanishingly rare on Litecoin (the M-prefix migration completed
 * years ago); when one shows up, we surface a clear error pointing
 * the user to ask the recipient for an M-prefix address.
 *
 * Change derivation mirrors BTC's (issue #254): the change output goes
 * to a BIP-44 internal-chain (`/1/<idx>`) address looked up from the
 * pairings cache, and the change leaf's `path` + `publicKey` are
 * threaded onto the unsigned tx so the signer can register the change
 * in `signPsbtBuffer.knownAddressDerivations` (and, on the legacy
 * `createPaymentTransaction` fallback path, populate `changePath`).
 * Same RBF default (`0xFFFFFFFD`). Same nonWitnessUtxo requirement on
 * every input (Ledger BTC/LTC app 2.x — issue #213).
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
};

/**
 * Litecoin mainnet network params, in the bitcoinjs-lib `Network`
 * shape. Since bitcoinjs-lib doesn't ship a Litecoin preset we define
 * it here.
 */
const LITECOIN_NETWORK = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: {
    public: 0x0488b21e, // xpub — Litecoin Core convention
    private: 0x0488ade4, // xprv
  },
  pubKeyHash: 0x30, // L-prefix
  scriptHash: 0x32, // M-prefix (modern); legacy 3-prefix not supported on send
  wif: 0xb0,
};

const NETWORK = LITECOIN_NETWORK;

/**
 * Map BIP-32-purpose-to-our-paired-type.
 */
const ADDRESS_FORMAT_BY_TYPE: Record<
  PairedLtcAddressType,
  UnsignedLitecoinTx["addressFormat"]
> = {
  legacy: "legacy",
  "p2sh-segwit": "p2sh",
  segwit: "bech32",
  taproot: "bech32m",
};

/**
 * Account-level path derivation from leaf path.
 */
function accountPathFromLeaf(leafPath: string): string {
  const parts = leafPath.split("/");
  if (parts.length < 5) {
    throw new Error(
      `Invalid Litecoin leaf path "${leafPath}" — expected at least 5 segments ` +
        `(<purpose>'/2'/<account>'/<change>/<index>).`,
    );
  }
  return parts.slice(0, -2).join("/");
}

function roughVbytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}

/**
 * Pick the chain=1 (BIP-32 internal/change) entry from the LTC pairings
 * cache that matches the source's (accountIndex, addressType). Mirror
 * of `pickChangeEntry` in btc/actions.ts. Returns null when none is
 * cached. Issue #254.
 */
function pickChangeEntry(
  paired: ReturnType<typeof getPairedLtcByAddress>,
): { address: string; path: string; publicKey: string } | null {
  if (!paired) return null;
  const all = getPairedLtcAddresses();
  const candidates = all
    .filter(
      (e) =>
        e.accountIndex === paired.accountIndex &&
        e.addressType === paired.addressType &&
        e.chain === 1 &&
        typeof e.addressIndex === "number",
    )
    .sort((a, b) => (a.addressIndex ?? 0) - (b.addressIndex ?? 0));
  const c = candidates[0];
  if (!c) return null;
  return { address: c.address, path: c.path, publicKey: c.publicKey };
}

function litoshisToLtcString(litoshis: bigint): string {
  const negative = litoshis < 0n;
  const abs = negative ? -litoshis : litoshis;
  const whole = abs / LITOSHIS_PER_LTC;
  const frac = abs - whole * LITOSHIS_PER_LTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function parseLtcAmountToLitoshis(amount: string): bigint | null {
  if (amount === "max") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid LTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5") or "max" for the full balance minus fees.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(LTC_DECIMALS, "0");
  return BigInt(whole) * LITOSHIS_PER_LTC + BigInt(padded);
}

export interface BuildLitecoinNativeSendArgs {
  /** Paired LTC source address. Must be in `UserConfig.pairings.litecoin`. */
  wallet: string;
  /** Recipient. L/M/ltc1q/ltc1p — 3-prefix legacy P2SH not supported on send. */
  to: string;
  /** Decimal LTC string ("0.001"), or "max" for full-balance-minus-fee. */
  amount: string;
  /** Fee rate in litoshi/vB. Default: indexer's halfHourFee recommendation. */
  feeRateSatPerVb?: number;
  /** BIP-125 RBF. Default true. */
  rbf?: boolean;
  /** Override the fee-cap guard. Default false. */
  allowHighFee?: boolean;
}

export async function buildLitecoinNativeSend(
  args: BuildLitecoinNativeSendArgs,
): Promise<UnsignedLitecoinTx> {
  // 1. Validate source + destination format.
  assertLitecoinAddress(args.wallet);
  const toType = assertLitecoinAddress(args.to);
  // Reject 3-prefix legacy P2SH on send-side — see file docstring.
  if (toType === "p2sh" && args.to.startsWith("3")) {
    throw new Error(
      `Sending to legacy 3-prefix Litecoin P2SH addresses (${args.to}) is not supported. ` +
        `Litecoin migrated P2SH to the M-prefix (version 0x32) form years ago. Ask the ` +
        `recipient for their modern M-prefix address, or send via Litecoin Core directly.`,
    );
  }

  // 2. Resolve the paired entry for the source.
  const paired = getPairedLtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Litecoin address ${args.wallet} is not paired. Run \`pair_ledger_ltc\` ` +
        `to register the four standard address types (legacy/p2sh-segwit/segwit/taproot) ` +
        `for an account, then pass any of those addresses as \`wallet\`.`,
    );
  }
  // Phase 1 send-side scope: native segwit + taproot only — same scope
  // discipline as BTC. (Note: Litecoin Core has not activated Taproot
  // on mainnet, so taproot sends will derive correctly but recipients
  // can't spend until activation. Native segwit is the recommended
  // path.)
  if (paired.addressType !== "segwit" && paired.addressType !== "taproot") {
    throw new Error(
      `Litecoin sends from ${paired.addressType} (${paired.path}) addresses are not ` +
        `supported in Phase 1 — only native segwit (ltc1q...) and taproot (ltc1p...). ` +
        `Move funds to your paired segwit address first.`,
    );
  }

  // Resolve the BIP-32 chain=1 change address from the pairings cache.
  // Symmetric with the BTC builder. Issue #254.
  const changeEntry = pickChangeEntry(paired);
  if (!changeEntry) {
    throw new Error(
      `No paired chain=1 (change) address found for ${args.wallet}'s account ` +
        `(${paired.addressType}, accountIndex=${paired.accountIndex}). The pairings cache ` +
        `was likely populated when the wallet had no on-chain history (the gap-limit scan ` +
        `skips the change-chain walk in that case). Re-run \`pair_ledger_ltc({ accountIndex: ` +
        `${paired.accountIndex} })\` now that this address has UTXOs and retry.`,
    );
  }

  const indexer = getLitecoinIndexer();

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
      `Resolved fee rate ${feeRate} litoshi/vB is not positive. Pass an explicit ` +
        `\`feeRateSatPerVb\` or check the indexer URL.`,
    );
  }

  // 4. Fetch UTXOs.
  const utxos = await indexer.getUtxos(args.wallet);
  if (utxos.length === 0) {
    throw new Error(
      `No UTXOs at ${args.wallet} — the wallet has zero spendable balance. ` +
        `Verify with \`get_token_balance\` (chain:"litecoin") and confirm at least one ` +
        `tx has confirmed.`,
    );
  }

  // 5. Resolve "max" → fee-aware amount, or convert decimal-LTC → litoshis.
  const csUtxos: CoinSelectInput[] = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
  }));
  let amountSats: bigint;
  if (args.amount === "max") {
    const totalSats = csUtxos.reduce((sum, u) => sum + u.value, 0);
    const vbytes = roughVbytes(csUtxos.length, 1);
    const feeMax = Math.ceil(feeRate * vbytes) + Math.ceil(feeRate * 5);
    if (totalSats <= feeMax) {
      throw new Error(
        `Cannot "max": total balance ${litoshisToLtcString(BigInt(totalSats))} LTC is at or below ` +
          `the estimated fee ${litoshisToLtcString(BigInt(feeMax))} LTC at ${feeRate} litoshi/vB. ` +
          `Lower the feeRate or wait for more confirmations.`,
      );
    }
    amountSats = BigInt(totalSats - feeMax);
  } else {
    const parsed = parseLtcAmountToLitoshis(args.amount);
    if (parsed === null) {
      throw new Error(`Internal error: parseLtcAmountToLitoshis returned null for ${args.amount}`);
    }
    amountSats = parsed;
  }
  if (amountSats <= 0n) {
    throw new Error(
      `Resolved send amount ${amountSats} litoshis is not positive. Increase the amount.`,
    );
  }

  // 6. Coin-selection. Change goes to the BIP-44 chain=1 address from
  //    the pairings cache (issue #254).
  const selection = selectInputs({
    utxos: csUtxos,
    outputs: [{ address: args.to, value: Number(amountSats) }],
    feeRate,
    changeAddress: changeEntry.address,
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });

  // 7. Fetch full prev-tx hex for every UNIQUE input txid (issue #213).
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
      witnessUtxo: { script: sourceScript, value: input.value },
      nonWitnessUtxo: Buffer.from(prevTxHex, "hex"),
    });
  }
  for (const output of selection.outputs) {
    const outScript = bitcoinjs.address.toOutputScript(
      output.address ?? changeEntry.address,
      NETWORK,
    );
    psbt.addOutput({ script: outScript, value: output.value });
  }
  const psbtBase64 = psbt.toBase64();

  const decodedOutputs = selection.outputs.map((o) => {
    const isChange = o.isChange;
    const address = o.address ?? changeEntry.address;
    return {
      address,
      amountSats: o.value.toString(),
      amountLtc: litoshisToLtcString(BigInt(o.value)),
      isChange,
      ...(isChange ? { changePath: changeEntry.path } : {}),
    };
  });

  const accountPath = accountPathFromLeaf(paired.path);
  const vsize = roughVbytes(selection.inputs.length, selection.outputs.length);
  const description = `Send ${litoshisToLtcString(amountSats)} LTC to ${args.to}`;

  const tx: Omit<UnsignedLitecoinTx, "handle" | "fingerprint"> = {
    chain: "litecoin",
    action: "native_send",
    from: args.wallet,
    psbtBase64,
    accountPath,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    change: {
      address: changeEntry.address,
      path: changeEntry.path,
      publicKey: changeEntry.publicKey,
    },
    description,
    decoded: {
      functionName: "litecoin.native_send",
      args: {
        from: args.wallet,
        to: args.to,
        amount: litoshisToLtcString(amountSats),
        feeRate: `${feeRate} litoshi/vB`,
      },
      outputs: decodedOutputs,
      feeSats: selection.fee.toString(),
      feeLtc: litoshisToLtcString(BigInt(selection.fee)),
      feeRateSatPerVb: feeRate,
      rbfEligible: args.rbf !== false,
    },
    vsize,
  };
  return issueLitecoinHandle(tx);
}

/** Validate an LTC address against the four mainnet types. Re-export for tests. */
export function _isSendableAddressType(
  type: LitecoinAddressType,
): type is "p2wpkh" | "p2tr" {
  return type === "p2wpkh" || type === "p2tr";
}

/**
 * Sign a UTF-8 message with the paired Litecoin address using the
 * Litecoin Signed Message format (BIP-137 with Litecoin's message
 * prefix). Mirrors BTC's signBitcoinMessage.
 */
export interface SignLitecoinMessageArgs {
  wallet: string;
  message: string;
}

export interface SignedLitecoinMessage {
  address: string;
  message: string;
  signature: string;
  format: "BIP-137";
  addressType: PairedLtcAddressType;
}

export async function signLitecoinMessage(
  args: SignLitecoinMessageArgs,
): Promise<SignedLitecoinMessage> {
  assertLitecoinAddress(args.wallet);
  if (typeof args.message !== "string" || args.message.length === 0) {
    throw new Error("`message` must be a non-empty string.");
  }
  if (args.message.length > 10_000) {
    throw new Error(
      `Message length ${args.message.length} exceeds the 10000-char ceiling.`,
    );
  }
  const paired = getPairedLtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Litecoin address ${args.wallet} is not paired. Run \`pair_ledger_ltc\` to register ` +
        `the four standard address types and retry with one of the resulting addresses.`,
    );
  }
  const { signLtcMessageOnLedger } = await import(
    "../../signing/ltc-usb-signer.js"
  );
  const messageHex = Buffer.from(args.message, "utf-8").toString("hex");
  const result = await signLtcMessageOnLedger({
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
