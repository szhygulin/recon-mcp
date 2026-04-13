/**
 * Pure UTXO-selection logic, independent of any network I/O. Kept here so the
 * coin-selection algorithm can be unit-tested without mocking the HTTP client.
 *
 * Objective: minimize the number of UTXOs remaining in the wallet *after* the
 * transaction confirms — i.e., consolidate. Post-tx UTXO count equals (pool −
 * chosen) + (1 if change else 0), so this is minimized by spending every
 * spendable UTXO and, when possible, absorbing the residue into fee so no
 * change output is created.
 *
 * Strategy: always spend the entire spendable pool. Then:
 *   - If totalIn < target + fee(no-change): insufficient funds.
 *   - Else if change (= totalIn − target − fee-with-change) ≥ dust: emit a
 *     change output. Post-tx wallet has 1 UTXO (the change).
 *   - Else: absorb the residue into fee and emit no change output. Post-tx
 *     wallet has 0 UTXOs.
 *
 * Tradeoff: consolidation increases the fee on *this* transaction roughly
 * linearly in input count, but eliminates the ongoing cost of carrying — and
 * eventually spending — every small UTXO. The user asked explicitly for this
 * objective, so we take the one-time fee hit.
 */

export interface Utxo {
  txid: string;
  vout: number;
  /** Output value in satoshis. */
  value: number;
  confirmed: boolean;
}

export interface SelectionInput {
  utxos: Utxo[];
  /** Amount the recipient should receive, in satoshis. */
  targetSats: bigint;
  /** Fee rate in sat/vB. */
  feeRateSatVb: number;
  /** vsize cost of each input (depends on script type of the source address). */
  inputVbytes: number;
  /** vsize cost of the recipient output. */
  outputVbytesRecipient: number;
  /** vsize cost of the change output (if any). */
  outputVbytesChange: number;
  /** Fixed overhead: version, locktime, witness marker/flag, input/output counts. */
  overheadVbytes: number;
  /** Outputs below this value are absorbed into fee instead of created. */
  dustSats: number;
  /** If true, include unconfirmed (mempool) UTXOs as spendable. */
  includeUnconfirmed?: boolean;
}

export interface SelectionResult {
  chosen: Utxo[];
  totalInSats: bigint;
  /** Fee that will actually be paid (totalIn − target − change). */
  feeSats: bigint;
  /** Change amount in sats (0 if absorbed). */
  changeSats: bigint;
  /** Estimated vsize of the final transaction. */
  vbytes: number;
  /** Effective fee rate actually paid (may exceed feeRateSatVb when change is absorbed). */
  effectiveFeeRateSatVb: number;
}

export function selectUtxos(input: SelectionInput): SelectionResult {
  const chosen = input.utxos
    .filter((u) => input.includeUnconfirmed || u.confirmed)
    .slice()
    // Descending by value — cosmetic; it makes the input list readable but the
    // algorithm spends all of them regardless of order.
    .sort((a, b) => b.value - a.value);

  if (chosen.length === 0) {
    throw new Error("No spendable UTXOs available.");
  }

  const totalIn = chosen.reduce((s, u) => s + BigInt(u.value), 0n);
  const k = chosen.length;

  const vbytesNoChange =
    input.overheadVbytes + k * input.inputVbytes + input.outputVbytesRecipient;
  const feeNoChange = BigInt(Math.ceil(vbytesNoChange * input.feeRateSatVb));

  if (totalIn < input.targetSats + feeNoChange) {
    throw new Error(
      `Insufficient funds: have ${totalIn} sats across ${k} UTXOs, need at least ${input.targetSats + feeNoChange} (target + fee).`
    );
  }

  const vbytesWithChange = vbytesNoChange + input.outputVbytesChange;
  const feeWithChange = BigInt(Math.ceil(vbytesWithChange * input.feeRateSatVb));

  // Prefer a change output when feasible and above dust: keeps the fee at the
  // requested rate rather than over-paying miners. Post-tx wallet has 1 UTXO.
  if (totalIn >= input.targetSats + feeWithChange) {
    const change = totalIn - input.targetSats - feeWithChange;
    if (change >= BigInt(input.dustSats)) {
      return {
        chosen,
        totalInSats: totalIn,
        feeSats: feeWithChange,
        changeSats: change,
        vbytes: vbytesWithChange,
        effectiveFeeRateSatVb: Number(feeWithChange) / vbytesWithChange,
      };
    }
  }

  // Change would be dust (or negative after the change-output overhead) —
  // absorb the residue into fee. Post-tx wallet has 0 UTXOs.
  const actualFee = totalIn - input.targetSats;
  return {
    chosen,
    totalInSats: totalIn,
    feeSats: actualFee,
    changeSats: 0n,
    vbytes: vbytesNoChange,
    effectiveFeeRateSatVb: Number(actualFee) / vbytesNoChange,
  };
}

/**
 * vsize constants by Bitcoin script type. Numbers come from BIP-141/BIP-341
 * worst-case witness sizes; close enough for fee estimation.
 */
export const VBYTES = {
  p2pkh: { input: 148, output: 34 },
  p2sh: { input: 91, output: 32 }, // Assumes P2SH-P2WPKH wrap — the common case.
  p2wpkh: { input: 68, output: 31 },
  p2wsh: { input: 104, output: 43 },
  p2tr: { input: 58, output: 43 },
} as const;

export type BitcoinScriptType = keyof typeof VBYTES;

/** Detect script type from a mainnet address prefix. */
export function detectScriptType(address: string): BitcoinScriptType {
  if (address.startsWith("bc1p")) return "p2tr";
  if (address.startsWith("bc1q")) {
    // P2WPKH is 42 chars total ("bc1q" + 38); P2WSH is 62 chars total ("bc1q" + 58).
    return address.length >= 60 ? "p2wsh" : "p2wpkh";
  }
  if (address.startsWith("3")) return "p2sh";
  if (address.startsWith("1")) return "p2pkh";
  throw new Error(`Cannot detect script type for address: ${address}`);
}

/** Dust threshold per script type (sats). From Bitcoin Core policy. */
export function dustThreshold(scriptType: BitcoinScriptType): number {
  switch (scriptType) {
    case "p2pkh":
      return 546;
    case "p2sh":
      return 540;
    case "p2wpkh":
      return 294;
    case "p2wsh":
      return 330;
    case "p2tr":
      return 330;
  }
}

/**
 * Overhead vbytes for a SegWit-eligible transaction (inputs-from-segwit-address
 * paths). For a pure-legacy spend this is slightly smaller (~10 vB), but
 * overestimating by a couple of bytes just overpays fee by pennies.
 */
export const SEGWIT_OVERHEAD_VBYTES = 11;
export const LEGACY_OVERHEAD_VBYTES = 10;
