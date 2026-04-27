import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";
import {
  generateReadonlyLink,
  importReadonlyToken,
  listReadonlyInvites,
  revokeReadonlyInvite,
} from "../src/modules/share/index.js";
import {
  decodeToken,
  encodeToken,
  extractToken,
  hashToken,
} from "../src/modules/share/token.js";

const EVM_A = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075";
const EVM_B = "0xa53A13412d0e415eaD45c09752Ee1676fAef03fa";
const TRON_A = "TPoaKtYTEPMj4LxWE3J5q3NdZVcX6HYUay";
const SOL_A = "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf";
const BTC_A = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vaultpilot-share-"));
  setConfigDirForTesting(tmp);
});
afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmp, { recursive: true, force: true });
});

describe("generate_readonly_link → import_readonly_token round trip", () => {
  it("happy path: caller embeds wallets, recipient decodes the same wallets back", () => {
    const gen = generateReadonlyLink({
      wallets: { evm: [EVM_A, EVM_B], tron: [TRON_A], solana: [SOL_A], btc: [BTC_A] },
      scope: "read-portfolio",
      expiresIn: "24h",
      name: "advisor-bob",
    });
    expect(gen.token).toMatch(/^vp1\./);
    expect(gen.name).toBe("advisor-bob");
    expect(gen.walletCounts).toEqual({ evm: 2, tron: 1, solana: 1, btc: 1 });

    const imp = importReadonlyToken({ token: gen.token });
    expect(imp.wallets.evm).toEqual([EVM_A, EVM_B]);
    expect(imp.wallets.tron).toEqual([TRON_A]);
    expect(imp.wallets.solana).toEqual([SOL_A]);
    expect(imp.wallets.btc).toEqual([BTC_A]);
    expect(imp.name).toBe("advisor-bob");
    expect(imp.id).toBe(gen.id);
    expect(imp.expiresAt).toBe(gen.expiresAt);
  });

  it("auto-generates a `share-XXXX` name when none is provided", () => {
    const gen = generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
    });
    expect(gen.name).toMatch(/^share-[0-9a-f]{4}$/);
  });

  it("import accepts URLs with ?t=… and #t=… token parameters", () => {
    const gen = generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "url-test",
    });
    const queryUrl = `https://vaultpilot-mcp.ai/import?t=${gen.token}`;
    const hashUrl = `https://vaultpilot-mcp.ai/import#t=${gen.token}`;
    expect(extractToken(queryUrl)).toBe(gen.token);
    expect(extractToken(hashUrl)).toBe(gen.token);
    expect(importReadonlyToken({ token: queryUrl }).id).toBe(gen.id);
    expect(importReadonlyToken({ token: hashUrl }).id).toBe(gen.id);
  });

  it("rejects expired tokens at import time", () => {
    // Forge a token with `exp` in the past — bypasses the generator's
    // 24h-floor so the test doesn't need to time-travel.
    const expired = encodeToken({
      v: 1,
      id: "00000000-0000-0000-0000-000000000001",
      iat: Date.now() - 10 * 60 * 60 * 1000,
      exp: Date.now() - 1000,
      scope: "read-portfolio",
      name: "expired",
      wallets: { evm: [EVM_A] },
    });
    expect(() => importReadonlyToken({ token: expired })).toThrow(/expired/i);
  });

  it("rejects malformed tokens with a hint to copy the full string", () => {
    expect(() => importReadonlyToken({ token: "not-a-token" })).toThrow(
      /share token|http\(s\) URL|vp1\./i,
    );
    expect(() => importReadonlyToken({ token: "vp1.AAA" })).toThrow();
  });
});

describe("list_readonly_invites + revoke_readonly_invite", () => {
  it("list defaults to active-only; includeInactive surfaces revoked entries", () => {
    const a = generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "alice",
    });
    generateReadonlyLink({
      wallets: { tron: [TRON_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "bob",
    });
    revokeReadonlyInvite({ name: "alice" });

    const active = listReadonlyInvites({ includeInactive: false });
    expect(active.invites.map((i) => i.name)).toEqual(["bob"]);

    const all = listReadonlyInvites({ includeInactive: true });
    expect(all.invites.map((i) => i.name).sort()).toEqual(["alice", "bob"]);
    const aliceEntry = all.invites.find((i) => i.name === "alice")!;
    expect(aliceEntry.active).toBe(false);
    expect(aliceEntry.revokedAt).not.toBeNull();
    expect(aliceEntry.id).toBe(a.id);
    // Address counts surface, raw addresses do NOT — the file stores the
    // wallets but list_readonly_invites projects only walletCounts.
    expect(aliceEntry.walletCounts).toEqual({ evm: 1, tron: 0, solana: 0, btc: 0 });
    expect(aliceEntry.totalAddresses).toBe(1);
  });

  it("revoke refuses unknown names with a clear error", () => {
    expect(() => revokeReadonlyInvite({ name: "does-not-exist" })).toThrow(
      /No read-only invite found/,
    );
  });

  it("revoke refuses already-revoked invites", () => {
    generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "twice",
    });
    revokeReadonlyInvite({ name: "twice" });
    expect(() => revokeReadonlyInvite({ name: "twice" })).toThrow(
      /already revoked/,
    );
  });

  it("rejects duplicate active names — the user must revoke before regenerating", () => {
    generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "dup",
    });
    expect(() =>
      generateReadonlyLink({
        wallets: { evm: [EVM_B] },
        scope: "read-portfolio",
        expiresIn: "1h",
        name: "dup",
      }),
    ).toThrow(/already exists/);
    // After revoking, regeneration with the same name is allowed.
    revokeReadonlyInvite({ name: "dup" });
    expect(() =>
      generateReadonlyLink({
        wallets: { evm: [EVM_B] },
        scope: "read-portfolio",
        expiresIn: "1h",
        name: "dup",
      }),
    ).not.toThrow();
  });

  it("stores only the token hash, not the raw token", () => {
    const gen = generateReadonlyLink({
      wallets: { evm: [EVM_A] },
      scope: "read-portfolio",
      expiresIn: "1h",
      name: "hashed",
    });
    const path = join(tmp, "readonly-invites.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    const stored = file.invites[0];
    expect(stored.tokenHash).toBe(hashToken(gen.token));
    expect(JSON.stringify(file)).not.toContain(gen.token);
  });
});

describe("token round trip: encode/decode preserves shape", () => {
  it("envelope JSON structure is preserved across base64url encode/decode", () => {
    const env = {
      v: 1 as const,
      id: "00000000-0000-0000-0000-000000000abc",
      iat: 1_761_545_478_000,
      exp: 1_761_631_878_000,
      scope: "read-portfolio" as const,
      name: "round-trip",
      wallets: { evm: [EVM_A], solana: [SOL_A] },
    };
    const token = encodeToken(env);
    expect(token.startsWith("vp1.")).toBe(true);
    const decoded = decodeToken(token);
    expect(decoded).toEqual(env);
  });

  it("generator validates the wallet bundle (rejects empty)", () => {
    expect(() =>
      generateReadonlyLink({
        wallets: {} as never,
        scope: "read-portfolio",
        expiresIn: "1h",
      }),
    ).toThrow();
  });

  it("storage file ignores corrupted contents and starts fresh", () => {
    const path = join(tmp, "readonly-invites.json");
    writeFileSync(path, "not-json-at-all", "utf8");
    // Operates against a fresh empty store; no crash.
    const out = listReadonlyInvites({ includeInactive: true });
    expect(out.invites).toEqual([]);
  });
});
