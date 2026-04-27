import { createRequire } from "node:module";
import { formatUnits } from "viem";
import { fetchBitcoinQuote } from "../swap/lifi.js";
import { assertBitcoinAddress } from "./address.js";
import { getBitcoinIndexer } from "./indexer.js";
import {
  getPairedBtcByAddress,
  type BtcAddressType as PairedBtcAddressType,
} from "../../signing/btc-usb-signer.js";
import { issueBitcoinHandle } from "../../signing/btc-tx-store.js";
import { assertSlippageOk } from "../swap/index.js";
import {
  SOLANA_ADDRESS,
  EVM_ADDRESS,
} from "../../shared/address-patterns.js";
import { SATS_PER_BTC, BTC_DECIMALS } from "../../config/btc.js";
import type {
  SupportedChain,
  UnsignedBitcoinTx,
} from "../../types/index.js";

/**
 * BTC-source LiFi swap/bridge builder. Mirrors `buildBitcoinNativeSend`
 * in the contract it returns (an `UnsignedBitcoinTx` ready for the
 * Ledger BTC signer), but the PSBT itself is constructed by LiFi rather
 * than coin-selected locally:
 *
 *  1. Call LiFi's quote endpoint with `fromChain=BTC` (chain id
 *     `20000000000001`). LiFi auctions the route across solvers (NEAR
 *     Intents, Garden Finance, Thorswap, Chainflip, Symbiosis, etc.)
 *     and returns a PSBT-v0 hex committing to a deposit-to-vault output
 *     plus an OP_RETURN memo whose contents the chosen solver decodes
 *     server-side to release funds on the destination chain.
 *
 *  2. Hydrate the PSBT — LiFi's response carries `witnessUtxo` only on
 *     each input. Ledger BTC app 2.x rejects segwit/taproot inputs
 *     without `nonWitnessUtxo` ("Security risk: unverified inputs",
 *     0x6985). We re-fetch each prev-tx's hex from our indexer and
 *     attach. Same fix path as the equivalent native_send guard
 *     (issue #213).
 *
 *  3. Cross-check the PSBT against what we asked LiFi for:
 *      - every input's prevout script must equal the paired source's
 *        scriptPubKey (a compromised aggregator can't hand us inputs
 *        the device couldn't sign anyway, but a sanity-check refuses
 *        the call before it ever reaches USB).
 *      - the deposit output's recipient must equal
 *        `transactionRequest.to` (the vault address LiFi advertised).
 *      - exactly one OP_RETURN output must be present (the memo
 *        committing to the cross-chain destination).
 *
 *  4. Decode the OP_RETURN bytes for the verification block. The memo
 *     is solver-specific (`=|lifi…` for NEAR Intents, raw bridge tags
 *     for Thorswap/Chainflip). We surface it as hex + ASCII-readable
 *     prefix so the user has SOMETHING to compare against the route
 *     description, but the trust anchor is `(vault address, OP_RETURN
 *     bytes)` resolving server-side at LiFi — not a memo we
 *     independently parse.
 *
 *  5. Identify the change output. LiFi sends change back to the source
 *     address (chain=0) — same simplification the existing
 *     `prepare_btc_send` Phase-1 builder ships with. Ledger flags the
 *     output with the "unusual change path" notice but the funds
 *     return to the user's own wallet either way; consistent with
 *     existing UX.
 *
 * Phase-1 source-side scope (matches `prepare_btc_send`): native segwit
 * + taproot only. Legacy and P2SH-wrapped sources are deferred — the
 * SAME rationale (Ledger sign path consistency) applies.
 *
 * Destination scope: any LiFi-routable destination — every EVM chain in
 * `SupportedChain`, plus Solana. TRON has no LiFi route from BTC
 * (empirical: returns `tool: null`); rejected up-front with a clear
 * error rather than a generic "no route found" surface bubble.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    new (opts?: { network?: unknown }): BitcoinjsPsbt;
    fromHex(hex: string, opts?: { network?: unknown }): BitcoinjsPsbt;
    fromBase64(b64: string, opts?: { network?: unknown }): BitcoinjsPsbt;
  };
  address: {
    toOutputScript(address: string, network?: unknown): Buffer;
    fromOutputScript(script: Buffer, network?: unknown): string;
  };
  networks: { bitcoin: unknown };
};

interface BitcoinjsPsbt {
  txInputs: Array<{ hash: Buffer; index: number; sequence?: number }>;
  txOutputs: Array<{ script: Buffer; value: number; address?: string }>;
  data: {
    inputs: Array<{
      witnessUtxo?: { script: Buffer; value: number };
      nonWitnessUtxo?: Buffer;
    }>;
  };
  updateInput(
    inputIndex: number,
    updateData: { nonWitnessUtxo?: Buffer },
  ): unknown;
  toBase64(): string;
}

const NETWORK = bitcoinjs.networks.bitcoin;

/**
 * Map our paired addressType to the signer's `addressFormat`. Phase 1
 * source restriction below means only the segwit + taproot rows are
 * actually reachable, but the table is exhaustive so a future
 * legacy/p2sh widening doesn't have to touch this file.
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

function accountPathFromLeaf(leafPath: string): string {
  const parts = leafPath.split("/");
  if (parts.length < 5) {
    throw new Error(
      `Invalid Bitcoin leaf path "${leafPath}" — expected at least 5 segments.`,
    );
  }
  return parts.slice(0, -2).join("/");
}

function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = abs - whole * SATS_PER_BTC;
  const fracStr = frac
    .toString()
    .padStart(BTC_DECIMALS, "0")
    .replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function parseBtcAmountToSats(amount: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid BTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5"). "max" is not supported for LiFi swaps because ` +
        `the bridge needs an exact deposit amount committed up-front.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(BTC_DECIMALS, "0");
  return BigInt(whole) * SATS_PER_BTC + BigInt(padded);
}

/**
 * Reverse a 32-byte hash buffer into a hex txid string. PSBT inputs
 * carry the prevout hash in little-endian (internal) order; txid display
 * uses the byte-reversed (big-endian / RPC) form.
 */
