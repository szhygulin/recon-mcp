import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  concat,
  hexToBytes,
  keccak256,
  numberToBytes,
  serializeTransaction,
  toBytes,
} from "viem";
import { CHAIN_IDS } from "../types/index.js";
import type {
  SupportedChain,
  TxVerification,
  UnsignedSolanaTx,
  UnsignedTronTx,
  UnsignedTx,
} from "../types/index.js";
import { decodeCalldata, decodeTronCall } from "./decode-calldata.js";

/**
 * Domain-tagged payload fingerprint for EVM transactions. The user can
 * independently re-hash `(chainId, to, value, data)` from the swiss-knife
 * URL params and the chat-displayed `value` — see README §"Verifying the
 * payload hash yourself". At send time, this same function is called again
 * on the EXACT bytes being forwarded to WalletConnect. Equality of the two
 * hashes is the "what-you-preview == what-you-sign" proof.
 *
 * Domain tag is versioned (`txverify-v1`) so a future change to the
 * preimage format won't collide with old recorded hashes.
 */
export const DOMAIN_TAG_EVM = "VaultPilot-txverify-v1:";
export const DOMAIN_TAG_TRON = "VaultPilot-txverify-v1:tron:";
export const DOMAIN_TAG_SOLANA = "VaultPilot-txverify-v1:solana:";

export function payloadFingerprint(
  tx: Pick<UnsignedTx, "chain" | "to" | "value" | "data">,
): `0x${string}` {
  const chainId = CHAIN_IDS[tx.chain];
  return keccak256(
    concat([
      toBytes(DOMAIN_TAG_EVM),
      numberToBytes(chainId, { size: 32 }),
      hexToBytes(tx.to),
      numberToBytes(BigInt(tx.value), { size: 32 }),
      hexToBytes(tx.data),
    ]),
  );
}

/**
 * Compute the EIP-1559 pre-sign hash — keccak256 of the unsigned RLP envelope
 * Ledger's Ethereum app displays in blind-sign mode. Input must be the FULL
 * tuple Ledger sees after Ledger Live forwards our pinned nonce/fees/gas via
 * WalletConnect. Any desync (e.g. user taps "Edit gas" in Ledger Live) will
 * shift this hash — that's the intended failure mode; the user rejects.
 *
 * Access list is empty — we never emit 2930 txs, so the serialization is
 * `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to,
 * value, data, []])`. viem's `serializeTransaction({type:"eip1559", ...})`
 * emits this exact shape when no signature is present.
 */
export function eip1559PreSignHash(args: {
  chainId: number;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}): `0x${string}` {
  const serialized = serializeTransaction({
    type: "eip1559",
    chainId: args.chainId,
    nonce: args.nonce,
    maxFeePerGas: args.maxFeePerGas,
    maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    gas: args.gas,
    to: args.to,
    value: args.value,
    data: args.data,
  });
  return keccak256(serialized);
}

export function tronPayloadFingerprint(rawDataHex: string): `0x${string}` {
  const hex = (rawDataHex.startsWith("0x") ? rawDataHex : `0x${rawDataHex}`) as `0x${string}`;
  return keccak256(concat([toBytes(DOMAIN_TAG_TRON), hexToBytes(hex)]));
}

/**
 * Fingerprint for a Solana tx — hashes the base64-decoded message bytes
 * (what the Ledger signs) with a Solana-specific domain tag. Preview and
 * send both re-hash the stored message to confirm nothing was tampered
 * with between prepare and broadcast.
 */
export function solanaPayloadFingerprint(messageBase64: string): `0x${string}` {
  const messageBytes = Buffer.from(messageBase64, "base64");
  return keccak256(concat([toBytes(DOMAIN_TAG_SOLANA), new Uint8Array(messageBytes)]));
}

/**
 * Reproduces the "Message Hash" string the Ledger Solana app displays during
 * blind-sign: base58(sha256(compiledMessageBytes)) where compiledMessageBytes
 * is the exact message buffer the Ledger Ed25519-signs (i.e. our
 * `messageBase64` after base64-decode). Verified against the app-solana
 * source: `cx_hash_sha256` on the raw message buffer in
 * src/handle_sign_message.c, then base58-rendered via
 * libsol/transaction_summary.c. No truncation — the full 32-byte digest is
 * shown on-device (~43–44 base58 chars).
 *
 * Users enable "Allow blind signing" in Solana app → Settings to land on
 * this screen; they then match the string below against the device display
 * before approving. Distinct from `solanaPayloadFingerprint` above, which is
 * our own domain-tagged keccak256 for server-side preview↔send consistency
 * and is NEVER shown on-device.
 */
export function solanaLedgerMessageHash(messageBase64: string): string {
  const messageBytes = Buffer.from(messageBase64, "base64");
  const digest = createHash("sha256").update(messageBytes).digest();
  return bs58.encode(digest);
}

const SWISS_KNIFE_BASE = "https://calldata.swiss-knife.xyz/decoder";

/**
 * Max URL length we'll emit. swiss-knife.xyz is a client-side Next.js SPA
 * hosted on Vercel (practical request-line limit ~14 KB per Vercel docs);
 * all modern browsers accept at least 32 KB. 12 000 chars leaves margin
 * while comfortably covering typical LiFi intra-chain swap calldata
 * (~2 KB ≈ 4 300 hex chars) that used to fall back to paste-only under
 * the previous 3 500 budget. Cross-chain LiFi hops can still exceed this
 * and legitimately fall through to paste instructions.
 */
const SWISS_KNIFE_URL_CHAR_BUDGET = 12000;

