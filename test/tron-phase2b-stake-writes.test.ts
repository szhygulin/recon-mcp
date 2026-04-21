import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildTronFreeze,
  buildTronUnfreeze,
  buildTronWithdrawExpireUnfreeze,
} from "../src/modules/tron/actions.js";
import { hasTronHandle } from "../src/signing/tron-tx-store.js";
import {
  encodeFreezeV2RawData,
  encodeUnfreezeV2RawData,
  encodeOwnerOnlyRawData,
} from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";

/**
 * Phase-2b (TRON Stake 2.0 writes) tests. Network IO is stubbed via
 * vi.stubGlobal("fetch", ...). We lock down:
 *   - POST body shape (endpoint, uppercase resource, SUN-encoded amount, visible:true)
 *   - handle issuance + preview copy (ensures the user-visible description is right)
 *   - validation (non-TRON `from`, zero/negative amounts, bad decimals)
 *   - TronGrid error surfacing (top-level `Error` field)
 */

const ADDR = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

function directTxResponse(rawDataHex: string, txID = "ab".repeat(32)): Response {
  return new Response(
    JSON.stringify({
      txID,
      raw_data: { expiration: 0 },
      raw_data_hex: rawDataHex,
      visible: true,
    }),
    { status: 200 }
  );
}

describe("buildTronFreeze (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/freezebalancev2");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR);
      expect(body.frozen_balance).toBe(100_000_000); // 100 TRX in SUN
      expect(body.resource).toBe("BANDWIDTH"); // uppercased at edge
      expect(body.visible).toBe(true);
      return directTxResponse(
        encodeFreezeV2RawData({
          from: ADDR,
          frozenBalanceSun: BigInt(body.frozen_balance),
          resource: "bandwidth",
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a BANDWIDTH freeze with correct body + preview + handle", async () => {
    const tx = await buildTronFreeze({ from: ADDR, amount: "100", resource: "bandwidth" });
    expect(tx.action).toBe("freeze");
    expect(tx.description).toBe("Freeze 100 TRX for bandwidth (Stake 2.0)");
    expect(tx.decoded.functionName).toBe("FreezeBalanceV2Contract");
    expect(tx.decoded.args).toEqual({ owner: ADDR, amount: "100", resource: "bandwidth" });
    expect(tx.handle).toBeDefined();
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("uppercases ENERGY at the TronGrid edge", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      const body = JSON.parse(init!.body as string);
      expect(body.resource).toBe("ENERGY");
      return directTxResponse(
        encodeFreezeV2RawData({
          from: ADDR,
          frozenBalanceSun: BigInt(body.frozen_balance),
          resource: "energy",
        })
      );
    });
    const tx = await buildTronFreeze({ from: ADDR, amount: "50", resource: "energy" });
    expect(tx.decoded.args.resource).toBe("energy"); // preserved lowercase on preview
  });

  it("rejects non-TRON `from`", async () => {
    await expect(
      buildTronFreeze({ from: "0xdead", amount: "1", resource: "bandwidth" })
    ).rejects.toThrow(/TRON mainnet/);
  });

  it("rejects zero or sub-sun amounts", async () => {
    await expect(
      buildTronFreeze({ from: ADDR, amount: "0", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 0/);
    await expect(
      buildTronFreeze({ from: ADDR, amount: "1.1234567", resource: "bandwidth" })
    ).rejects.toThrow(/more decimals than token precision/);
  });

  it("surfaces TronGrid's top-level Error verbatim", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(JSON.stringify({ Error: "contract validate error : frozen_balance must be greater than 1 TRX" }), {
        status: 200,
      });
    });
    await expect(
      buildTronFreeze({ from: ADDR, amount: "0.5", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 1 TRX/);
  });
});

describe("buildTronUnfreeze (network stubbed)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const preflight = maybeTronBandwidthResponse(url);
        if (preflight) return preflight;
        expect(url).toBe("https://api.trongrid.io/wallet/unfreezebalancev2");
        const body = JSON.parse(init!.body as string);
        expect(body.owner_address).toBe(ADDR);
        expect(body.unfreeze_balance).toBe(75_000_000); // 75 TRX
        expect(body.resource).toBe("ENERGY");
        return directTxResponse(
          encodeUnfreezeV2RawData({
            from: ADDR,
            unfreezeBalanceSun: BigInt(body.unfreeze_balance),
            resource: "energy",
          })
        );
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds an ENERGY unfreeze with 14-day-cooldown language in the preview", async () => {
    const tx = await buildTronUnfreeze({ from: ADDR, amount: "75", resource: "energy" });
    expect(tx.action).toBe("unfreeze");
    expect(tx.description).toBe(
      "Unfreeze 75 TRX from energy — 14-day unstaking cooldown begins"
    );
    expect(tx.decoded.functionName).toBe("UnfreezeBalanceV2Contract");
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("surfaces 'less than frozen balance' verbatim (overshoot guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const preflight = maybeTronBandwidthResponse(url);
        if (preflight) return preflight;
        return new Response(JSON.stringify({ Error: "contract validate error : unfreezeBalance less than frozen balance" }), {
          status: 200,
        });
      })
    );
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "9999", resource: "bandwidth" })
    ).rejects.toThrow(/less than frozen balance/);
  });

  it("rejects zero/negative amounts", async () => {
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "0", resource: "bandwidth" })
    ).rejects.toThrow(/greater than 0/);
    await expect(
      buildTronUnfreeze({ from: ADDR, amount: "-1", resource: "bandwidth" })
    ).rejects.toThrow(/Invalid amount/);
  });
});

describe("buildTronWithdrawExpireUnfreeze (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/withdrawexpireunfreeze");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(ADDR);
      expect(body.visible).toBe(true);
      return directTxResponse(
        encodeOwnerOnlyRawData({ kind: "withdraw_expire_unfreeze", from: ADDR })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a sweep tx with handle + preview", async () => {
    const tx = await buildTronWithdrawExpireUnfreeze({ from: ADDR });
    expect(tx.action).toBe("withdraw_expire_unfreeze");
    expect(tx.decoded.functionName).toBe("WithdrawExpireUnfreezeContract");
    expect(tx.description).toContain("Withdraw all expired unfreezes");
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });

  it("surfaces 'no expire unfreeze' when nothing has matured yet", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(
        JSON.stringify({ Error: "contract validate error : no expire unfreeze" }),
        { status: 200 }
      );
    });
    await expect(buildTronWithdrawExpireUnfreeze({ from: ADDR })).rejects.toThrow(
      /no expire unfreeze/
    );
  });

  it("rejects a non-TRON owner", async () => {
    await expect(buildTronWithdrawExpireUnfreeze({ from: "0xbad" })).rejects.toThrow(
      /TRON mainnet/
    );
  });
});