function bufferToTxid(hash: Buffer): string {
  const reversed = Buffer.from(hash).reverse();
  return reversed.toString("hex");
}

/**
 * Parse an OP_RETURN script's pushed payload bytes. Returns null when the
 * script is not a single-pushdata OP_RETURN. Spec: BIP-30 / SIP — any
 * bytes pushed by an opcode after `0x6a`.
 */
function parseOpReturnPayload(script: Buffer): Buffer | null {
  if (script.length < 2 || script[0] !== 0x6a) return null;
  const op = script[1];
  // OP_PUSHBYTES_1..75: length is the opcode itself.
  if (op >= 0x01 && op <= 0x4b) {
    const want = op;
    if (script.length !== 2 + want) return null;
    return script.slice(2, 2 + want);
  }
  // OP_PUSHDATA1: 1-byte length follows.
  if (op === 0x4c) {
    if (script.length < 3) return null;
    const want = script[2];
    if (script.length !== 3 + want) return null;
    return script.slice(3, 3 + want);
  }
  // OP_PUSHDATA2 / OP_PUSHDATA4 unreachable for memo-sized payloads;
  // refuse rather than half-parse.
  return null;
}

/**
 * Best-effort ASCII view of the OP_RETURN payload. Returns the
 * printable-prefix substring up to the first non-printable byte; if no
 * printable prefix exists, returns the empty string. Used purely for
 * the verification block's user-facing memo display — the canonical
 * representation is the hex.
 */
function asciiPrefix(payload: Buffer): string {
  let end = 0;
  while (end < payload.length) {
    const b = payload[end];
    if (b >= 0x20 && b <= 0x7e) end++;
    else break;
  }
  return payload.slice(0, end).toString("ascii");
}

