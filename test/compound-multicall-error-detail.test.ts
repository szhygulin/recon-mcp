/**
 * Issue #88 root cause (Compound L2 branch): the thrown error when
 * multicall reports per-call failures used to say only
 * `"<chain>:<market> — baseToken, balanceOf, borrowBalanceOf read failed
 * on a curated-registry market"` — opaque about whether the failure was
 * a revert, an HTTP 429, or an ABI decode problem. viem's allowFailure
 * multicall populates `error` on each failure entry; we now splice that
 * message into the thrown error so the aggregator surfaces it via
 * `coverage.compound.note`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";

describe("getCompoundPositions — per-call multicall error propagation (#88)", () => {
  beforeEach(() => {
    vi.resetModules();
    // Bypass the exposure probe so these tests directly exercise
    // readMarketPosition's error-propagation logic. The probe-first flow
    // is tested separately in compound-probe.test.ts.
    process.env.VAULTPILOT_COMPOUND_FULL_READ = "1";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_COMPOUND_FULL_READ;
  });

  it("splices the underlying multicall error message into the thrown error", async () => {
    // Simulate the exact scenario from issue #88's trace: multicall's
    // per-call results carry HTTP 429 errors for the three position-critical
    // calls. Previously this threw an opaque "read failed" string; now the
    // `(HTTP request failed. Status: 429)` detail must ride along so the
    // aggregator surfaces it.
    const rateLimitErr = new Error("HTTP request failed. Status: 429");
    (rateLimitErr as { shortMessage?: string }).shortMessage =
      "HTTP request failed. Status: 429";
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        multicall: vi.fn().mockResolvedValue([
          { status: "failure", error: rateLimitErr, result: undefined },
          { status: "success", result: 0n },
          { status: "failure", error: rateLimitErr, result: undefined },
          { status: "failure", error: rateLimitErr, result: undefined },
        ]),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));

    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });

    expect(r.errored).toBe(true);
    expect(r.erroredMarkets).toBeDefined();
    const arbEntry = r.erroredMarkets!.find((e) => e.chain === "arbitrum");
    expect(arbEntry).toBeDefined();
    // The per-call error text is surfaced alongside each failing call name.
    expect(arbEntry!.error).toMatch(/baseToken\(HTTP request failed\. Status: 429\)/);
    expect(arbEntry!.error).toMatch(/balanceOf\(HTTP request failed\. Status: 429\)/);
    expect(arbEntry!.error).toMatch(/borrowBalanceOf\(HTTP request failed\. Status: 429\)/);
    // The shape hint for the agent ("curated-registry market") is preserved
    // so existing downstream parsing stays stable.
    expect(arbEntry!.error).toContain("curated-registry market");
  });

  it("truncates very long underlying error strings so the aggregator's note stays readable", async () => {
    const giant = new Error("x".repeat(500));
    (giant as { shortMessage?: string }).shortMessage = "x".repeat(500);
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        multicall: vi.fn().mockResolvedValue([
          { status: "failure", error: giant, result: undefined },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
        ]),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    const arbEntry = r.erroredMarkets!.find((e) => e.chain === "arbitrum")!;
    // 500-char message must not appear untruncated — ellipsis marker present.
    expect(arbEntry.error).not.toContain("x".repeat(500));
    expect(arbEntry.error).toMatch(/…/);
  });

  it("falls back gracefully when viem's failure entry has no error property", async () => {
    // Defensive branch: if some future viem version changes the failure
    // shape, we should still throw a coherent message rather than
    // propagating `undefined`.
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        multicall: vi.fn().mockResolvedValue([
          { status: "failure", result: undefined }, // no `error` field
          { status: "success", result: 0n },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
        ]),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getCompoundPositions } = await import(
      "../src/modules/compound/index.js"
    );
    const r = await getCompoundPositions({
      wallet: WALLET,
      chains: ["arbitrum"],
    });
    const arbEntry = r.erroredMarkets!.find((e) => e.chain === "arbitrum")!;
    expect(arbEntry.error).toContain("baseToken(unknown)");
  });
});
