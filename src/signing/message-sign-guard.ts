import { createHash } from "node:crypto";

/**
 * Drainer-pattern refusal heuristic for `sign_message_btc` /
 * `sign_message_ltc` (issue #454).
 *
 * Adversarial smoke-test script a110 catalogued the failure modes
 * for on-device review: skim, line-1-only (Nano OLED scrolls and the
 * user reads the first frame), trust-the-agent, Unicode-confusable
 * substitution. Inv #8 raises the bar but terminates at the user's
 * eyes; for high-stakes message classes (proof-of-funds, custody-
 * transfer-shaped, exchange-deposit-prove) that's a structural HIGH
 * risk.
 *
 * The MCP-side refusal is the load-bearing defense: BIP-137 sign-
 * message produces a signature an attacker can later present as
 * evidence of consent. Refuse by design when the message text
 * contains drainer markers; no override flag — adding one would let
 * a rogue agent silently bypass exactly this defense, and the
 * message-text restriction is narrow enough that the user can
 * rephrase a legitimate proof-of-ownership statement to avoid the
 * trigger.
 *
 * Trade-off, documented: bare semantic markers (transfer, authorize,
 * grant, custody, release, consent) are noisy. A legitimate "I, the
 * owner, received a transfer ..." statement would refuse. The choice
 * here is strict-by-default per the issue's "outright" wording — if
 * false positives surface in practice, tune the regex in a follow-up.
 */

/**
 * Explicit drainer-template phrases — fixed-form attestations the
 * attacker chains into a phishing flow. Any single hit refuses the
 * sign call. Patterns are case-insensitive and anchored on word
 * boundaries so "I authorizer" (the dictionary word) doesn't fire,
 * but "I authorize" (start of a drainer template) does.
 */
const DRAINER_TEMPLATE_PHRASES: ReadonlyArray<RegExp> = [
  /\bI\s+authorize\b/i,
  /\bI\s+consent\s+to\b/i,
  /\bI\s+grant\b/i,
  /\bgranting\s+(?:full\s+)?custody\b/i,
  /\brelease\s+of\s+(?:all\s+)?funds\b/i,
  /\btransfer\s+(?:all\s+)?funds\b/i,
  /\bauthorize\s+(?:transfer|release|custody)\b/i,
];

/**
 * Bare-word semantic markers. Looser than templates — a single
 * marker is a soft signal, but two or more co-occurring markers
 * indicate a high-risk class regardless of phrasing. "I am the
 * owner who received this transfer" trips a single marker only;
 * "I authorize the transfer of custody" trips three.
 */
const SEMANTIC_MARKERS: ReadonlyArray<RegExp> = [
  /\btransfer\b/i,
  /\bauthorize\b/i,
  /\bgrant\b/i,
  /\bcustody\b/i,
  /\brelease\b/i,
  /\bconsent\b/i,
];

/**
 * Bitcoin / Litecoin address regex covering the four address types
 * the Ledger BTC + LTC apps support: legacy (1.../L...), p2sh-segwit
 * (3.../M.../3...), segwit (bc1q.../ltc1q...), taproot (bc1p...).
 * Used to extract embedded addresses from the message body so the
 * caller can reject any address that isn't the user's signing wallet.
 *
 * Crude on purpose: this is a tripwire, not an address validator. If
 * the regex matches a legitimate non-address pattern in the body
 * (extremely rare given the prefix anchors), the message refuses and
 * the user rephrases — the cost of a false positive here is one
 * round-trip, the cost of a false negative is a signed drainer
 * attestation.
 */
const EMBEDDED_BTC_OR_LTC_ADDRESS = new RegExp(
  // segwit / taproot (bech32) — bc1, ltc1, prefix + payload
  "(?:(?:bc1|ltc1)[qp][023456789ac-hj-np-z]{38,87})" +
    "|" +
    // legacy / p2sh — base58, 25-34 chars, prefix 1 / 3 / L / M
    "(?:[13LM][a-km-zA-HJ-NP-Z1-9]{25,34})",
  "g",
);

