/**
 * Issue #249 — USDT-TRC20 blacklist probe (`isBlackListed(address)`)
 * helper. Mocks `fetchWithTimeout` so the tests never touch live
 * TronGrid; verifies the param-encoding shape (selector + 32-byte
 * address word) so a regression in `base58ToHex` or padding logic
 * shows up here, not in production.
 *
 * The empirical verification that `isBlackListed(address)` actually
 * exists on `TR7NHqj…6t` was done at code-time against the live
 * contract — see PR description's R&D section.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../src/data/http.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("../src/config/user-config.js", () => ({
  resolveTronApiKey: () => undefined,
  readUserConfig: () => ({}),
}));

import {
  checkUsdtBlacklist,
  USDT_TRC20_CONTRACT,
  _clearUsdtBlacklistCacheForTests,
} from "../src/modules/tron/usdt-blacklist.js";

// Two real-shape TRON addresses (valid base58check). Treated as test
// fixtures only; what they actually do on-chain doesn't matter — every
// network call is mocked.
const FAKE_WALLET_NOT_BLACKLISTED = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const FAKE_WALLET_BLACKLISTED = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

function mockOk(constantWord: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      result: { result: true },
      constant_result: [constantWord],
    }),
  });
}

function mockHttpFail(status: number) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "fail",
    json: async () => ({}),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearUsdtBlacklistCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkUsdtBlacklist", () => {
  it("returns blacklisted=false for an address whose isBlackListed call returns the all-zero word", async () => {
    fetchMock.mockReturnValue(
      mockOk("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    const out = await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED]);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe(FAKE_WALLET_NOT_BLACKLISTED);
    expect(out[0].blacklisted).toBe(false);
    expect(out[0].fromCache).toBe(false);
  });

  it("returns blacklisted=true when the constant_result word is non-zero", async () => {
    fetchMock.mockReturnValue(
      mockOk("0000000000000000000000000000000000000000000000000000000000000001"),
    );
    const out = await checkUsdtBlacklist([FAKE_WALLET_BLACKLISTED]);
    expect(out[0].blacklisted).toBe(true);
  });

  it("encodes the address as a 32-byte word with the 0x41 TRON version byte stripped", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      captured = { url, init };
      return mockOk(
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
    });
    await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED]);

    expect(captured.url).toBe("https://api.trongrid.io/wallet/triggerconstantcontract");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.contract_address).toBe(USDT_TRC20_CONTRACT);
    expect(body.function_selector).toBe("isBlackListed(address)");
    // 32-byte parameter word = 64 hex chars; left-padded; first 24 hex
    // chars are zero (the address fits in the trailing 20 bytes).
    expect(body.parameter).toMatch(/^[0-9a-f]{64}$/i);
    expect(body.parameter.slice(0, 24)).toBe("0".repeat(24));
    // The 0x41 TRON version byte must NOT appear at the start of the
    // active address bytes (positions 24..26) — the contract uses the
    // EVM 20-byte form.
    expect(body.parameter.slice(24, 26)).not.toBe("41");
    expect(body.visible).toBe(true);
  });

  it("hits the network exactly once per address under cache TTL", async () => {
    fetchMock.mockReturnValue(
      mockOk("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    const a = await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED]);
    expect(a[0].fromCache).toBe(false);
    const b = await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED]);
    expect(b[0].fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the cache TTL elapses", async () => {
    fetchMock.mockReturnValue(
      mockOk("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    const t0 = 1_700_000_000_000;
    await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED], { now: t0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 1h + 1ms past the original fetch — should re-probe.
    const t1 = t0 + 60 * 60 * 1000 + 1;
    const second = await checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED], {
      now: t1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second[0].fromCache).toBe(false);
  });

  it("preserves duplicate addresses in input order (no dedup at the helper layer)", async () => {
    // The caller (chain-tron.ts) dedupes for direction-context reasons;
    // this helper just probes whatever it's handed. Two of the same
    // address → one cache lookup the first time, cache hit the second.
    fetchMock.mockReturnValue(
      mockOk("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    const out = await checkUsdtBlacklist([
      FAKE_WALLET_NOT_BLACKLISTED,
      FAKE_WALLET_NOT_BLACKLISTED,
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].fromCache).toBe(false);
    expect(out[1].fromCache).toBe(true);
  });

  it("propagates HTTP errors so the caller can emit available:false", async () => {
    fetchMock.mockReturnValue(mockHttpFail(503));
    await expect(
      checkUsdtBlacklist([FAKE_WALLET_NOT_BLACKLISTED]),
    ).rejects.toThrow(/503/);
  });

  it("rejects malformed addresses up front, not via TronGrid", async () => {
    await expect(checkUsdtBlacklist(["not-a-tron-address"])).rejects.toThrow(
      /not a valid TRON mainnet address/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
