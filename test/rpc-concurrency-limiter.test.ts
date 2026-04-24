/**
 * Issue #88 continuation: a multi-wallet portfolio fan-out produced
 * 100+ simultaneous RPC requests per chain, exhausting free-tier
 * endpoints (Infura/Alchemy) regardless of retry tuning. This test pins
 * the per-chain concurrency limiter that caps in-flight requests at
 * `VAULTPILOT_RPC_CONCURRENCY` (default 4).
 *
 * Verifies the semaphore at the public-client layer by observing the
 * instantaneous in-flight count during a bulk `Promise.all` of reads:
 * the count must never exceed the cap, regardless of how many callers
 * pile on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("per-chain RPC concurrency limiter (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.VAULTPILOT_RPC_CONCURRENCY;
  });

  it("caps instantaneous in-flight fetch count at the configured limit, regardless of fan-out", async () => {
    // Set an easy-to-observe cap of 3 so the assertion is loud.
    process.env.VAULTPILOT_RPC_CONCURRENCY = "3";

    let inFlight = 0;
    let peakInFlight = 0;
    // Intercept the global fetch viem's http transport uses. Each
    // "request" holds the slot for ~10ms before resolving, so a tight
    // Promise.all of 20 reads MUST see at least one moment where the
    // limiter gates the next slot.
    const fetchMock = vi.fn(async () => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // Force the user-config to NOT fall back to "no RPC" so getClient
    // resolves cleanly against a stub URL. The chains module's resolver
    // will accept an env-var URL under any recognized chain name.
    process.env.ETHEREUM_RPC_URL = "https://stub.example/eth-rpc";

    const { getClient } = await import("../src/data/rpc.js");
    const client = getClient("ethereum");

    // Fire 20 reads at once. getChainId is a simple no-arg RPC — it goes
    // through the wrapped transport exactly once per call, making it a
    // clean probe of the semaphore.
    await Promise.all(Array.from({ length: 20 }, () => client.getChainId()));

    // The cap must hold: no more than 3 in flight at any moment.
    expect(peakInFlight).toBeLessThanOrEqual(3);
    expect(peakInFlight).toBeGreaterThan(0);
    // And we actually completed all 20 — the limiter queues, doesn't
    // drop.
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("uses separate per-chain semaphores (saturated mainnet does not throttle arbitrum)", async () => {
    process.env.VAULTPILOT_RPC_CONCURRENCY = "2";
    process.env.ETHEREUM_RPC_URL = "https://stub.example/eth";
    process.env.ARBITRUM_RPC_URL = "https://stub.example/arb";

    // Track per-URL in-flight counts; assertion: each URL's peak count
    // is bounded independently at 2.
    const perUrlInFlight = new Map<string, number>();
    const perUrlPeak = new Map<string, number>();
    const fetchMock = vi.fn(async (input: URL | string | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const cur = (perUrlInFlight.get(url) ?? 0) + 1;
      perUrlInFlight.set(url, cur);
      const prev = perUrlPeak.get(url) ?? 0;
      if (cur > prev) perUrlPeak.set(url, cur);
      await new Promise((r) => setTimeout(r, 10));
      perUrlInFlight.set(url, cur - 1);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getClient } = await import("../src/data/rpc.js");
    const eth = getClient("ethereum");
    const arb = getClient("arbitrum");
    await Promise.all([
      ...Array.from({ length: 10 }, () => eth.getChainId()),
      ...Array.from({ length: 10 }, () => arb.getChainId()),
    ]);

    // Peak per URL stays within the chain's own cap. If the limiter were
    // global (single shared semaphore), the first chain to fire 2 would
    // starve the other.
    for (const peak of perUrlPeak.values()) {
      expect(peak).toBeLessThanOrEqual(2);
    }
    // Both chains actually got scheduled concurrently — i.e. the two
    // limiters didn't serialize into each other. (Sum of peaks across
    // chains would be >2 if we saw any cross-chain concurrency.)
    const totalPeak = [...perUrlPeak.values()].reduce((a, b) => a + b, 0);
    expect(totalPeak).toBeGreaterThanOrEqual(3);
  });

  it("defaults to 4 concurrent when VAULTPILOT_RPC_CONCURRENCY is unset", async () => {
    delete process.env.VAULTPILOT_RPC_CONCURRENCY;
    process.env.ETHEREUM_RPC_URL = "https://stub.example/eth-default";

    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getClient } = await import("../src/data/rpc.js");
    const client = getClient("ethereum");
    await Promise.all(Array.from({ length: 15 }, () => client.getChainId()));

    // Default cap of 4; peak must be <= 4 and > 0.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });
});