export interface BuildBitcoinLifiSwapArgs {
  /**
   * Paired BTC source address. Phase-1 source restriction: native
   * segwit (`bc1q…`) or taproot (`bc1p…`). Multi-source consolidation
   * is out of scope for swap (LiFi's quote endpoint takes a single
   * `fromAddress` and runs its own UTXO scan; piping in user-side
   * coin-selection across multiple addresses would diverge from
   * what LiFi committed in the PSBT and break solver matching).
   */
  wallet: string;
  /** Destination chain — EVM `SupportedChain` or `"solana"`. */
  toChain: SupportedChain | "solana";
  /**
   * Destination token. EVM hex when `toChain` is EVM; SPL mint
   * (base58) when `toChain === "solana"`. `"native"` resolves to the
   * chain's conventional native sentinel.
   */
  toToken: string | "native";
  /**
   * Destination wallet — REQUIRED. The Bitcoin source address is not
   * a valid recipient on any destination chain.
   */
  toAddress: string;
  /** Decimal BTC string (up to 8 fractional digits, e.g. "0.005"). */
  amount: string;
  /** Slippage in basis points. Default 50 (0.5%). Hard cap 500 (5%). */
  slippageBps?: number;
  /** Required when `slippageBps > 100`. Mirror of `prepare_swap` guard. */
  acknowledgeHighSlippage?: boolean;
}

