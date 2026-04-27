import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Ledger Live codesign verifier (issue #325 P4).
 *
 * The verifier spawns OS-specific child processes (`codesign`,
 * `powershell.exe`, an AppImage's `--appimage-signature` flag). We
 * mock `node:child_process.spawn` so the tests never invoke the real
 * tools — the goal is to exercise our parsing + verdict logic, not
 * to test Apple's codesign behavior.
 *
 * `node:fs.existsSync` is also mocked to avoid touching the dev
 * machine's filesystem.
 */

const spawnMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => existsSyncMock(path),
}));

/**
 * Build a fake child-process handle that vitest's spawn mock returns.
 * Emits the configured stdout/stderr on `stdout`/`stderr` event
 * listeners, then a `close` with the configured exit code.
 */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const onByEvent: Record<string, (arg: unknown) => void> = {
    error: () => {},
    close: () => {},
  };
  const stdout = {
    on(event: string, fn: (arg: unknown) => void) {
      handlers[`stdout:${event}`] = [...(handlers[`stdout:${event}`] ?? []), fn];
    },
  };
  const stderr = {
    on(event: string, fn: (arg: unknown) => void) {
      handlers[`stderr:${event}`] = [...(handlers[`stderr:${event}`] ?? []), fn];
    },
  };
  const child = {
    stdout,
    stderr,
    kill: vi.fn(),
    on(event: string, fn: (arg: unknown) => void) {
      onByEvent[event] = fn;
    },
  };
  // Schedule data events + close on next tick to mimic real async.
  setImmediate(() => {
    if (opts.stdout) {
      for (const fn of handlers["stdout:data"] ?? []) {
        fn(Buffer.from(opts.stdout, "utf8"));
      }
    }
    if (opts.stderr) {
      for (const fn of handlers["stderr:data"] ?? []) {
        fn(Buffer.from(opts.stderr, "utf8"));
      }
    }
    onByEvent.close(opts.exitCode ?? 0);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  existsSyncMock.mockReset();
});

describe("verifyLedgerLiveCodesign — macOS", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });

  it("returns 'verified' on a Ledger-signed bundle", async () => {
    existsSyncMock.mockReturnValue(true);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // First call: --verify (exit 0).
      // Second call: -dvv (writes identity to stderr).
      const isVerify = args.includes("--verify");
      if (isVerify) {
        return makeFakeChild({ stdout: "", stderr: "", exitCode: 0 });
      }
      return makeFakeChild({
        stdout: "",
        stderr:
          "Executable=/Applications/Ledger Live.app/Contents/MacOS/Ledger Live\n" +
          "Identifier=com.ledger.live.desktop\n" +
          "Authority=Developer ID Application: Ledger SAS (B95846FZ23)\n" +
          "TeamIdentifier=B95846FZ23\n",
        exitCode: 0,
      });
    });
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/Applications/Ledger Live.app",
    });
    expect(out.status).toBe("verified");
    expect(out.platform).toBe("darwin");
    expect(out.reportedIdentity).toMatch(/Ledger SAS/);
    expect(calls[0].cmd).toBe("codesign");
  });

  it("returns 'mismatch' when the bundle is signed by someone else", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const isVerify = args.includes("--verify");
      if (isVerify) return makeFakeChild({ exitCode: 0 });
      return makeFakeChild({
        stderr:
          "Authority=Developer ID Application: Acme Corp (XXXXXXXXXX)\n" +
          "TeamIdentifier=XXXXXXXXXX\n",
        exitCode: 0,
      });
    });
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/Applications/Ledger Live.app",
    });
    expect(out.status).toBe("mismatch");
    expect(out.message).toMatch(/B95846FZ23/);
  });

  it("returns 'invalid' when codesign --verify exits non-zero", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stderr: "code object is not signed at all",
        exitCode: 1,
      }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/Applications/Ledger Live.app",
    });
    expect(out.status).toBe("invalid");
    expect(out.message).toMatch(/not signed|exit 1/);
  });

  it("returns 'not-found' when no install is at the expected path", async () => {
    existsSyncMock.mockReturnValue(false);
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/nope.app",
    });
    expect(out.status).toBe("not-found");
  });

  it("returns 'tool-missing' when codesign is unavailable", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() => {
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill: vi.fn(),
        on(event: string, fn: (arg: unknown) => void) {
          if (event === "error") {
            setImmediate(() =>
              fn(
                Object.assign(new Error("spawn codesign ENOENT"), {
                  code: "ENOENT",
                }),
              ),
            );
          }
        },
      };
      return child;
    });
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/Applications/Ledger Live.app",
    });
    expect(out.status).toBe("tool-missing");
  });
});

describe("verifyLedgerLiveCodesign — Windows", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
  });

  it("returns 'verified' on a Ledger-signed exe", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stdout:
          "Status                : Valid\n" +
          "StatusMessage         : Signature verified.\n" +
          "Subject               : CN=Ledger SAS, O=Ledger SAS, L=Paris, C=FR\n",
        exitCode: 0,
      }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "C:/Program Files/Ledger Live/Ledger Live.exe",
    });
    expect(out.status).toBe("verified");
    expect(out.reportedIdentity).toMatch(/Ledger SAS/);
  });

  it("returns 'mismatch' when Subject doesn't include Ledger SAS", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stdout:
          "Status                : Valid\n" +
          "Subject               : CN=Acme Corp, O=Acme Corp, L=City, C=US\n",
        exitCode: 0,
      }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "C:/Program Files/Ledger Live/Ledger Live.exe",
    });
    expect(out.status).toBe("mismatch");
  });

  it("returns 'invalid' when Status is not Valid", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stdout: "Status                : NotSigned\n",
        exitCode: 0,
      }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "C:/Program Files/Ledger Live/Ledger Live.exe",
    });
    expect(out.status).toBe("invalid");
  });
});

describe("verifyLedgerLiveCodesign — Linux", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
  });

  it("requires an explicit binaryPath (no canonical install)", async () => {
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign();
    expect(out.status).toBe("not-found");
    expect(out.message).toMatch(/Linux requires an explicit/);
  });

  it("returns 'verified' when AppImage prints a PGP signature", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stdout: "-----BEGIN PGP SIGNATURE-----\nfoo\n-----END PGP SIGNATURE-----\n",
        exitCode: 0,
      }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/home/user/Ledger-live.AppImage",
    });
    expect(out.status).toBe("verified");
    expect(out.message).toMatch(/embedded PGP signature/);
  });

  it("returns 'invalid' when AppImage has no PGP signature", async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockImplementation(() =>
      makeFakeChild({ stdout: "", exitCode: 0 }),
    );
    const { verifyLedgerLiveCodesign } = await import(
      "../src/signing/ledger-live-codesign.ts"
    );
    const out = await verifyLedgerLiveCodesign({
      binaryPath: "/home/user/Ledger-live.AppImage",
    });
    expect(out.status).toBe("invalid");
  });
});
