/**
 * Issue #88 / PR #96 continuation: Morpho Blue discovery is now opt-in via
 * VAULTPILOT_MORPHO_DISCOVERY env var. Default OFF because the event-log
 * scan dominated Infura rate-limit pressure in multi-wallet portfolio
 * fan-outs (6-minute hangs with aggressive retry). Explicit `marketIds`
 * remain the always-available fast path regardless of the env var.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";

describe("getMorphoPositions — opt-in discovery (#88)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_MORPHO_DISCOVERY;
  });

  it("returns discoverySkipped: true (no RPC calls) when the env var is unset and no explicit marketIds are passed", async () => {
    const discover = vi.fn();
    vi.doMock("../src/modules/morpho/discover.js", () => ({
      discoverMorphoMarketIds: discover,
    }));
    // RPC module still gets imported but should never be invoked on this
    // path — assert via the spy on discoverMorphoMarketIds.
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => {
        throw new Error("no RPC client expected on opt-out path");
      },
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getMorphoPositions } = await import(
      "../src/modules/morpho/index.js"
    );
    const r = await getMorphoPositions({ wallet: WALLET, chain: "ethereum" });
    expect(r.positions).toEqual([]);
    expect(r.discoverySkipped).toBe(true);
    expect(discover).not.toHaveBeenCalled();
  });

  it("runs discovery when VAULTPILOT_MORPHO_DISCOVERY=1", async () => {
    process.env.VAULTPILOT_MORPHO_DISCOVERY = "1";
    const discover = vi.fn().mockResolvedValue([]);
    vi.doMock("../src/modules/morpho/discover.js", () => ({
      discoverMorphoMarketIds: discover,
    }));
    const { getMorphoPositions } = await import(
      "../src/modules/morpho/index.js"
    );
    const r = await getMorphoPositions({ wallet: WALLET, chain: "ethereum" });
    expect(r.positions).toEqual([]);
    expect(r.discoverySkipped).toBeUndefined();
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith(WALLET, "ethereum");
  });

  it("always honors explicit marketIds, even without the env var (fast path stays open)", async () => {
    delete process.env.VAULTPILOT_MORPHO_DISCOVERY;
    const discover = vi.fn();
    vi.doMock("../src/modules/morpho/discover.js", () => ({
      discoverMorphoMarketIds: discover,
    }));
    // Make the multicall throw so readMarketPosition rejects — the test
    // doesn't care about the position-read pipeline, only about the
    // pre-read dispatch decision (did we call discover, or go straight to
    // the explicit marketId read?). The catch-all in Promise.all's caller
    // would propagate the error; we just await+expect it.
    const multicall = vi.fn().mockRejectedValue(new Error("stub"));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ multicall }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    const { getMorphoPositions } = await import(
      "../src/modules/morpho/index.js"
    );
    const call = getMorphoPositions({
      wallet: WALLET,
      chain: "ethereum",
      marketIds: [
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ],
    });
    // The read may reject; what matters is that we attempted it (went past
    // the dispatch branch) rather than short-circuiting on discoverySkipped.
    await expect(call).rejects.toThrow();
    // Core contract: explicit marketIds bypass the discovery opt-in gate.
    expect(discover).not.toHaveBeenCalled();
    expect(multicall).toHaveBeenCalled();
  });
});