export async function buildBitcoinLifiSwap(
  args: BuildBitcoinLifiSwapArgs,
): Promise<UnsignedBitcoinTx> {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  assertBitcoinAddress(args.wallet);
  const paired = getPairedBtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Bitcoin address ${args.wallet} is not paired. Run \`pair_ledger_btc\` to register ` +
        `the four standard address types and retry with one of the resulting addresses.`,
    );
  }
  if (paired.addressType !== "segwit" && paired.addressType !== "taproot") {
    throw new Error(
      `Bitcoin LiFi swaps from ${paired.addressType} addresses are not supported in ` +
        `Phase 1 — only native segwit (bc1q…) and taproot (bc1p…). Move funds to your ` +
        `paired segwit or taproot address first.`,
    );
  }

  // Destination addressing checks. Reject EVM-shaped addresses for Solana
  // destinations and Solana-shaped addresses for EVM destinations up-front
  // — LiFi will silently route to a wrong-format destination on its side
  // and funds end up unspendable.
  if (args.toChain === "solana") {
    if (!SOLANA_ADDRESS.test(args.toAddress)) {
      throw new Error(
        `toAddress "${args.toAddress}" is not a valid Solana base58 address ` +
          `(expected 43-44 chars). Refusing to route a BTC bridge to an unparseable ` +
          `Solana destination.`,
      );
    }
  } else {
    if (!EVM_ADDRESS.test(args.toAddress)) {
      throw new Error(
        `toAddress "${args.toAddress}" is not a valid EVM address. ` +
          `For toChain="${args.toChain}" pass a 0x-prefixed 40-hex-char address.`,
      );
    }
  }

  const fromAmountSats = parseBtcAmountToSats(args.amount);
  if (fromAmountSats <= 0n) {
    throw new Error(`Resolved BTC amount ${fromAmountSats} sats is not positive.`);
  }

  const quote = await fetchBitcoinQuote({
    fromAddress: args.wallet,
    fromAmount: fromAmountSats.toString(),
    toChain: args.toChain,
    toToken: args.toToken,
    toAddress: args.toAddress,
    ...(args.slippageBps !== undefined
      ? { slippage: args.slippageBps / 10_000 }
      : {}),
  });

  const txRequest = quote.transactionRequest;
  if (!txRequest || !txRequest.to || !txRequest.data) {
    throw new Error(
      "LiFi did not return a transactionRequest for this BTC quote. The aggregator may " +
        "have no route — try a different destination chain/token, or a larger amount.",
    );
  }
  const psbtHex = (txRequest.data as string).startsWith("0x")
    ? (txRequest.data as string).slice(2)
    : (txRequest.data as string);
  if (!/^[0-9a-fA-F]+$/.test(psbtHex) || psbtHex.length % 2 !== 0) {
    throw new Error(
      "LiFi returned a transactionRequest.data that is not a hex PSBT. " +
        "Refusing to forward a malformed payload to the Ledger BTC app.",
    );
  }

  // Decode the PSBT for inspection + verification + hydration.
  let psbt: BitcoinjsPsbt;
  try {
    psbt = bitcoinjs.Psbt.fromHex(psbtHex, { network: NETWORK });
  } catch (err) {
    throw new Error(
      `Failed to decode LiFi PSBT: ${(err as Error).message}. Refusing to forward to Ledger.`,
    );
  }

  // 1. Cross-check inputs all belong to the source address. A LiFi
  //    response that pulls inputs from foreign addresses (whether by
  //    bug or because someone tampered with the response in transit)
  //    would not be signable by our Ledger anyway — but refusing here
  //    surfaces the problem with a clear message instead of an
  //    opaque device-side error.
  const sourceScript = bitcoinjs.address.toOutputScript(args.wallet, NETWORK);
  if (psbt.txInputs.length === 0) {
    throw new Error(
      `LiFi PSBT has no inputs — refusing to forward an empty deposit to the Ledger.`,
    );
  }
  for (let i = 0; i < psbt.txInputs.length; i++) {
    const witnessUtxo = psbt.data.inputs[i]?.witnessUtxo;
    if (!witnessUtxo) {
      throw new Error(
        `LiFi PSBT input ${i} has no witnessUtxo. Refusing to forward a non-segwit/` +
          `non-taproot input — Phase 1 source scope is segwit/taproot only.`,
      );
    }
    if (!witnessUtxo.script.equals(sourceScript)) {
      throw new Error(
        `LiFi PSBT input ${i} comes from a different scriptPubKey than the source ` +
          `address ${args.wallet}. The aggregator selected UTXOs from another address; ` +
          `refusing to forward — the Ledger could not sign these inputs anyway.`,
      );
    }
  }

  // 2. Walk outputs: vault deposit + OP_RETURN memo + change-back-to-
  //    source + LiFi fee. Capture each so the verification block has
  //    the full picture.
  if (psbt.txOutputs.length < 2) {
    throw new Error(
      `LiFi PSBT has ${psbt.txOutputs.length} outputs — expected at least 2 ` +
        `(deposit + OP_RETURN memo). Refusing to forward.`,
    );
  }
  const vaultAddress = txRequest.to as string;
  const vaultOutputScript = bitcoinjs.address.toOutputScript(vaultAddress, NETWORK);

  let vaultOutputIndex = -1;
  let opReturnOutputIndex = -1;
  let opReturnPayload: Buffer | null = null;

  type OutputInfo = {
    address: string;
    amountSats: bigint;
    isChange: boolean;
    isVault: boolean;
    isOpReturn: boolean;
    isLifiFee: boolean;
    opReturnHex?: string;
    opReturnAscii?: string;
  };
  const outputInfos: OutputInfo[] = [];

  for (let i = 0; i < psbt.txOutputs.length; i++) {
    const out = psbt.txOutputs[i];
    const isOpReturn = out.script.length > 0 && out.script[0] === 0x6a;
    if (isOpReturn) {
      const payload = parseOpReturnPayload(out.script);
      if (!payload) {
        throw new Error(
          `LiFi PSBT output ${i} is OP_RETURN but the pushdata layout is not parseable ` +
            `(script ${out.script.toString("hex")}). Refusing to forward an undecodable memo.`,
        );
      }
      if (opReturnOutputIndex !== -1) {
        throw new Error(
          `LiFi PSBT has multiple OP_RETURN outputs (indices ${opReturnOutputIndex}, ${i}). ` +
            `Expected exactly one memo output; refusing to forward.`,
        );
      }
      opReturnOutputIndex = i;
      opReturnPayload = payload;
      outputInfos.push({
        address: "OP_RETURN",
        amountSats: BigInt(out.value),
        isChange: false,
        isVault: false,
        isOpReturn: true,
        isLifiFee: false,
        opReturnHex: payload.toString("hex"),
        opReturnAscii: asciiPrefix(payload),
      });
      continue;
    }

    let address: string;
    try {
      address = bitcoinjs.address.fromOutputScript(out.script, NETWORK);
    } catch {
      throw new Error(
        `LiFi PSBT output ${i} has a non-standard script (${out.script.toString("hex")}) ` +
          `the BTC indexer cannot map to an address. Refusing to forward — the Ledger ` +
          `BTC app would clear-sign an opaque output and the user can't verify it.`,
      );
    }

    const isVault = out.script.equals(vaultOutputScript);
    const isChange = out.script.equals(sourceScript) && !isVault;
    if (isVault && vaultOutputIndex !== -1) {
      throw new Error(
        `LiFi PSBT has multiple outputs to the vault address ${vaultAddress} ` +
          `(indices ${vaultOutputIndex}, ${i}). Refusing to forward.`,
      );
    }
    if (isVault) vaultOutputIndex = i;

    outputInfos.push({
      address,
      amountSats: BigInt(out.value),
      isChange,
      isVault,
      isOpReturn: false,
      isLifiFee: !isVault && !isChange,
    });
  }

  if (vaultOutputIndex === -1) {
    throw new Error(
      `LiFi PSBT has no output to the vault address ${vaultAddress} declared in ` +
        `transactionRequest.to. The aggregator's PSBT and routing metadata disagree; ` +
        `refusing to forward — re-fetch the quote.`,
    );
  }
  if (opReturnOutputIndex === -1 || !opReturnPayload) {
    throw new Error(
      `LiFi PSBT has no OP_RETURN memo output. Cross-chain bridges via LiFi commit ` +
        `the destination via an OP_RETURN tag; without it the deposit cannot be ` +
        `matched to a route. Refusing to forward.`,
    );
  }

  // 3. Hydrate every input with nonWitnessUtxo (Ledger 2.x requirement,
  //    issue #213). Fan the prev-tx fetches out in parallel — typical
  //    BTC LiFi deposits use 1-3 inputs, so we don't even bother
  //    deduping by txid; the indexer's HTTP cache absorbs any repeats.
  const indexer = getBitcoinIndexer();
  const uniqueTxids = [
    ...new Set(psbt.txInputs.map((i) => bufferToTxid(i.hash))),
  ];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);
  for (let i = 0; i < psbt.txInputs.length; i++) {
    const txid = bufferToTxid(psbt.txInputs[i].hash);
    const hex = prevTxHexByTxid.get(txid);
    if (!hex) {
      throw new Error(
        `Internal error: prev-tx hex missing for ${txid} after fan-out fetch.`,
      );
    }
    if (!psbt.data.inputs[i].nonWitnessUtxo) {
      psbt.updateInput(i, { nonWitnessUtxo: Buffer.from(hex, "hex") });
    }
  }
  const psbtBase64 = psbt.toBase64();

  // 4. Build the decoded outputs list for the verification block.
  const decodedOutputs = outputInfos.map((o) => {
    const base = {
      address: o.address,
      amountSats: o.amountSats.toString(),
      amountBtc: satsToBtcString(o.amountSats),
      isChange: o.isChange,
    };
    if (o.isChange) {
      // change goes back to the source address (chain=0, same path
      // as the source itself). Ledger surfaces an "unusual change
      // path" notice — informational, not blocking.
      return { ...base, changePath: paired.path };
    }
    return base;
  });

  // 5. Per-source breakdown — every input came from `args.wallet`
  //    per the input-source check above, so this is a single-row
  //    table.
  const totalInputSats = psbt.data.inputs.reduce(
    (sum, inp) => sum + BigInt(inp.witnessUtxo?.value ?? 0),
    0n,
  );
  const decodedSources = [
    {
      address: args.wallet,
      pulledSats: totalInputSats.toString(),
      pulledBtc: satsToBtcString(totalInputSats),
      inputCount: psbt.txInputs.length,
    },
  ];

  // 6. Fee = inputs - outputs.
  const totalOutputSats = outputInfos.reduce(
    (sum, o) => sum + o.amountSats,
    0n,
  );
  const feeSats = totalInputSats - totalOutputSats;
  if (feeSats < 0n) {
    throw new Error(
      `LiFi PSBT outputs (${totalOutputSats} sats) exceed inputs (${totalInputSats} sats). ` +
        `Negative fee — refusing to forward a malformed PSBT to the Ledger.`,
    );
  }
  // Approximate vsize for a fee-rate display. P2WPKH/P2TR inputs ≈ 68 vbytes,
  // outputs ≈ 31 vbytes (OP_RETURN ~10), header 10. Same approximation the
  // native_send builder uses; precise vsize requires signing (sig sizes vary).
  const vsize = 10 + psbt.txInputs.length * 68 + outputInfos.length * 31;
  const feeRate = vsize > 0 ? Number(feeSats) / vsize : 0;

  // 7. Quote summary for the verification block.
  const fromTokSym = quote.action.fromToken.symbol;
  const toTokSym = quote.action.toToken.symbol;
  const toDecimals = quote.action.toToken.decimals;
  const expectedOut = formatUnits(BigInt(quote.estimate.toAmount), toDecimals);
  const minOut = formatUnits(BigInt(quote.estimate.toAmountMin), toDecimals);
  const description =
    `Bridge ${args.amount} BTC → ~${expectedOut} ${toTokSym} on ${args.toChain} via LiFi (${quote.tool})`;

  const sources = [
    {
      address: args.wallet,
      path: paired.path,
      publicKey: paired.publicKey,
    },
  ];
  const inputSources = psbt.txInputs.map(() => args.wallet);
  const accountPath = accountPathFromLeaf(paired.path);
  const opReturnHex = opReturnPayload.toString("hex");
  const opReturnAsciiHint = asciiPrefix(opReturnPayload);

  const tx: Omit<UnsignedBitcoinTx, "handle" | "fingerprint"> = {
    chain: "bitcoin",
    action: "native_send",
    from: args.wallet,
    sources,
    inputSources,
    psbtBase64,
    accountPath,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    description,
    decoded: {
      functionName: "bitcoin.lifi_swap",
      args: {
        from: args.wallet,
        toChain: args.toChain,
        toToken: `${toTokSym} (${quote.action.toToken.address})`,
        toAddress: args.toAddress,
        amountSent: args.amount,
        amountSentSym: fromTokSym,
        expectedOut: `${expectedOut} ${toTokSym}`,
        minOut: `${minOut} ${toTokSym}`,
        slippageBps: String(args.slippageBps ?? 50),
        route: quote.tool,
        executionDurationSec: String(quote.estimate.executionDuration ?? "?"),
        vault: vaultAddress,
        opReturnHex,
        ...(opReturnAsciiHint ? { opReturnAscii: opReturnAsciiHint } : {}),
      },
      outputs: decodedOutputs,
      sources: decodedSources,
      feeSats: feeSats.toString(),
      feeBtc: satsToBtcString(feeSats),
      feeRateSatPerVb: Math.round(feeRate * 100) / 100,
      rbfEligible: false,
    },
    vsize,
  };
  return issueBitcoinHandle(tx);
}
