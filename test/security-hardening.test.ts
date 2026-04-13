/**
 * Regression tests for the security-hardening pass:
 *   H1  sendTransaction schema requires confirmed: true
 *   H2  approval helper emits reset→approve(cap) when prior allowance exceeds cap;
 *       unlimited approvals carry the UNLIMITED_APPROVAL_WARNING tag
 *   H3  pre-sign check uses the statically-pinned Aave V3 Pool — a compromised RPC
 *       cannot forge an attacker address into the allowlist
 *   M1  REQUIRED_NAMESPACES excludes personal_sign / eth_signTypedData_v4
 *   M3  isPrivateOrLoopbackHost rejects IPv6 ULA / link-local / IPv4-mapped
 *   M4  Aave prepare_* schemas accept approvalCap
 *   M5  handle is single-use after retireHandle; retry-on-failure preserved
 *   L1  writeUserConfig refuses symlinks at the target path
 *   L2  patchUserConfig invokes the rpc-change hook when rpc settings change
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { symlinkSync, writeFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, maxUint256, parseUnits, toFunctionSelector } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

// Shared RPC mock: many tests drive buildApprovalTx / pre-sign-check through
// getClient(). Same hoisted-mock pattern used elsewhere in the suite.
const { readContractMock, multicallMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
  multicallMock: vi.fn(),
}));
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
    getChainId: vi.fn(),
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
});

// ====================================================================
// H1 — send_transaction schema enforces user-acknowledgement literal.
// ====================================================================
describe("H1: sendTransaction requires confirmed:true", () => {
  it("rejects when `confirmed` is missing", async () => {
    const { sendTransactionInput } = await import("../src/modules/execution/schemas.js");
    const res = sendTransactionInput.safeParse({ handle: "abc" });
    expect(res.success).toBe(false);
  });

  it("rejects when `confirmed` is false", async () => {
    const { sendTransactionInput } = await import("../src/modules/execution/schemas.js");
    const res = sendTransactionInput.safeParse({ handle: "abc", confirmed: false });
    expect(res.success).toBe(false);
  });

  it("accepts confirmed:true", async () => {
    const { sendTransactionInput } = await import("../src/modules/execution/schemas.js");
    const res = sendTransactionInput.safeParse({ handle: "abc", confirmed: true });
    expect(res.success).toBe(true);
  });
});

// ====================================================================
// H2 — buildApprovalTx cap-reduction + unlimited warning.
// ====================================================================
describe("H2: buildApprovalTx respects approvalCap vs existing allowance", () => {
  const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
  const SPENDER = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as `0x${string}`;

  it("emits reset→approve(cap) when prior allowance exceeds the explicit cap", async () => {
    // Prior unlimited approval (or any value > requested cap) must be rewritten
    // down to the cap. Silent no-op would defeat the caller's intent.
    readContractMock.mockResolvedValue(maxUint256); // existing allowance is huge
    const { buildApprovalTx } = await import("../src/modules/shared/approval.js");
    const cap = parseUnits("500", 6);
    const tx = await buildApprovalTx({
      chain: "ethereum",
      wallet: WALLET,
      asset: USDC,
      spender: SPENDER,
      amountWei: parseUnits("100", 6),
      approvalAmount: cap,
      approvalDisplay: "500 (capped)",
      symbol: "USDC",
      spenderLabel: "Aave V3 Pool",
    });
    expect(tx).not.toBeNull();
    // Outer tx = reset to 0, with reason referencing the cap enforcement.
    expect(tx!.description).toMatch(/Reduce USDC allowance to respect approvalCap/i);
    expect(tx!.data.endsWith("0".repeat(64))).toBe(true);
    // Follow-up = approve(cap).
    const next = tx!.next!;
    const decoded = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SPENDER, cap],
    });
    expect(next.data).toBe(decoded);
  });

  it("returns null when existing allowance covers the action AND respects the cap", async () => {
    // No-op path: nothing to approve, nothing to reset.
    readContractMock.mockResolvedValue(parseUnits("500", 6));
    const { buildApprovalTx } = await import("../src/modules/shared/approval.js");
    const tx = await buildApprovalTx({
      chain: "ethereum",
      wallet: WALLET,
      asset: USDC,
      spender: SPENDER,
      amountWei: parseUnits("100", 6),
      approvalAmount: parseUnits("500", 6),
      approvalDisplay: "500 (capped)",
      symbol: "USDC",
      spenderLabel: "Aave V3 Pool",
    });
    expect(tx).toBeNull();
  });

  it("tags unlimited approvals with the UNLIMITED_APPROVAL_WARNING", async () => {
    readContractMock.mockResolvedValue(0n);
    const { buildApprovalTx, UNLIMITED_APPROVAL_WARNING } = await import(
      "../src/modules/shared/approval.js"
    );
    const tx = await buildApprovalTx({
      chain: "ethereum",
      wallet: WALLET,
      asset: USDC,
      spender: SPENDER,
      amountWei: parseUnits("100", 6),
      approvalAmount: maxUint256,
      approvalDisplay: "unlimited",
      symbol: "USDC",
      spenderLabel: "Aave V3 Pool",
    });
    expect(tx!.description).toContain(UNLIMITED_APPROVAL_WARNING);
  });
});

// ====================================================================
// H3 — pre-sign check uses the hardcoded Pool, not a live RPC read.
// ====================================================================
describe("H3: pre-sign check uses pinned Aave V3 Pool address", () => {
  const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const PINNED_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  it("recognizes the pinned Pool even when readContract would lie", async () => {
    // If classifyDestination had gone through the RPC, this mock would cause
    // the pinned Pool to be *rejected*. Proves we're trust-rooted in CONTRACTS.
    readContractMock.mockResolvedValue(ATTACKER);
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    // Aave supply(address,uint256,address,uint16) calldata.
    const data =
      "0x617ba037" +
      "A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase().padStart(64, "0") +
      (1_000_000n).toString(16).padStart(64, "0") +
      WALLET.slice(2).toLowerCase().padStart(64, "0") +
      (0).toString(16).padStart(64, "0");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: PINNED_POOL as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "Aave supply",
      })
    ).resolves.toBeUndefined();
    // RPC was not consulted: classifyDestination no longer reads the pool from chain.
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("refuses approve() to an attacker spender even when RPC advertises it", async () => {
    // Even if a malicious RPC claimed the attacker IS the pool, the allowlist
    // is built from CONTRACTS — so approve(attacker, max) still fails.
    readContractMock.mockResolvedValue(ATTACKER);
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve attacker",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist/);
  });
});

// ====================================================================
// M1 — WalletConnect required methods are the narrow eth_* set only.
// ====================================================================
describe("M1: REQUIRED_NAMESPACES scopes away blind-sign methods", () => {
  it("does not request personal_sign or eth_signTypedData_v4", async () => {
    const { REQUIRED_NAMESPACES } = await import("../src/signing/walletconnect.js");
    const methods = REQUIRED_NAMESPACES.eip155.methods;
    expect(methods).not.toContain("personal_sign");
    expect(methods).not.toContain("eth_signTypedData_v4");
    expect(methods).toContain("eth_sendTransaction");
  });
});

// ====================================================================
// M3 — isPrivateOrLoopbackHost covers IPv6 private ranges.
// ====================================================================
describe("M3: isPrivateOrLoopbackHost covers IPv6 ULA/link-local/mapped", () => {
  it("flags IPv6 loopback and unspecified", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::")).toBe(true);
  });

  it("flags ULA (fc00::/7) — both fc.. and fd.. prefixes", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    expect(isPrivateOrLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd12::abcd")).toBe(true);
  });

  it("flags link-local (fe80::/10)", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("feb0::1")).toBe(true);
  });

  it("flags IPv4-mapped IPv6 with RFC1918 payload", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    expect(isPrivateOrLoopbackHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:192.168.1.5")).toBe(true);
  });

  it("does not false-positive on public IPv6", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    // 2001:4860:: is Google DNS prefix — unambiguously public.
    expect(isPrivateOrLoopbackHost("2001:4860::1")).toBe(false);
  });

  it("handles bracketed IPv6 form from URL parser", async () => {
    const { isPrivateOrLoopbackHost } = await import("../src/config/chains.js");
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
  });
});

// ====================================================================
// M4 — Aave prepare schemas accept approvalCap.
// ====================================================================
describe("M4: Aave schemas accept approvalCap", () => {
  it("prepareAaveSupplyInput accepts approvalCap", async () => {
    const { prepareAaveSupplyInput } = await import("../src/modules/execution/schemas.js");
    const ok = prepareAaveSupplyInput.safeParse({
      wallet: "0x1111111111111111111111111111111111111111",
      chain: "ethereum",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "500",
      approvalCap: "exact",
    });
    expect(ok.success).toBe(true);
  });

  it("prepareAaveRepayInput accepts approvalCap", async () => {
    const { prepareAaveRepayInput } = await import("../src/modules/execution/schemas.js");
    const ok = prepareAaveRepayInput.safeParse({
      wallet: "0x1111111111111111111111111111111111111111",
      chain: "ethereum",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "500",
      approvalCap: "unlimited",
    });
    expect(ok.success).toBe(true);
  });
});

// ====================================================================
// M5 — handle lifecycle: issue → retire → next lookup fails.
// ====================================================================
describe("M5: tx-store handle single-use semantics", () => {
  it("issueHandles → consumeHandle returns the tx; still valid on second lookup", async () => {
    const { issueHandles, consumeHandle, hasHandle } = await import("../src/signing/tx-store.js");
    const tx = issueHandles({
      chain: "ethereum",
      to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      data: "0x",
      value: "0",
      from: "0x1111111111111111111111111111111111111111",
      description: "noop",
    });
    expect(tx.handle).toBeDefined();
    // Retry-on-failure path: consume does NOT retire the handle.
    expect(consumeHandle(tx.handle!).description).toBe("noop");
    expect(hasHandle(tx.handle!)).toBe(true);
    const again = consumeHandle(tx.handle!);
    expect(again.description).toBe("noop");
  });

  it("retireHandle makes the handle single-use", async () => {
    const { issueHandles, consumeHandle, retireHandle, hasHandle } = await import(
      "../src/signing/tx-store.js"
    );
    const tx = issueHandles({
      chain: "ethereum",
      to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      data: "0x",
      value: "0",
      from: "0x1111111111111111111111111111111111111111",
      description: "noop",
    });
    retireHandle(tx.handle!);
    expect(hasHandle(tx.handle!)).toBe(false);
    expect(() => consumeHandle(tx.handle!)).toThrow(/Unknown or expired tx handle/);
  });

  it("each node in a tx chain gets its own handle (independent audit events)", async () => {
    const { issueHandles, consumeHandle } = await import("../src/signing/tx-store.js");
    const root = issueHandles({
      chain: "ethereum",
      to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      data: "0x",
      value: "0",
      from: "0x1111111111111111111111111111111111111111",
      description: "step 1",
      next: {
        chain: "ethereum",
        to: "0x0000000000000000000000000000000000000003" as `0x${string}`,
        data: "0x",
        value: "0",
        from: "0x1111111111111111111111111111111111111111",
        description: "step 2",
      },
    });
    expect(root.handle).toBeDefined();
    expect(root.next?.handle).toBeDefined();
    expect(root.handle).not.toBe(root.next!.handle);
    // Each handle resolves to its own node.
    expect(consumeHandle(root.handle!).description).toBe("step 1");
    expect(consumeHandle(root.next!.handle!).description).toBe("step 2");
  });
});

// ====================================================================
// L1 — writeUserConfig refuses to follow symlinks.
// ====================================================================
describe("L1: writeUserConfig refuses symlinks at the target path", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-crypto-mcp-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when config.json is a symlink to another file", async () => {
    // Pre-place config.json as a symlink pointing at a sensitive file path.
    // writeUserConfig must refuse rather than clobber the symlink target.
    const configDir = join(tmpDir, ".recon-crypto-mcp");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    const target = join(tmpDir, "victim.txt");
    writeFileSync(target, "do not overwrite");
    const configPath = join(configDir, "config.json");
    symlinkSync(target, configPath);

    const { writeUserConfig } = await import("../src/config/user-config.js");
    expect(() =>
      writeUserConfig({ rpc: { provider: "custom" } })
    ).toThrow(/symlink|hardlink|non-regular/i);
    // Victim file untouched.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("do not overwrite");
  });

  it("writes successfully when no prior file exists", async () => {
    const { writeUserConfig, getConfigPath } = await import("../src/config/user-config.js");
    writeUserConfig({ rpc: { provider: "custom", customUrls: { ethereum: "https://x" } } });
    expect(existsSync(getConfigPath())).toBe(true);
  });
});

// ====================================================================
// L2 — patchUserConfig invokes the rpc-change hook on rpc edits.
// ====================================================================
describe("L2: patchUserConfig rpc-change hook", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-crypto-mcp-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fires the hook when rpc settings change", async () => {
    const { patchUserConfig, onRpcConfigChange } = await import(
      "../src/config/user-config.js"
    );
    const hook = vi.fn();
    onRpcConfigChange(hook);
    patchUserConfig({ rpc: { provider: "infura", apiKey: "key1" } });
    expect(hook).toHaveBeenCalledTimes(1);
    // Same rpc → no fire.
    hook.mockReset();
    patchUserConfig({ rpc: { provider: "infura", apiKey: "key1" } });
    expect(hook).not.toHaveBeenCalled();
    // Different rpc → fire again.
    patchUserConfig({ rpc: { provider: "alchemy", apiKey: "key2" } });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("does not fire when only non-rpc fields change", async () => {
    const { patchUserConfig, onRpcConfigChange } = await import(
      "../src/config/user-config.js"
    );
    patchUserConfig({ rpc: { provider: "infura", apiKey: "k" } });
    const hook = vi.fn();
    onRpcConfigChange(hook);
    patchUserConfig({ etherscanApiKey: "abc" });
    expect(hook).not.toHaveBeenCalled();
  });
});
