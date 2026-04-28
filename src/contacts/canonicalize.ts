/**
 * Minimal JCS-style canonicalization (RFC-8785) — enough for the
 * contacts blob schema, which only carries strings, integers, and
 * arrays of objects. Full RFC-8785 also handles non-integer numbers
 * (with ECMA-262 round-trip rules), null, and booleans; we stub those
 * out and fail-loud if they appear unexpectedly.
 *
 * Why not a full JCS lib: pulling a tightly-scoped 80-line helper
 * matches the existing tight-dep policy in this repo (`pLimitMap` etc.)
 * for one-off serialization needs. The contacts payload is fully
 * controlled by us — no exotic shapes — so the surface area we
 * actually exercise is small.
 *
 * Rules implemented (per RFC-8785 sections 3.2 + 3.4):
 *   - Object keys sorted in JS-string code-unit order (UTF-16 lex).
 *   - Strings escaped per JSON.stringify (which already follows the
 *     ECMA-262 string-encoding step the RFC defers to).
 *   - Integers serialized as their decimal representation.
 *   - Arrays preserved in input order.
 *   - No insignificant whitespace.
 *
 * NOT implemented (we don't use these shapes):
 *   - Floating-point normalization (would need IEEE-754 round-trip).
 *   - null / boolean (the schema doesn't carry them).
 *
 * Domain-prefix policy: this helper produces ONLY the canonical JSON
 * string. The `VaultPilot-contact-v1:` prefix is added at the
 * signing-helper layer (`src/signers/contacts/{btc,evm}.ts`), where it
 * lives next to the device call so a future reader sees the prefix and
 * the sign call together.
 */

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error(
      "canonicalize: null/undefined not supported in the contacts schema.",
    );
  }
  if (typeof value === "boolean") {
    throw new Error(
      "canonicalize: boolean not supported in the contacts schema.",
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(
        `canonicalize: only finite integers are supported (got ${value}).`,
      );
    }
    return value.toString(10);
  }
  if (typeof value === "string") {
    // JSON.stringify of a string returns a properly-escaped JSON
    // string literal — which matches RFC-8785's string-encoding step.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalize(v));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // JS default sort = UTF-16 code-unit order
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(
    `canonicalize: unsupported value type ${typeof value}.`,
  );
}

/**
 * Build the signing preimage for a per-chain blob. The `signature`
 * field is excluded from its own preimage (otherwise we'd have a
 * chicken-and-egg dep). Entry order is normalized: `entries` is
 * sorted by `label` ascending so that two callers ending up with the
 * same logical contact set produce identical signatures.
 */
/**
 * Per-entry shape that flows into the signing preimage. `intendedChains`
 * (issue #482) is optional — when absent on the source entry the field
 * is OMITTED from the preimage entirely (not serialized as `null` or
 * `[]`), so existing signed blobs without the field reproduce the same
 * canonical bytes they signed and continue to verify. Adding the field
 * is therefore additive: no schemaVersion bump, no migration.
 */
export interface PreimageEntry {
  label: string;
  address: string;
  addedAt: string;
  intendedChains?: ReadonlyArray<string>;
}

export interface SigningPreimage {
  chainId: string;
  version: number;
  anchorAddress: string;
  signedAt: string;
  entries: ReadonlyArray<PreimageEntry>;
}

export function buildSigningPreimage(args: {
  chainId: string;
  version: number;
  anchorAddress: string;
  signedAt: string;
  entries: ReadonlyArray<PreimageEntry>;
}): SigningPreimage {
  const sorted = [...args.entries].sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  );
  // Spread `intendedChains` ONLY when set on the source entry —
  // canonicalize() throws on undefined values, and we want byte-
  // equality with pre-#482 preimages on entries that don't carry
  // the tag.
  const projected: PreimageEntry[] = sorted.map((e) => ({
    label: e.label,
    address: e.address,
    addedAt: e.addedAt,
    ...(e.intendedChains !== undefined
      ? { intendedChains: e.intendedChains }
      : {}),
  }));
  return {
    chainId: args.chainId,
    version: args.version,
    anchorAddress: args.anchorAddress,
    signedAt: args.signedAt,
    entries: projected,
  };
}
