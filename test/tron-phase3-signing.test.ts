import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Phase-3 (TRON USB HID signing) tests.
 *
 * We mock `src/signing/tron-usb-loader.ts` — a thin wrapper that loads the
 * two Ledger CJS packages — rather than trying to mock the packages
 * themselves. The Ledger SDK's ESM build has broken relative imports
 * (missing `.js` extensions), so we route through a loader module; mocking
 * the loader is also simpler and keeps the test free of SDK coupling.
 */

type TrxStub = {
  getAddress: ReturnType<typeof vi.fn>;
  signTransaction: ReturnType<typeof vi.fn>;
  getAppConfiguration: ReturnType<typeof vi.fn>;
};

let openLedgerMock: ReturnType<typeof vi.fn>;
let trxInstance: TrxStub;
let transportCloseMock: ReturnType<typeof vi.fn>;

vi.mock("../src/signing/tron-usb-loader.js", () => ({
  openLedger: () => openLedgerMock(),
}));

const DEVICE_ADDRESS = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const OTHER_ADDRESS = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const RAW_HEX = "0a02487b2208b6f0a4c9dd5b6c";
const GOOD_SIG = "a".repeat(130);

function makeTrxStub(overrides: Partial<TrxStub> = {}): TrxStub {
  return {
    getAppConfiguration: vi.fn(async () => ({ version: "0.5.0" })),
    getAddress: vi.fn(async () => ({ publicKey: "04abcd", address: DEVICE_ADDRESS })),
    signTransaction: vi.fn(async () => GOOD_SIG),
    ...overrides,
  };
}

function installStubs(overrides: Partial<TrxStub> = {}) {
  trxInstance = makeTrxStub(overrides);
  transportCloseMock = vi.fn(async () => {});
  openLedgerMock = vi.fn(async () => ({
    app: trxInstance,
    transport: { close: transportCloseMock },
  }));
}

function statusCodeError(code: number, message = "") {
  const e = new Error(message || `TransportStatusError 0x${code.toString(16)}`);
  (e as Error & { statusCode?: number }).statusCode = code;
  return e;
}

beforeEach(() => installStubs());
afterEach(() => vi.unstubAllGlobals());

describe("tron-usb-signer", () => {
  it("getTronLedgerAddress returns {address, publicKey, path, appVersion} and closes the transport", async () => {
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    const result = await getTronLedgerAddress();
    expect(result).toEqual({
      address: DEVICE_ADDRESS,
      publicKey: "04abcd",
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
    expect(openLedgerMock).toHaveBeenCalledOnce();
    expect(transportCloseMock).toHaveBeenCalledOnce();
    expect(trxInstance.getAddress).toHaveBeenCalledWith("44'/195'/0'/0/0", false);
  });

  it("signTronTxOnLedger signs when the device address matches `expectedFrom`", async () => {
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    const res = await signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS });
    expect(res).toEqual({ signature: GOOD_SIG, signerAddress: DEVICE_ADDRESS });
    expect(trxInstance.signTransaction).toHaveBeenCalledWith("44'/195'/0'/0/0", RAW_HEX, []);
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("signTronTxOnLedger refuses when device address does NOT match `expectedFrom`", async () => {
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: OTHER_ADDRESS })
    ).rejects.toThrow(/does not match the prepared tx's `from`/);
    expect(trxInstance.signTransaction).not.toHaveBeenCalled();
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("maps 0x6985 (user rejected) to a human-readable error", async () => {
    installStubs({
      signTransaction: vi.fn(async () => {
        throw statusCodeError(0x6985, "Conditions of use not satisfied");
      }),
    });
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS })
    ).rejects.toThrow(/User rejected the transaction/);
  });

  it("maps 0x6511 (wrong app) to 'open the TRON app'", async () => {
    installStubs({
      getAppConfiguration: vi.fn(async () => {
        throw statusCodeError(0x6511, "CLA not supported");
      }),
    });
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    await expect(getTronLedgerAddress()).rejects.toThrow(/TRON app isn't open/);
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("maps a loader failure to a 'no Ledger device' error", async () => {
    installStubs();
    openLedgerMock = vi.fn(async () => {
      throw new Error("cannot open device /dev/hidraw0: No such file or directory");
    });
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    await expect(getTronLedgerAddress()).rejects.toThrow(/No Ledger device detected/);
  });

  it("rejects a signature that isn't 130 hex chars", async () => {
    installStubs({ signTransaction: vi.fn(async () => "deadbeef") });
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS })
    ).rejects.toThrow(/unexpected signature shape/);
  });
});

