import { z } from "zod";
import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

/**
 * Read-only advisor / share tokens — Zod schemas for the four MCP tools and
 * the on-disk invite store.
 *
 * Model A (v1): token is a base64url-encoded envelope. Recipient queries
 * the wallets via their own RPCs; revocation is issuer-side bookkeeping
 * with no enforcement (anyone can query any address on chain — the token
 * is a structured way to convey intent, not a security boundary). Plan:
 * `claude-work/plan-readonly-advisor.md`.
 */

/** BTC mempool/explorer-style address — matches `CONTACT_ADDRESS_PATTERNS.btc`. */
const BTC_ADDRESS = /^(bc1[a-z0-9]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

/**
 * Wallet bundle the issuer is sharing. At least one chain must be
 * non-empty. Each chain's array must be non-empty when present —
 * `evm: []` is meaningless and likely a mistake by the caller.
 */
export const ShareWallets = z
  .object({
    evm: z.array(z.string().regex(EVM_ADDRESS)).min(1).optional(),
    tron: z.array(z.string().regex(TRON_ADDRESS)).min(1).optional(),
    solana: z.array(z.string().regex(SOLANA_ADDRESS)).min(1).optional(),
    btc: z.array(z.string().regex(BTC_ADDRESS)).min(1).optional(),
  })
  .refine(
    (w) => Boolean(w.evm || w.tron || w.solana || w.btc),
    "At least one chain (evm / tron / solana / btc) must be provided",
  );
export type ShareWallets = z.infer<typeof ShareWallets>;

/**
 * Allowed scopes. v1 only ships `read-portfolio` — `read-portfolio+history`
 * is reserved for when an explicit history scope is needed (see plan §Scope).
 * Recipient enforces nothing in Model A; scopes are advisory only.
 */
export const ShareScope = z.enum(["read-portfolio"]);
export type ShareScope = z.infer<typeof ShareScope>;

export const ShareExpiresIn = z.enum(["1h", "24h", "7d", "30d"]);
export type ShareExpiresIn = z.infer<typeof ShareExpiresIn>;

/**
 * Identifier for a stored invite. Friendly name the user picked at
 * generate time (or the auto-assigned `share-XXXX` default). Used as
 * the lookup key for `revoke_readonly_invite`.
 */
const ShareName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "name must be 1-64 chars of [a-zA-Z0-9._-]");

// ----- Tool input schemas ---------------------------------------------------

export const generateReadonlyLinkInput = z.object({
  wallets: ShareWallets,
  scope: ShareScope.default("read-portfolio"),
  expiresIn: ShareExpiresIn.default("24h"),
  name: ShareName.optional(),
});
export type GenerateReadonlyLinkInput = z.infer<typeof generateReadonlyLinkInput>;

export const importReadonlyTokenInput = z.object({
  /**
   * Raw token (`vp1.<base64url>`) or a URL containing the token in a
   * `?t=` / `&t=` query parameter / hash fragment. Auto-detected by the
   * leading `http(s)://`.
   */
  token: z.string().min(1),
});
export type ImportReadonlyTokenInput = z.infer<typeof importReadonlyTokenInput>;

export const listReadonlyInvitesInput = z.object({
  /**
   * Include revoked / expired entries in the listing. Default false —
   * the common case is "what's currently active".
   */
  includeInactive: z.boolean().default(false),
});
export type ListReadonlyInvitesInput = z.infer<typeof listReadonlyInvitesInput>;

export const revokeReadonlyInviteInput = z.object({
  name: ShareName,
});
export type RevokeReadonlyInviteInput = z.infer<typeof revokeReadonlyInviteInput>;

// ----- On-disk storage shape ------------------------------------------------

/**
 * One issuer-side record per invite. The raw token is NOT stored — only
 * its sha256 hash, so an attacker reading the invite file can't replay
 * the token elsewhere. The hash is cosmetic for Model A (no enforcement)
 * but lays groundwork for Model B's hosted-endpoint auth and matches
 * the password-style pattern called out in the plan.
 */
export const StoredInvite = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scope: ShareScope,
  wallets: ShareWallets,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  /** ms-since-epoch of revocation, or null if still valid. */
  revokedAt: z.number().int().nonnegative().nullable(),
});
export type StoredInvite = z.infer<typeof StoredInvite>;

export const ReadonlyInvitesFile = z.object({
  version: z.literal(1),
  invites: z.array(StoredInvite),
});
export type ReadonlyInvitesFile = z.infer<typeof ReadonlyInvitesFile>;

export function emptyInvitesFile(): ReadonlyInvitesFile {
  return { version: 1, invites: [] };
}

// ----- Token envelope (carried inside the base64url-encoded payload) --------

/**
 * The JSON object inside the token. Recipient parses this after
 * base64url-decode. Field names are short to keep tokens compact —
 * tokens are pasted by humans, so brevity matters more than clarity
 * (the structured form is exposed via the import response anyway).
 */
export const TokenEnvelope = z.object({
  v: z.literal(1),
  id: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  scope: ShareScope,
  name: z.string(),
  wallets: ShareWallets,
});
export type TokenEnvelope = z.infer<typeof TokenEnvelope>;
