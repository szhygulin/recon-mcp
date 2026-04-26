/**
 * Tests for the bitcoind / litecoind JSON-RPC client. Issue #248.
 *
 * Strategy: stub `fetch` globally + craft synthetic Response objects.
 * No live daemon needed; we lock the request shape (POST + JSON body
 * with v1.0 envelope, auth header for each mode) and the response
 * decode (success / error / transport-error branches).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JsonRpcError,
  JsonRpcTransportError,
  jsonRpcCall,
} from "../src/data/jsonrpc.js";

const URL = "http://127.0.0.1:8332";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jsonRpcCall — success path", () => {
  it("returns the parsed `result` field on a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ result: "deadbeef", error: null, id: "getbestblockhash" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await jsonRpcCall<string>(
      { url: URL, auth: { kind: "none" } },
      "getbestblockhash",
    );
    expect(out).toBe("deadbeef");
  });

  it("sends a POST request with the JSON-RPC v1.0 envelope (`jsonrpc: '1.0'`, positional `params` array)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ result: "abc", error: null, id: "getblockhash" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await jsonRpcCall<string>(
      { url: URL, auth: { kind: "none" } },
      "getblockhash",
      [123456],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      jsonrpc: "1.0",
      method: "getblockhash",
      params: [123456],
    });
  });
});

describe("jsonRpcCall — auth modes", () => {
  it("basic auth: encodes `<user>:<password>` as base64 in Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ result: 0, error: null, id: "x" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await jsonRpcCall(
      {
        url: URL,
        auth: { kind: "basic", user: "alice", password: "bob" },
      },
      "x",
    );
    const [, init] = fetchMock.mock.calls[0];
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("alice:bob").toString("base64")}`);
  });

  it("header auth: forwards the named header verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ result: 0, error: null, id: "x" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await jsonRpcCall(
      {
        url: URL,
        auth: { kind: "header", headerName: "X-Auth-Token", headerValue: "secret123" },
      },
      "x",
    );
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["X-Auth-Token"]).toBe("secret123");
  });

  it("none: sends no Authorization header (daemon will 401 unless allows-no-auth)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ result: 0, error: null, id: "x" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await jsonRpcCall({ url: URL, auth: { kind: "none" } }, "x");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("jsonRpcCall — error decode", () => {
  it("throws JsonRpcError with code + message when the daemon returns a structured error", async () => {
    // bitcoind returns 500 with a JSON body for RPC method errors.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: null,
          error: { code: -8, message: "Block height out of range" },
          id: "x",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await jsonRpcCall({ url: URL, auth: { kind: "none" } }, "getblockhash", [99_999_999]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonRpcError);
    expect((caught as JsonRpcError).code).toBe(-8);
    expect((caught as JsonRpcError).message).toContain("Block height out of range");
  });

  it("throws JsonRpcTransportError on HTTP non-2xx with no JSON-RPC error envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403, statusText: "Forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await jsonRpcCall({ url: URL, auth: { kind: "none" } }, "getblockhash");
    } catch (err) {
      caught = err;
    }
    // 403 with non-JSON body falls through to the transport branch.
    expect(caught).toBeInstanceOf(JsonRpcTransportError);
    expect((caught as Error).message).toMatch(/non-JSON|HTTP 403/);
  });

  it("throws JsonRpcTransportError on network error (fetch reject)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await jsonRpcCall({ url: URL, auth: { kind: "none" } }, "getblockhash");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonRpcTransportError);
    expect((caught as Error).message).toContain("ECONNREFUSED");
  });
});
