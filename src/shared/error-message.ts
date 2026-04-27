/**
 * Safely render an unknown thrown value as a human-readable string.
 *
 * The naive `error instanceof Error ? error.message : String(error)` pattern
 * (used by the txHandler wrapper in `src/index.ts` until issue #326) breaks
 * on errors whose `.message` is itself a structured object — common with
 * WalletConnect SDK errors (`{ code, message }` payloads), some viem
 * decoding errors, and a few protocol clients. Template-string
 * interpolation calls `Object.prototype.toString` and produces the
 * famously useless `"[object Object]"`.
 *
 * Live regression — issue #326, 2026-04-27 08:09 UTC: a WalletConnect
 * `eth_sendTransaction` retry surfaced as `Error: [object Object]`,
 * leaving the agent (and the user reading the agent's report) with no
 * idea what actually went wrong, which compounded the panic of the
 * adjacent retry-storm bug.
 *
 * Behavior:
 *   - `Error` with a non-empty string `.message` → the message
 *   - `Error` with an object `.message` → `<name>: <JSON-stringified>`,
 *     so the structured fields ({code, data, …}) are visible
 *   - Plain string → the string
 *   - Plain object → JSON-stringified (own props + a few common Error fields)
 *   - Anything else → `String(value)` as a last resort
 *
 * Stable, side-effect-free, no IO. Always returns a non-empty string.
 */
export function safeErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.length > 0 ? error : "Unknown error (empty string thrown)";
  }
  if (error === null || error === undefined) {
    return `Unknown error (${error === null ? "null" : "undefined"} thrown)`;
  }
  if (error instanceof Error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0 && message !== "[object Object]") {
      return message;
    }
    // .message was an object, empty, or already the stringification bug —
    // surface the structured fields. Walking own properties catches
    // SDK-thrown errors that attach `code`, `data`, `cause`, etc.
    const detail = stringifyOwnProps(error);
    const name = (error.name && typeof error.name === "string") ? error.name : "Error";
    return detail.length > 0 ? `${name}: ${detail}` : name;
  }
  if (typeof error === "object") {
    const detail = stringifyOwnProps(error);
    return detail.length > 0 ? detail : Object.prototype.toString.call(error);
  }
  return String(error);
}

/**
 * Render the most useful properties of an object to JSON. Surfaces
 * non-enumerable Error props (`name`, `message`, `code`) that
 * `JSON.stringify` would otherwise drop, while skipping `stack`
 * (carries V8 trace noise that often includes the literal
 * `"[object Object]"` from the throw site and would defeat the
 * cleanup). Returns "" when nothing useful is available.
 *
 * Implementation note: builds a plain enumerable copy first, THEN
 * JSON.stringifies it. An earlier attempt used the JSON.stringify
 * array-filter form (`JSON.stringify(value, namesArray)`) — that
 * filters AT EVERY NESTING LEVEL, which strips nested object internals
 * (e.g. `message.code` when `code` isn't in the outer Error's name
 * list). The plain-copy approach lets default recursion handle nested
 * shapes naturally.
 */
function stringifyOwnProps(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const flat: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value as object)) {
    if (name === "stack") continue;
    flat[name] = (value as Record<string, unknown>)[name];
  }
  for (const k of Object.keys(value as object)) {
    if (k in flat || k === "stack") continue;
    flat[k] = (value as Record<string, unknown>)[k];
  }
  if (Object.keys(flat).length === 0) return "";
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(flat, (_key, v) => {
      if (typeof v === "function") return undefined;
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) {
        return { name: v.name, message: typeof v.message === "string" ? v.message : v.message };
      }
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return "";
  }
}
