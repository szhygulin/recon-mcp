import { createHash } from "node:crypto";
import { TokenEnvelope, type TokenEnvelope as TokenEnvelopeT } from "./schemas.js";

/**
 * Token format: `vp1.<base64url(JSON envelope)>`. The `vp1.` prefix
 * identifies VaultPilot v1 tokens (versioning headroom for future
 * envelope changes) and lets a recipient's MCP recognize the format
 * without trial-decoding random strings.
 *
 * Plan: `claude-work/plan-readonly-advisor.md`. Model A — token is a
 * structured payload, NOT a secret in the cryptographic sense. Anyone
 * holding it can query the listed addresses, but anyone could query
 * those addresses without it (chain reads are public).
 */

const TOKEN_PREFIX = "vp1.";

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64Url(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

export function encodeToken(envelope: TokenEnvelopeT): string {
  // Validate before encoding — never emit a token whose payload would
  // fail to round-trip through `decodeToken`.
  TokenEnvelope.parse(envelope);
  const json = JSON.stringify(envelope);
  const b64 = toBase64Url(Buffer.from(json, "utf8"));
  return TOKEN_PREFIX + b64;
}

/**
 * Parse a token (with prefix) into its envelope. Throws on malformed
 * input. Does NOT check expiry — the caller decides whether to honor
 * an expired token (e.g. for forensic display in `list_readonly_invites`).
 */
export function decodeToken(raw: string): TokenEnvelopeT {
  if (!raw.startsWith(TOKEN_PREFIX)) {
    throw new Error(
      `Not a VaultPilot share token: missing '${TOKEN_PREFIX}' prefix. ` +
        `Tokens are issued by 'generate_readonly_link'.`,
    );
  }
  const b64 = raw.slice(TOKEN_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(b64).toString("utf8"));
  } catch (e) {
    throw new Error(
      `Share token is not valid base64url-encoded JSON (${e instanceof Error ? e.message : String(e)}). ` +
        `Make sure you copied the entire token, including the 'vp1.' prefix.`,
    );
  }
  return TokenEnvelope.parse(parsed);
}

/**
 * Accept either a raw token (`vp1.…`) or a URL containing the token
 * in a `?t=` / `&t=` query parameter or `#t=` hash fragment, and
 * return the raw token string. Used by `import_readonly_token` so the
 * caller can paste either form.
 */
export function extractToken(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith(TOKEN_PREFIX)) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Could not parse '${trimmed}' as a URL or share token.`);
    }
    const fromQuery = url.searchParams.get("t");
    if (fromQuery && fromQuery.startsWith(TOKEN_PREFIX)) return fromQuery;
    // Hash fragments (after #) aren't part of searchParams; parse manually.
    if (url.hash.length > 1) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      const fromHash = hashParams.get("t");
      if (fromHash && fromHash.startsWith(TOKEN_PREFIX)) return fromHash;
    }
    throw new Error(
      `URL did not contain a 't=vp1.…' parameter. Paste the raw token instead.`,
    );
  }
  throw new Error(
    `Input is neither a 'vp1.…' token nor an http(s) URL. Got '${trimmed.slice(0, 32)}…'.`,
  );
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export const EXPIRES_IN_MS: Record<"1h" | "24h" | "7d" | "30d", number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
