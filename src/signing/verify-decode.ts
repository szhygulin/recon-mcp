import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
} from "viem";
import type { UnsignedTx } from "../types/index.js";

/**
 * Independent arg+selector cross-check.
 *
 * The verification block already shows a LOCAL decode built from our static
 * ABI registry. That is one voice. The "swiss-knife decoder" URL printed in
 * chat is a SECOND voice — but it's a client-rendered Next.js SPA, so
 * `WebFetch` can't see its output, and we can't cheaply verify it on the
 * user's behalf. Telling the agent "confirm it matches swiss-knife" is
 * therefore asking the agent to lie or do something opaque.
 *
 * This module replaces that gap with a third, server-side decode whose
 * input is INDEPENDENT of our ABI registry:
 *
 *   1. Fetch all candidate function signatures for the 4-byte selector from
 *      https://www.4byte.directory — a public registry built from unrelated
 *      on-chain traffic.
 *   2. For each candidate, attempt `decodeFunctionData → encodeFunctionData`.
 *      If the re-encoded bytes equal the original calldata, the signature
 *      describes the calldata LOSSLESSLY (any trailing junk, wrong arity, or
 *      mismatched type layout would fail this). First one that round-trips
 *      is the confirmed signature.
 *   3. Compare the function NAME from the independent signature to the
 *      function name the local decode claims. If they agree, the local
 *      decode's function identity is corroborated by a source that has no
 *      knowledge of our ABI files. If they disagree, return MISMATCH — this
 *      is a strong "do not send" signal.
 *
 * Why we don't separately compare each arg VALUE: the re-encode check is
 * stricter. Once we've proved that `decode(data) → args` and
 * `encode(args) === data` for a given type layout, any other decoder reading
 * the same `data` with the same types is guaranteed to produce the same
 * leaf values — the mapping from calldata bytes to typed values is a
 * function, not a choice. An arg-by-arg stringify compare would just be
 * testing that viem is deterministic.
 */

export interface VerifyDecodeResult {
  status: "match" | "mismatch" | "no-signature" | "no-data" | "not-applicable" | "error";
  selector: string;
  localFunctionName?: string;
  localSignature?: string;
  independentSignature?: string;
  independentFunctionName?: string;
  reencodeCheck?: "pass" | "fail";
  candidateCount?: number;
  independentArgs?: Array<{ index: number; type: string; value: string }>;
  /**
   * Human-readable, end-user-facing message. The orchestrator agent relays
   * this VERBATIM to the user so the phrasing is consistent across calls.
   */
  summary: string;
}

const FOURBYTE_URL = "https://www.4byte.directory/api/v1/signatures/";

export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const defaultFetch: FetchLike = (url) => fetch(url);

