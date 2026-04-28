import { z } from "zod";
import {
  EVM_ADDRESS,
  TRON_ADDRESS,
  SOLANA_ADDRESS,
} from "../shared/address-patterns.js";

/**
 * Address-book schemas. Two-layer storage:
 *   - signed per-chain blobs (security-critical — entry → address bind)
 *   - unsigned `metadata` sidecar (low-stakes notes/tags joined by label)
 *
 * Each chain blob is signed with the user's paired Ledger key on that
 * chain. The signing message is JCS-canonicalized (RFC-8785) JSON of
 * `{ chainId, version, anchorAddress, signedAt, entries }` prefixed
 * with the hardwired domain tag `VaultPilot-contact-v1:`. Signature
 * verification on read fails hard (no silent fallback) when the file
 * is on a path that requires label resolution — see
 * `src/contacts/resolver.ts` for the scoped-abort behavior.
 *
 * v1.0 chains: BTC + EVM. Solana / TRON live in the schema as `null`
 * placeholders so adding them in v1.5 doesn't require a schema-version
 * bump — `add_contact({ chain: "solana" })` returns
 * `CONTACTS_CHAIN_NOT_YET_SUPPORTED` at the API layer.
 */

/** Chain identifiers used internally by the contacts schema. */
export const ContactChain = z.enum(["btc", "evm", "solana", "tron"]);
export type ContactChain = z.infer<typeof ContactChain>;

/** Per-chain anchor address types. EVM is just an address; BTC has format. */
export const BtcAnchorAddressType = z.enum([
  "legacy",
  "p2sh-segwit",
  "segwit",
]);
export type BtcAnchorAddressType = z.infer<typeof BtcAnchorAddressType>;

/** One entry inside a signed chain blob — label + address pair. */
export const SignedContactEntry = z.object({
  label: z.string().min(1).max(64),
  address: z.string().min(1).max(80),
  addedAt: z.string().datetime(),
});
export type SignedContactEntry = z.infer<typeof SignedContactEntry>;

/**
 * Per-chain blob. The `signature` field is excluded from its OWN
 * preimage (standard) — see `canonicalize.ts`.
 *
 * Per-chain blobs share the schema shape but interpret `anchorAddress`
 * differently: BTC carries `anchorAddressType` discriminating the
 * three legacy/p2sh-segwit/segwit message-signing formats; EVM
 * implies EIP-191 over a hex-encoded address.
 */
export const ChainBlob = z.object({
  /** Monotonic counter — bumped per mutation; replay/rollback protection. */
  version: z.number().int().positive(),
  /** User's paired anchor address that signed this blob. */
  anchorAddress: z.string(),
  /** BIP-32 leaf path of the anchor (BTC) or "m/44'/60'/0'/0/0" shape (EVM). */
  anchorPath: z.string(),
  /** BTC-only — discriminates the BIP-137 header byte family. Absent on EVM. */
  anchorAddressType: BtcAnchorAddressType.optional(),
  /** ISO-8601 of the most recent signing. */
  signedAt: z.string().datetime(),
  /** Sorted-by-label entries (sort enforced at canonicalize time). */
  entries: z.array(SignedContactEntry),
  /** Base64 BIP-137 (BTC) or 0x-prefixed hex EIP-191 (EVM). */
  signature: z.string().min(1),
});
export type ChainBlob = z.infer<typeof ChainBlob>;

/** Unsigned per-label metadata sidecar — notes, tags, createdAt. */
export const ContactMetadata = z.object({
  notes: z.string().max(500).optional(),
  tags: z.array(z.string().max(32)).max(16).optional(),
  createdAt: z.string().datetime(),
});
export type ContactMetadata = z.infer<typeof ContactMetadata>;

/** Top-level contacts-file schema. */
export const ContactsFile = z.object({
  schemaVersion: z.literal(1),
  chains: z.object({
    btc: ChainBlob.nullable(),
    evm: ChainBlob.nullable(),
    solana: ChainBlob.nullable(),
    tron: ChainBlob.nullable(),
  }),
  /** Label → metadata. Joined to entries at the API boundary. */
  metadata: z.record(z.string(), ContactMetadata),
});
export type ContactsFile = z.infer<typeof ContactsFile>;

/** Empty file shape used on first-write or after corruption recovery. */
export function emptyContactsFile(): ContactsFile {
  return {
    schemaVersion: 1,
    chains: { btc: null, evm: null, solana: null, tron: null },
    metadata: {},
  };
}

// ---------- MCP tool I/O schemas ----------

const labelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w\s.\-_'()]+$/u, {
    message:
      "Label may only contain word chars, spaces, dots, dashes, underscores, apostrophes, and parentheses.",
  })
  .describe(
    "Human-readable label, used to look up the contact by name in " +
      "every prepare flow. Must be unique within a chain — adding the " +
      "same label twice on the same chain replaces the address.",
  );