describe("broadcastTronTx", () => {
  afterEach(() => vi.unstubAllGlobals());

  const baseTx = {
    chain: "tron" as const,
    action: "native_send" as const,
    from: DEVICE_ADDRESS,
    txID: "cc".repeat(32),
    rawData: { expiration: 0 },
    rawDataHex: RAW_HEX,
    description: "Send 1 TRX",
    decoded: { functionName: "TransferContract", args: {} },
  };

  it("posts the signed envelope and returns the on-chain txID on success", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.trongrid.io/wallet/broadcasttransaction");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        txID: baseTx.txID,
        raw_data: baseTx.rawData,
        raw_data_hex: baseTx.rawDataHex,
        signature: [GOOD_SIG],
        visible: true,
      });
      return new Response(JSON.stringify({ result: true, txid: baseTx.txID }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    const res = await broadcastTronTx(baseTx, GOOD_SIG);
    expect(res.txID).toBe(baseTx.txID);
  });

  it("decodes TronGrid's hex-encoded error messages into UTF-8", async () => {
    const hexMsg = Buffer.from("Validate signature error", "utf8").toString("hex");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "SIGERROR", message: hexMsg }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    await expect(broadcastTronTx(baseTx, GOOD_SIG)).rejects.toThrow(
      /SIGERROR — Validate signature error/
    );
  });

  it("surfaces plain-text messages verbatim when not hex-encoded", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: "CONTRACT_VALIDATE_ERROR", message: "not-hex message!" }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    await expect(broadcastTronTx(baseTx, GOOD_SIG)).rejects.toThrow(
      /CONTRACT_VALIDATE_ERROR — not-hex message!/
    );
  });
});

describe("sendTransaction — TRON handle routing", () => {
  beforeEach(() => installStubs());
  afterEach(() => vi.unstubAllGlobals());

  it("signs on USB, broadcasts to TronGrid, and retires the handle on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.trongrid.io/wallet/createtransaction") {
        return new Response(
          JSON.stringify({
            txID: "ab".repeat(32),
            raw_data: { expiration: 1 },
            raw_data_hex: RAW_HEX,
            visible: true,
          }),
          { status: 200 }
        );
      }
      if (url === "https://api.trongrid.io/wallet/broadcasttransaction") {
        return new Response(JSON.stringify({ result: true, txid: "ab".repeat(32) }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { buildTronNativeSend } = await import("../src/modules/tron/actions.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const { hasTronHandle } = await import("../src/signing/tron-tx-store.js");

    const tx = await buildTronNativeSend({
      from: DEVICE_ADDRESS,
      to: OTHER_ADDRESS,
      amount: "1",
    });
    expect(hasTronHandle(tx.handle!)).toBe(true);

    const result = await sendTransaction({ handle: tx.handle!, confirmed: true });
    expect(result).toEqual({ txHash: "ab".repeat(32), chain: "tron" });
    expect(hasTronHandle(tx.handle!)).toBe(false);
    expect(trxInstance.signTransaction).toHaveBeenCalledWith("44'/195'/0'/0/0", RAW_HEX, []);
  });

  it("keeps the handle alive when signing fails so the caller can retry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.trongrid.io/wallet/createtransaction") {
        return new Response(
          JSON.stringify({
            txID: "cd".repeat(32),
            raw_data: { expiration: 1 },
            raw_data_hex: RAW_HEX,
            visible: true,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    installStubs({
      signTransaction: vi.fn(async () => {
        throw statusCodeError(0x6985, "Conditions of use not satisfied");
      }),
    });

    const { buildTronNativeSend } = await import("../src/modules/tron/actions.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const { hasTronHandle } = await import("../src/signing/tron-tx-store.js");

    const tx = await buildTronNativeSend({
      from: DEVICE_ADDRESS,
      to: OTHER_ADDRESS,
      amount: "1",
    });
    await expect(
      sendTransaction({ handle: tx.handle!, confirmed: true })
    ).rejects.toThrow(/User rejected/);
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });
});

describe("pair_ledger_tron + get_ledger_status", () => {
  beforeEach(() => installStubs());

  it("populates the tron section of getSessionStatus after pairing", async () => {
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
    }));
    const { pairLedgerTron } = await import("../src/modules/execution/index.js");
    const { getSessionStatus } = await import("../src/signing/session.js");

    const pair = await pairLedgerTron();
    expect(pair.address).toBe(DEVICE_ADDRESS);
    expect(pair.path).toBe("44'/195'/0'/0/0");

    const status = await getSessionStatus();
    expect(status.tron).toEqual({
      address: DEVICE_ADDRESS,
      path: "44'/195'/0'/0/0",
      appVersion: "0.5.0",
    });
  });
});
