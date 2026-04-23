/**
 * Regression tests for issue #75 — `send_transaction` hanging indefinitely
 * when the WalletConnect session is dead. The fix adds a 5s ping-probe
 * before publishing and a 120s hard timeout on the request itself; both
 * paths now throw structured errors the agent can surface instead of
 * blocking the chat.
 */
import { describe, it, expect } from "vitest";
import { probeSessionLiveness } from "../src/signing/walletconnect.js";
import type { SignClient } from "@walletconnect/sign-client";

describe("probeSessionLiveness", () => {
  it("returns 'alive' when ping resolves promptly", async () => {
    const fakeClient = {
      ping: async () => {},
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("alive");
  });

  it("returns 'dead' when ping rejects immediately (explicit peer rejection)", async () => {
    const fakeClient = {
      ping: async () => {
        throw new Error("no matching session");
      },
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("dead");
  });

  it("returns 'unknown' when ping hangs past the 5s timeout", async () => {
    // Never resolves → forced timeout path. Real-world: peer is offline or
    // the relay can't deliver.
    const fakeClient = {
      ping: () => new Promise(() => {}),
    } as unknown as InstanceType<typeof SignClient>;
    const start = Date.now();
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    const elapsed = Date.now() - start;
    expect(result).toBe("unknown");
    // The probe must return in ~5s, not block indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);
});

describe("WalletConnectSessionUnavailableError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectSessionUnavailableError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectSessionUnavailableError("test");
    expect(e.name).toBe("WalletConnectSessionUnavailableError");
    expect(e instanceof Error).toBe(true);
  });
});

describe("WalletConnectRequestTimeoutError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectRequestTimeoutError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectRequestTimeoutError("test");
    expect(e.name).toBe("WalletConnectRequestTimeoutError");
    expect(e instanceof Error).toBe(true);
  });
});