/**
 * Build a swiss-knife.xyz decoder URL preloaded with the calldata, destination
 * address, and chainId. When everything fits in the URL budget, return
 * `{ decoderUrl }`. Otherwise return `{ decoderPasteInstructions }` — the
 * user opens the base page and pastes the three fields manually.
 *
 * URL format source: `components/pages/CalldataDecoderPage.tsx` lines 62-65
 * on swiss-knife master at commit HEAD 2026-04-15 — `searchParams.get("calldata")`,
 * `searchParams.get("address")`, `searchParams.get("chainId")`. Verified
 * directly from the project's repo (rnd-skill primary-artifact source).
 */
export function swissKnifeDecoderUrl(
  chainId: number,
  to: `0x${string}`,
  data: `0x${string}`,
): { decoderUrl?: string; decoderPasteInstructions?: string } {
  const qs = `?calldata=${data}&address=${to}&chainId=${chainId}`;
  if (SWISS_KNIFE_BASE.length + qs.length > SWISS_KNIFE_URL_CHAR_BUDGET) {
    return {
      decoderPasteInstructions:
        `Open ${SWISS_KNIFE_BASE} and paste the three fields manually — calldata, ` +
        `address, and chainId — shown in the VERIFY block below. The calldata is ` +
        `too large to fit in a preloaded URL.`,
    };
  }
  return { decoderUrl: `${SWISS_KNIFE_BASE}${qs}` };
}

function comparisonStringEvm(
  chain: SupportedChain,
  to: `0x${string}`,
  value: string,
  data: `0x${string}`,
): string {
  return `${CHAIN_IDS[chain]}:${to.toLowerCase()}:${value}:${data}`;
}

export function buildVerification(tx: UnsignedTx): TxVerification {
  const payloadHash = payloadFingerprint(tx);
  const payloadHashShort = payloadHash.slice(2, 10);
  const chainId = CHAIN_IDS[tx.chain];
  const { decoderUrl, decoderPasteInstructions } = swissKnifeDecoderUrl(chainId, tx.to, tx.data);
  const humanDecode = decodeCalldata(tx.chain, tx.to, tx.data, tx.value);
  const out: TxVerification = {
    payloadHash,
    payloadHashShort,
    humanDecode,
    comparisonString: comparisonStringEvm(tx.chain, tx.to, tx.value, tx.data),
  };
  if (decoderUrl) out.decoderUrl = decoderUrl;
  if (decoderPasteInstructions) out.decoderPasteInstructions = decoderPasteInstructions;
  return out;
}

export function buildTronVerification(tx: UnsignedTronTx): TxVerification {
  const payloadHash = tronPayloadFingerprint(tx.rawDataHex);
  const payloadHashShort = payloadHash.slice(2, 10);
  return {
    payloadHash,
    payloadHashShort,
    humanDecode: decodeTronCall(tx),
    comparisonString: `tron:${tx.from}:${tx.txID}:${tx.rawDataHex}`,
    // swiss-knife.xyz is EVM-only; TRON users verify via Tronscan (not preloaded)
    // and the local decode. Emit paste instructions pointing at Tronscan's raw-data
    // viewer, with a note that the URL shape there is not yet verified — the user
    // should visually confirm the action type + amount against chat.
    decoderPasteInstructions:
      `swiss-knife.xyz doesn't support TRON. Verify by (1) comparing the decoded ` +
      `action + args below against what you expected, and (2) pasting txID ${tx.txID} ` +
      `into https://tronscan.org/#/transaction/<txID> AFTER signing to see the ` +
      `network's interpretation. The payload hash below is over the exact rawDataHex ` +
      `that will be signed on the Ledger.`,
  };
}

/**
 * Build the pre-sign verification bundle for a Solana tx. Parallel to
 * `buildTronVerification`. The decoded structure comes from the tx
 * itself (the builder populates `decoded`); `payloadHash` is over the
 * base64-decoded message bytes — the exact bytes the Ledger signs.
 */
export function buildSolanaVerification(tx: UnsignedSolanaTx): TxVerification {
  const payloadHash = solanaPayloadFingerprint(tx.messageBase64);
  const payloadHashShort = payloadHash.slice(2, 10);
  const args = Object.entries(tx.decoded.args).map(([name, value]) => ({
    name,
    type: "string",
    value: String(value),
  }));
  return {
    payloadHash,
    payloadHashShort,
    humanDecode: {
      functionName: tx.decoded.functionName,
      args,
      // "local-abi" is EVM-specific (viem decode of a known ABI); TRON uses
      // its own string. For Solana, the decode is builder-populated from
      // Solana instruction types (SystemProgram / SPL Token) — tag "local-abi"
      // as the closest match; it tells the UI this is a trusted local decode
      // rather than "no decode available".
      source: "local-abi" as const,
    },
    comparisonString: `solana:${tx.from}:${tx.recentBlockhash}:${tx.messageBase64}`,
    // swiss-knife.xyz is EVM-only. For Solana, the user's independent verifier
    // is the Solana Ledger app itself (clear-signs transfers + TransferChecked)
    // plus post-broadcast inspection on solscan.io.
    decoderPasteInstructions:
      `swiss-knife.xyz doesn't support Solana. Verify by (1) reading the clear-sign ` +
      `screens on the Ledger Solana app — amount + recipient + mint are shown for ` +
      `SystemProgram.Transfer and Token.TransferChecked; (2) after broadcast, ` +
      `comparing the tx on https://solscan.io/tx/<signature>. The payload hash below ` +
      `is over the exact message bytes signed by the Ledger.`,
  };
}
