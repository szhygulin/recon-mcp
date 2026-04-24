/**
 * `fetch` with a wall-clock timeout via `AbortController`.
 *
 * Every outbound call to a third-party API — Jupiter, 1inch, LiFi, TronGrid,
 * DefiLlama, Etherscan, 4byte, etc. — goes through here so a single misbehaving
 * upstream (BGP hijack, DNS MITM, compromised provider that accepts the TCP
 * connection but never sends a body) can't stall the MCP process indefinitely.
 * `node` / `undici`'s `fetch` has no default timeout; without this wrapper a
 * hung socket blocks the event-loop task handling the caller's MCP tool call
 * until the whole process is torn down.
 *
 * Per-caller timeout defaults to 10 s — comfortable for the observed p99 on
 * the APIs we hit, short enough that a dead upstream fails fast and the
 * agent can retry or surface the error.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