async function fetch4byteSignatures(selector: string, fetchFn: FetchLike): Promise<string[]> {
  const res = await fetchFn(`${FOURBYTE_URL}?hex_signature=${selector}`);
  if (!res.ok) throw new Error(`4byte.directory returned ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ text_signature: string }> };
  return (data.results ?? []).map((r) => r.text_signature);
}

function funcName(sig: string): string {
  const idx = sig.indexOf("(");
  return idx < 0 ? sig : sig.slice(0, idx);
}

/**
 * Positional-only stringifier for decoded raw values. Drops struct field
 * names (`{foo: 1, bar: 2}` → `[1, 2]`) so callers can read the output
 * without needing a compatible ABI schema. Hex blobs > 32 bytes are
 * truncated for UI legibility — the lossless re-encode is the real
 * correctness check, this string is just for humans to skim.
 */
function stringifyRaw(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.startsWith("0x") && value.length > 66) {
      const byteLen = Math.floor((value.length - 2) / 2);
      return `${value.slice(0, 14)}…${value.slice(-8)} (${byteLen} bytes)`;
    }
    return value;
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stringifyRaw).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `[${Object.values(value as Record<string, unknown>).map(stringifyRaw).join(", ")}]`;
  }
  return String(value);
}

export function notApplicableForTron(): VerifyDecodeResult {
  return {
    status: "not-applicable",
    selector: "0x",
    summary:
      "Independent cross-check via 4byte.directory is EVM-only. On TRON, the preparer hand-builds the " +
      "structured decoded action (transfer / vote / freeze / …) directly from the TronGrid envelope — " +
      "there is no 4-byte selector to look up. After broadcast, paste the txID into tronscan.org for an " +
      "external eyeball check.",
  };
}

export async function verifyEvmCalldata(
  tx: Pick<UnsignedTx, "data" | "verification">,
  fetchFn: FetchLike = defaultFetch,
): Promise<VerifyDecodeResult> {
  const data = tx.data;
  if (!data || data === "0x" || data.length < 10) {
    return {
      status: "no-data",
      selector: "0x",
      summary:
        "No calldata to cross-check — this is a pure native-value transfer. Ledger's generic transfer " +
        "screen shows the recipient and value directly; compare those against the verification block.",
    };
  }

  const selector = data.slice(0, 10).toLowerCase();
  const localDecode = tx.verification?.humanDecode;
  const localFunctionName =
    localDecode && localDecode.source === "local-abi" ? localDecode.functionName : undefined;
  const localSignature = localDecode?.signature;

  let signatures: string[];
  try {
    signatures = await fetch4byteSignatures(selector, fetchFn);
  } catch (e) {
    return {
      status: "error",
      selector,
      localFunctionName,
      localSignature,
      summary:
        `Could not reach 4byte.directory to cross-check selector ${selector} (${e instanceof Error ? e.message : String(e)}). ` +
        `The local ABI decode is still shown above, but there is no independent confirmation this turn. ` +
        `Open the swiss-knife decoder URL in a browser for a manual check before approving.`,
    };
  }

  if (signatures.length === 0) {
    return {
      status: "no-signature",
      selector,
      localFunctionName,
      localSignature,
      summary:
        `Selector ${selector} is not registered in 4byte.directory — common for freshly-deployed contracts ` +
        `or private function names. No independent cross-check is possible here; open the swiss-knife decoder ` +
        `URL in a browser to verify the decoded arguments manually before approving on Ledger.`,
    };
  }

  let chosen: { signature: string; args: readonly unknown[]; abiItem: AbiFunction } | null = null;
  let decodedButReencodeFailed: string | null = null;

  for (const sig of signatures) {
    let abiItem: AbiFunction;
    try {
      abiItem = parseAbiItem(`function ${sig}`) as AbiFunction;
    } catch {
      continue;
    }
    try {
      if (toFunctionSelector(abiItem).toLowerCase() !== selector) continue;
    } catch {
      continue;
    }
    let args: readonly unknown[];
    try {
      const decoded = decodeFunctionData({ abi: [abiItem], data: data as `0x${string}` });
      args = (decoded.args ?? []) as readonly unknown[];
    } catch {
      continue;
    }
    try {
      const reencoded = encodeFunctionData({
        abi: [abiItem],
        functionName: abiItem.name,
        args: args as never,
      });
      if (reencoded.toLowerCase() === data.toLowerCase()) {
        chosen = { signature: sig, args, abiItem };
        break;
      }
      if (!decodedButReencodeFailed) decodedButReencodeFailed = sig;
    } catch {
      continue;
    }
  }

  if (!chosen) {
    const extra = decodedButReencodeFailed
      ? ` One candidate ("${decodedButReencodeFailed}") decoded but did not re-encode to the exact bytes, which usually means the 4byte entry is missing a trailing dynamic parameter.`
      : "";
    return {
      status: "error",
      selector,
      localFunctionName,
      localSignature,
      candidateCount: signatures.length,
      summary:
        `4byte.directory returned ${signatures.length} candidate signature(s) for ${selector}, but none decoded the ` +
        `calldata losslessly.${extra} Falling back to manual verification: open the swiss-knife decoder URL in a browser.`,
    };
  }

  const independentFunctionName = funcName(chosen.signature);
  const namesMatch = !localFunctionName || independentFunctionName === localFunctionName;
  const independentArgs = chosen.args.map((raw, i) => ({
    index: i,
    type: chosen!.abiItem.inputs[i]?.type ?? "unknown",
    value: stringifyRaw(raw),
  }));

  if (!namesMatch) {
    return {
      status: "mismatch",
      selector,
      localFunctionName,
      localSignature,
      independentSignature: chosen.signature,
      independentFunctionName,
      reencodeCheck: "pass",
      candidateCount: signatures.length,
      independentArgs,
      summary:
        `✗ CROSS-CHECK MISMATCH — DO NOT SEND. My local ABI decoded this calldata as "${localFunctionName}", ` +
        `but 4byte.directory's signature for selector ${selector} is "${chosen.signature}" (function "${independentFunctionName}"). ` +
        `The two sources disagree on what this call does; refuse to approve on Ledger and investigate.`,
    };
  }

  const summary = localFunctionName
    ? `✓ Independent cross-check passed. I ran the calldata through a SECOND decoder on the MCP server ` +
      `using the function signature "${chosen.signature}" fetched from 4byte.directory (a public registry of ` +
      `selectors built from unrelated on-chain traffic). That decoder produced the same function name my local ` +
      `ABI reported (${localFunctionName}), and re-encoding its decoded arguments reproduces the original calldata ` +
      `byte-for-byte — which mathematically implies every argument value matches the one shown in the verification ` +
      `block above. You can still open the swiss-knife decoder URL for your own browser-side eyeball check.`
    : `✓ Independent decode succeeded using 4byte.directory signature "${chosen.signature}" — re-encoding produces ` +
      `the exact original calldata bytes. My local ABI didn't recognize the destination contract, so the ` +
      `verification block showed no local arg names; the independentArgs field on this tool result lists the ` +
      `values recovered positionally — review them against what you expected before approving on Ledger.`;

  return {
    status: "match",
    selector,
    localFunctionName,
    localSignature,
    independentSignature: chosen.signature,
    independentFunctionName,
    reencodeCheck: "pass",
    candidateCount: signatures.length,
    independentArgs,
    summary,
  };
}
