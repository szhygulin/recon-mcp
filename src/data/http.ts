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

/**
 * Bounded-concurrency variant of `Promise.allSettled`. Walks `items`
 * with at most `concurrency` in-flight tasks at a time, preserving
 * the input order in the result array. Rejected tasks become
 * `{ status: "rejected", reason }` entries — a single failure never
 * aborts the rest of the batch.
 *
 * Why not pull `p-limit` as a dep: ~30 lines of native JS gets the
 * job done, and our hot-path callers (BTC indexer fan-out for
 * `rescan_btc_account` / `get_btc_account_balance`) want a tight
 * dependency surface around code that runs against user wallets.
 *
 * Worker-pool pattern: spin up min(items.length, concurrency) async
 * workers, each pulling the next index from a shared cursor until the
 * input is drained. Slot results back into the output array by their
 * original index so callers can zip with the input.
 */
export async function pLimitMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`pLimitMap: concurrency must be a positive integer, got ${concurrency}`);
  }
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          try {
            const value = await fn(items[i], i);
            results[i] = { status: "fulfilled", value };
          } catch (reason) {
            results[i] = { status: "rejected", reason };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