const addressSchema = z
  .string()
  .min(1)
  .max(80)
  .describe(
    "On-chain address. Validated against the chain's address regex at " +
      "call time; format mismatches reject before any device interaction.",
  );

export const addContactInput = z.object({
  chain: ContactChain.describe(
    "Which chain's blob to add to. v1.0 ships `btc` + `evm` only. " +
      "`solana` / `tron` return CONTACTS_CHAIN_NOT_YET_SUPPORTED.",
  ),
  label: labelSchema,
  address: addressSchema,
  notes: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Free-form note attached to the LABEL (joins across chains via the " +
        "metadata sidecar — same notes show up on `Mom`'s BTC and EVM rows). " +
        "Unsigned: tampering with notes does not redirect funds, but " +
        "the agent surfaces 'notes integrity unverified' alongside the " +
        "(verified) address.",
    ),
  tags: z
    .array(z.string().max(32))
    .max(16)
    .optional()
    .describe(
      "Free-form tags ('family', 'cex-deposit', etc.). Like notes — " +
        "stored in the unsigned metadata sidecar.",
    ),
});
export type AddContactArgs = z.infer<typeof addContactInput>;

export const removeContactInput = z.object({
  label: labelSchema,
  chain: ContactChain.optional().describe(
    "If specified, removes the label from THAT chain only. If omitted, " +
      "removes the label from EVERY chain that has it (one device " +
      "interaction per chain).",
  ),
});
export type RemoveContactArgs = z.infer<typeof removeContactInput>;

export const listContactsInput = z.object({
  chain: ContactChain.optional().describe(
    "If specified, only verifies + returns entries for that chain. " +
      "Otherwise returns the joined per-label view across all chains " +
      "with at least one verified entry.",
  ),
  label: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Filter to a specific label. Useful for 'show me what we know " +
        "about Mom' single-record reads.",
    ),
});
export type ListContactsArgs = z.infer<typeof listContactsInput>;

export const verifyContactsInput = z.object({
  chain: ContactChain.optional().describe(
    "If specified, only verifies that chain's blob. Otherwise verifies " +
      "every populated chain.",
  ),
});
export type VerifyContactsArgs = z.infer<typeof verifyContactsInput>;

// ---------- Output shapes ----------

/**
 * One row returned by `list_contacts` — a single label joined across
 * chains, with addresses keyed by chain. Issue #428: `unsigned` rows
 * exist when the user added a contact without a paired Ledger (the
 * in-memory fall-through path). Signed rows are signature-verified
 * before this row is built; unsigned rows have only address-format
 * validation and process-local persistence.
 */
export interface ListedContact {
  label: string;
  addresses: {
    btc?: string;
    evm?: string;
    solana?: string;
    tron?: string;
  };
  notes?: string;
  tags?: string[];
  /** Earliest `addedAt` across the joined chain entries. */
  addedAt: string;
  /**
   * `true` when at least one of the joined chain entries is unsigned
   * (in-memory only, no Ledger signature). Implies process-local
   * persistence (lost on restart) until #428's deferred state machine
   * lands a sign-on-pair upgrade flow.
   */
  unsigned?: boolean;
}

export interface VerifyResult {
  chain: ContactChain;
  ok: boolean;
  /** Present when ok=true; the verified anchor address used to sign. */
  anchorAddress?: string;
  /** Present when ok=true. */
  version?: number;
  /** Present when ok=true. */
  entryCount?: number;
  /** Reason for ok=false. Filled with the matching CONTACTS_* error code. */
  reason?: string;
  /**
   * Issue #428 — count of unsigned (in-memory) entries on this chain
   * that exist alongside (or instead of) the signed blob. Surfaced
   * separately so the agent can label them as not-anchored even when
   * the signed blob is empty or absent. Omitted when zero.
   */
  unsignedEntryCount?: number;
}

/** Stable error codes. Mirror the plan's named error symbols. */
export const ContactsError = {
  ChainNotYetSupported: "CONTACTS_CHAIN_NOT_YET_SUPPORTED",
  TaprootUnsupported: "CONTACTS_TAPROOT_UNSUPPORTED",
  LedgerNotPaired: "CONTACTS_LEDGER_NOT_PAIRED",
  DuplicateAddress: "CONTACTS_DUPLICATE_ADDRESS",
  Tampered: "CONTACTS_TAMPERED",
  AnchorMismatch: "CONTACTS_ANCHOR_MISMATCH",
  VersionRollback: "CONTACTS_VERSION_ROLLBACK",
  AddressFormatMismatch: "CONTACTS_ADDRESS_FORMAT_MISMATCH",
  LabelNotFound: "CONTACTS_LABEL_NOT_FOUND",
} as const;

/** Address-shape regexes per chain — used to validate `add_contact` inputs. */
export const CONTACT_ADDRESS_PATTERNS: Record<ContactChain, RegExp> = {
  btc: /^(bc1[a-z0-9]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  evm: EVM_ADDRESS,
  solana: SOLANA_ADDRESS,
  tron: TRON_ADDRESS,
};
