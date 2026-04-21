import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTronNativeSend } from "../src/modules/tron/actions.js";
import { encodeTransferRawData } from "./helpers/tron-raw-data-encode.js";

/**
 * Pre-flight bandwidth check. On-chain rule (java-tron
 * BandwidthProcessor.consume): tx must fit entirely in STAKED pool OR
 * entirely in FREE pool — pools do not combine. If neither pool covers,
 * TronGrid burns the FULL tx byte length at 1000 sun/byte from liquid
 * TRX. If that too is insufficient, broadcast rejects post-signature
 * with `BANDWITH_ERROR` (sic). This pre-flight catches that failure
 * mode at prepare time.
 *
 * Regression context: an earlier implementation summed free + staked and
 * used a shortfall-based burn estimate. That let a real vote-cast flow
 * slip through — an account with 121 free + 102 staked + ~0.1 TRX
 * passed the (buggy) preflight but then failed the actual broadcast
 * because neither pool individually covers a ~230-byte tx and the real
 * burn is full-tx × 1000 sun (~0.23 TRX), not shortfall × 1000.
 */

const ADDR_FROM = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const ADDR_TO = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";

type ResourceFixture = {
  freeNetUsed?: number;
  freeNetLimit?: number;
  NetUsed?: number;
  NetLimit?: number;
};

function stubFetch(opts: { resources: ResourceFixture; balanceSun: number }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "https://api.trongrid.io/wallet/getaccountresource") {
      return new Response(JSON.stringify(opts.resources), { status: 200 });
    }
    if (url === "https://api.trongrid.io/wallet/getaccount") {
      return new Response(JSON.stringify({ balance: opts.balanceSun }), { status: 200 });
    }
    if (url === "https://api.trongrid.io/wallet/createtransaction") {
      return new Response(
        JSON.stringify({
          txID: "aa".repeat(32),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeTransferRawData({
            from: ADDR_FROM,
            to: ADDR_TO,
            amountSun: 1_000_000n,
          }),
          visible: true,
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TRON bandwidth pre-flight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws with an actionable message when no pool covers and TRX is insufficient", async () => {
    stubFetch({
      resources: { freeNetLimit: 0, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 },
      balanceSun: 0,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/Insufficient bandwidth.*BANDWITH_ERROR/s);
  });

  it("passes when the FREE pool alone covers the tx (even with zero staked and zero TRX)", async () => {
    stubFetch({
      resources: { freeNetLimit: 5000, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 },
      balanceSun: 0,
    });
    const tx = await buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" });
    expect(tx.action).toBe("native_send");
  });

  it("passes when the STAKED pool alone covers the tx", async () => {
    stubFetch({
      resources: { freeNetLimit: 0, freeNetUsed: 0, NetLimit: 5000, NetUsed: 0 },
      balanceSun: 0,
    });
    const tx = await buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" });
    expect(tx.action).toBe("native_send");
  });

  it("passes when no pool covers but liquid TRX covers the full-tx burn", async () => {
    // No pool coverage at all; 1 TRX (1_000_000 sun) covers the
    // full ~250-byte burn (~250_000 sun).
    stubFetch({
      resources: { freeNetLimit: 0, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 },
      balanceSun: 1_000_000,
    });
    const tx = await buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" });
    expect(tx.action).toBe("native_send");
  });

  it("REJECTS when neither pool individually covers even though the SUM would (regression for the real-vote failure)", async () => {
    // 120 free + 120 staked = 240 units; tx is ~200 bytes. Under the
    // old buggy check the sum passed. Under the correct per-pool check
    // neither pool alone covers → falls through to burn. With 0 TRX,
    // the preflight must reject.
    stubFetch({
      resources: { freeNetLimit: 120, freeNetUsed: 0, NetLimit: 120, NetUsed: 0 },
      balanceSun: 0,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/Insufficient bandwidth/);
  });

  it("REJECTS when neither pool covers AND TRX only covers a shortfall burn (not full-tx)", async () => {
    // Tx is ~170 bytes. 50/50 pool split: neither pool individually
    // covers and the sum (100) doesn't either, so burn kicks in.
    // Balance covers a shortfall burn (70 bytes × 1000 = 70_000 sun)
    // but not a full-tx burn (~170_000 sun). The earlier buggy
    // shortfall-based check let this pass; the correct full-tx check
    // rejects.
    stubFetch({
      resources: { freeNetLimit: 50, freeNetUsed: 0, NetLimit: 50, NetUsed: 0 },
      balanceSun: 80_000,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/Insufficient bandwidth/);
  });

  it("error message quotes a realistic free-pool regen ETA, not a blanket ~24h", async () => {
    // Mirror the real vote-flow failure: 600/471 free, 595/493 staked,
    // 0.06 TRX liquid, ~230-byte tx. The old error message hard-coded
    // "~24h"; the pool actually decays linearly so only a few hours'
    // wait is needed when the current usage is close to the target.
    stubFetch({
      resources: { freeNetLimit: 600, freeNetUsed: 471, NetLimit: 595, NetUsed: 493 },
      balanceSun: 60_000,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/wait ~\d/);
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.not.toThrow(/wait ~24h/);
  });

  it("error message flags an unreachable wait when tx exceeds the per-day free cap", async () => {
    // Tx is ~170 bytes but free cap is lower — even an empty pool
    // can't cover it, so waiting is pointless and the message must
    // say so instead of quoting a misleading "~N hours".
    stubFetch({
      resources: { freeNetLimit: 100, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 },
      balanceSun: 0,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/unreachable — tx exceeds the per-day free cap/);
  });

  it("clamps to zero when usage has somehow exceeded the limit", async () => {
    stubFetch({
      resources: { freeNetLimit: 100, freeNetUsed: 500, NetLimit: 100, NetUsed: 500 },
      balanceSun: 0,
    });
    await expect(
      buildTronNativeSend({ from: ADDR_FROM, to: ADDR_TO, amount: "1" })
    ).rejects.toThrow(/Insufficient bandwidth/);
  });
});
