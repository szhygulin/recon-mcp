/**
 * `resolveRecipient` — single shim used by every prepare flow before
 * address validation.
 *
 * Resolution order:
 *   1. Literal address (matches chain's address regex) → use directly.
 *      Then ATTEMPT a reverse-lookup in contacts to decorate with a
 *      label. On contacts tamper, silently skip the decoration and
 *      return a warning string in `warnings[]` — DON'T block the send.
 *
 *   2. Contact label match → MUST verify contacts signatures. On
 *      tamper → throw (CONTACTS_TAMPERED). The label-resolution path
 *      is the one place we abort hard, because resolving a label
 *      against a tampered list is exactly the phishing pattern this
 *      whole feature exists to prevent.
 *
 *   3. ENS / `.sol` (chain-appropriate) — for v1 ONLY ENS on EVM.
 *      `.sol` defers with the rest of Solana support to v1.5. If a
 *      contact ALSO matches the resolved address, contact wins
 *      (precedence rule: explicit user-curated > registry).
 *
 *   4. Unknown → fail with "could not resolve recipient".
 *
 * The critical correctness rule: abort-on-tamper is **scoped to the
 * label-resolution path only**. Sends to literal addresses and to
 * ENS still proceed when contacts are tampered, with a warning the
 * verification block hoists into the user-facing receipt.
 */
import { resolveName } from "../modules/balances/index.js";
import {
  CONTACT_ADDRESS_PATTERNS,
  type ContactChain,
} from "./schemas.js";
import {
  findDemoContactByLabel,
  findDemoContactByAddress,
} from "./demo-store.js";
import { isDemoMode } from "../demo/index.js";

export type ResolutionSource =
  | "literal"
  | "contact"
  | "ens"
  | "unknown";

export interface ResolvedRecipient {
  /** Final address that flows into the prepare builder. */
  address: string;
  source: ResolutionSource;
  /** Present when source ∈ {"contact"} or when reverse-decoration matched. */
  label?: string;
  /**
   * Free-form warnings the verification renderer hoists into the
   * receipt. Non-fatal — the send proceeds.
   */
  warnings: string[];
}

/**
 * Map prepare-flow chain identifiers to the contacts module's
 * ContactChain enum. Prepare flows use SupportedChain (ethereum /
 * arbitrum / etc.) for EVM and per-chain literals (`bitcoin`, `tron`,
 * `solana`) for non-EVM. The address book is one-blob-per-chain-class
 * so every EVM chain shares the `evm` blob.
 */
function chainToContactChain(chain: string): ContactChain | null {
  if (chain === "bitcoin" || chain === "btc") return "btc";
  if (chain === "litecoin" || chain === "ltc") return null; // contacts don't cover LTC in v1
  if (chain === "tron") return "tron";
  if (chain === "solana") return "solana";
  // EVM — anything else falls into the evm blob.
  return "evm";
}

/**
 * Returns true when `input` looks like a literal address for the
 * given chain class. Prepare flows already do their own validation
 * downstream; this is just the resolver's "is the user pasting an
 * address vs. a label?" disambiguation.
 */
function looksLikeLiteralAddress(input: string, chain: ContactChain): boolean {
  return CONTACT_ADDRESS_PATTERNS[chain].test(input);
}

/**
 * Reverse-lookup outcome. Three states:
 *   - `match`: blob verified AND a saved entry matched the address.
 *   - `noMatch`: blob verified, but no saved entry matched.
 *   - `tampered`: blob present on disk but failed verification —
 *     the caller hoists a warning instead of silently skipping.
 *   - `noBlob`: no blob persisted yet — silently skip (no decoration).
 */
type ReverseLookupResult =
  | { state: "match"; label: string }
  | { state: "noMatch" }
  | { state: "tampered" }
  | { state: "noBlob" };

async function reverseLookup(
  chain: "btc" | "evm",
  addr: string,
): Promise<ReverseLookupResult> {
  // Distinguish "no blob" (file empty / chain absent) from "tampered"
  // (file present but verification failed). For "tampered" we want a
  // warning; for "no blob" we silently skip.
  const { readContactsStrict } = await import("./storage.js");
  const { verifyBtcBlob, verifyEvmBlob } = await import("./verify.js");
  let file;
  try {
    file = readContactsStrict();
  } catch {
    return { state: "tampered" };
  }
  const blob = file.chains[chain];
  if (!blob) return { state: "noBlob" };
  const ok = chain === "btc" ? verifyBtcBlob(blob) : await verifyEvmBlob(blob);
  if (!ok) return { state: "tampered" };
  const target = chain === "evm" ? addr.toLowerCase() : addr;
  for (const entry of blob.entries) {
    const candidate = chain === "evm" ? entry.address.toLowerCase() : entry.address;
    if (candidate === target) return { state: "match", label: entry.label };
  }
  return { state: "noMatch" };
}