export interface DrainerCheckArgs {
  wallet: string;
  message: string;
  /** Friendly tool name for the error message. */
  toolName: "sign_message_btc" | "sign_message_ltc";
}

/**
 * Throws when `message` matches a drainer pattern. Caller invokes
 * BEFORE the device prompt so the refusal is silent (no hardware
 * round-trip wasted).
 */
export function refuseIfDrainerLike(args: DrainerCheckArgs): void {
  // Template phrases — any single hit refuses.
  for (const re of DRAINER_TEMPLATE_PHRASES) {
    const match = args.message.match(re);
    if (match) {
      throw new Error(
        `Refusing to sign — message contains drainer-template phrase: ` +
          `"${match[0]}". BIP-137 message-sign on this server is restricted to ` +
          `proof-of-ownership flows (your own address + a challenge nonce). ` +
          `Phrases like "I authorize" / "I consent to" / "granting custody" ` +
          `produce signatures attackers can later present as evidence of ` +
          `consent. Rephrase to drop the trigger phrase, or use a different ` +
          `signing path if you genuinely need to sign this exact text. ` +
          `(${args.toolName} drainer-template guard, issue #454)`,
      );
    }
  }

  // Semantic markers — refuse on 2+ co-occurring matches. A single
  // bare word is too noisy to refuse on alone (legitimate "I, the
  // owner, received a transfer ..." trips one); two or more is a
  // high-risk class regardless of exact phrasing.
  const markerHits: string[] = [];
  for (const re of SEMANTIC_MARKERS) {
    const m = args.message.match(re);
    if (m) markerHits.push(m[0]);
  }
  if (markerHits.length >= 2) {
    throw new Error(
      `Refusing to sign — message contains multiple drainer-pattern semantic ` +
        `markers (${markerHits.join(", ")}). Proof-of-ownership messages ` +
        `typically use "own" / "control", not multiple action verbs. Rephrase ` +
        `to remove the markers, or use a different signing path if you ` +
        `genuinely need to sign this exact text. (${args.toolName} ` +
        `semantic-marker guard, issue #454)`,
    );
  }

  // Embedded addresses — refuse when the body contains an address
  // that isn't the user's signing wallet. Heuristic per the issue:
  // "addresses appearing in proof-of-ownership messages should be
  // the user's own". Strict by intent — if the user has multiple
  // addresses to attest to, sign separately from each.
  const matches = args.message.matchAll(EMBEDDED_BTC_OR_LTC_ADDRESS);
  for (const m of matches) {
    const addr = m[0];
    if (addr !== args.wallet) {
      throw new Error(
        `Refusing to sign — message embeds an external address (${addr}) ` +
          `that is not your signing wallet (${args.wallet}). Proof-of-` +
          `ownership messages typically embed your own address; embedding ` +
          `someone else's is the canonical phishing-attestation pattern. ` +
          `If you need to attest to multiple addresses you control, sign ` +
          `from each address separately (one ${args.toolName} call per ` +
          `address). (drainer-pattern guard, issue #454)`,
      );
    }
  }
}

/**
 * Per issue #454 part (a) — return the SHA-256 of the exact UTF-8
 * bytes the agent submitted to the device, so the caller surfaces it
 * to the user alongside the verbatim message string. The user
 * confirms the on-device text matches the displayed text; the SHA
 * is a secondary anchor that survives Unicode-confusable substitution
 * (e.g. em-dash vs hyphen, Cyrillic А vs Latin A) — the bytes
 * differ, so the SHA differs, even when the rendering looks identical.
 */
export function messageBytesSha256(message: string): string {
  return (
    "0x" +
    createHash("sha256").update(Buffer.from(message, "utf-8")).digest("hex")
  );
}
