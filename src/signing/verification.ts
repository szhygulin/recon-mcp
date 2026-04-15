import {
  concat,
  hexToBytes,
  keccak256,
  numberToBytes,
  toBytes,
} from "viem";
import { CHAIN_IDS } from "../types/index.js";
import type {
  SupportedChain,
  TxVerification,
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

export function tronPayloadFingerprint(rawDataHex: string): `0x${string}` {
  const hex = (rawDataHex.startsWith("0x") ? rawDataHex : `0x${rawDataHex}`) as `0x${string}`;
  return keccak256(concat([toBytes(DOMAIN_TAG_TRON), hexToBytes(hex)]));
}

const SWISS_KNIFE_BASE = "https://calldata.swiss-knife.xyz/decoder";

/**
 * Max URL length we'll emit. Browsers accept much more (Chrome caps around
 * 32 KB) but the MCP chat transport and common terminals truncate long
 * lines, so we fall back to paste-instructions well before any hard limit.
 * Typical DeFi calldata fits comfortably under 4 KB; LiFi cross-chain calls
 * can spike past this and legitimately fall through.
 */
const SWISS_KNIFE_URL_CHAR_BUDGET = 3500;

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