/**
 * Forward-lookup: scan the verified blob for `entry.label === label`.
 * Throws CONTACTS_TAMPERED via the inner verifier when the file is
 * tampered (NOT silent — this is the abort path).
 */
async function forwardLookup(
  chain: "btc" | "evm",
  label: string,
): Promise<string | null> {
  // Use a STRICT read here so tamper aborts (matches the plan).
  // tryReadVerifiedBlob silently returns null on tamper, which is
  // the wrong shape for label resolution — we want to know.
  const { readContactsStrict } = await import("./storage.js");
  const { ContactsError } = await import("./schemas.js");
  const file = readContactsStrict();
  const blob = file.chains[chain];
  if (!blob) return null;
  // Verify; throw the matching CONTACTS_* error on failure.
  const { verifyBtcBlob, verifyEvmBlob } = await import("./verify.js");
  const ok = chain === "btc" ? verifyBtcBlob(blob) : await verifyEvmBlob(blob);
  if (!ok) {
    throw new Error(
      `${ContactsError.Tampered}: ${chain} contacts blob signature invalid; ` +
        `cannot resolve label "${label}" — refusing to risk a phishing-redirect.`,
    );
  }
  const hit = blob.entries.find((e) => e.label === label);
  return hit ? hit.address : null;
}

export async function resolveRecipient(
  input: string,
  chain: string,
): Promise<ResolvedRecipient> {
  const cc = chainToContactChain(chain);
  // Chains the contacts module doesn't index (LTC) → literal-only.
  if (!cc) {
    return { address: input, source: "literal", warnings: [] };
  }

  // Demo mode: lookups go against the in-memory demo store. There's
  // no signed blob so no tamper path — every match is a clean
  // resolution (or a no-match → fall through to literal/ENS). The
  // demo store covers all four chains (btc/evm/solana/tron) by
  // design, vs. production v1's btc+evm-only resolver.
  if (isDemoMode()) {
    if (looksLikeLiteralAddress(input, cc)) {
      const label = findDemoContactByAddress(cc, input);
      return label
        ? { address: input, source: "literal", label, warnings: [] }
        : { address: input, source: "literal", warnings: [] };
    }
    const labelHit = findDemoContactByLabel(cc, input);
    if (labelHit) {
      return {
        address: labelHit,
        source: "contact",
        label: input,
        warnings: [],
      };
    }
    // Fall through to ENS for EVM (.eth lookups still work in demo
    // since they hit mainnet RPC, which is real-mode-equivalent).
    if (cc === "evm" && input.includes(".") && /\.[a-z0-9]+$/.test(input)) {
      try {
        const ens = await resolveName({ name: input });
        if (ens.address) {
          const reverseLabel = findDemoContactByAddress("evm", ens.address);
          return {
            address: ens.address,
            source: "ens",
            ...(reverseLabel ? { label: reverseLabel } : {}),
            warnings: [],
          };
        }
      } catch {
        // Fall through to "unknown".
      }
    }
    return { address: input, source: "unknown", warnings: [] };
  }

  const warnings: string[] = [];

  // (1) Literal address: pass through, optionally decorated with a
  // reverse-lookup label.
  if (looksLikeLiteralAddress(input, cc)) {
    if (cc === "btc" || cc === "evm") {
      const r = await reverseLookup(cc, input);
      if (r.state === "match") {
        return {
          address: input,
          source: "literal",
          label: r.label,
          warnings,
        };
      }
      if (r.state === "tampered") {
        warnings.push(
          "contacts file failed verification — recipient label not checked",
        );
      }
    }
    return { address: input, source: "literal", warnings };
  }

  // (2) Contact label match. STRICT verify — tamper aborts.
  if (cc === "btc" || cc === "evm") {
    const labelHit = await forwardLookup(cc, input);
    if (labelHit) {
      return {
        address: labelHit,
        source: "contact",
        label: input,
        warnings,
      };
    }
  }

  // (3) ENS — EVM only in v1. v1.5 will route `.sol` here too.
  if (cc === "evm" && input.includes(".") && /\.[a-z0-9]+$/.test(input)) {
    try {
      const ens = await resolveName({ name: input });
      if (ens.address) {
        // Reverse-decorate the ENS hit if a contact matches the same
        // address (contact-wins precedence rule, but only when
        // contacts verify cleanly).
        const r = await reverseLookup("evm", ens.address);
        let label: string | undefined;
        if (r.state === "match") label = r.label;
        else if (r.state === "tampered") {
          warnings.push(
            "contacts file failed verification — ENS reverse-decoration skipped",
          );
        }
        return {
          address: ens.address,
          source: "ens",
          ...(label ? { label } : {}),
          warnings,
        };
      }
    } catch {
      // ENS lookup itself failed — fall through to "unknown".
    }
  }

  // (4) Unknown.
  return { address: input, source: "unknown", warnings };
}
