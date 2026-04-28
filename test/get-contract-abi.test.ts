/**
 * `get_contract_abi` handler — issue #495.
 *
 * Wraps `getContractInfo` with optional follow-once-to-implementation
 * logic. Tests pin the four reachable shapes:
 *
 *   1. direct (non-proxy verified)
 *   2. proxy-implementation (proxy + implementation verified, followProxy=true)
 *   3. proxy-target / follow-proxy-disabled (followProxy=false)
 *   4. proxy-target / implementation-unverified (followProxy=true but the
 *      target's implementation isn't Etherscan-verified)
 *
 * Plus the unverified-target shape (no ABI in either direction).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContractInfo } from "../src/data/apis/etherscan.js";

describe("getContractAbi", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const proxyAddr = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const implAddr = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  function mockGetContractInfo(byAddress: Record<string, ContractInfo>) {
    vi.doMock("../src/data/apis/etherscan.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/apis/etherscan.js")>(
        "../src/data/apis/etherscan.js",
      );
      return {
        ...actual,
        getContractInfo: vi.fn(async (a: `0x${string}`) => {
          const hit = byAddress[a.toLowerCase()];
          if (!hit) throw new Error(`unmocked address: ${a}`);
          return hit;
        }),
      };
    });
  }

  it("direct verified contract returns abiSource=direct + ABI from the target", async () => {
    const fakeAbi = [
      { type: "function", name: "transfer", inputs: [], outputs: [] },
    ];
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: false,
        contractName: "MyToken",
        compilerVersion: "v0.8.20",
        abi: fakeAbi,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", true);
    expect(res.isVerified).toBe(true);
    expect(res.isProxy).toBe(false);
    expect(res.abi).toEqual(fakeAbi);
    expect(res.abiSource).toBe("direct");
    expect(res.proxyFollowSkippedReason).toBeUndefined();
  });

  it("proxy + verified implementation returns abiSource=proxy-implementation with the impl's ABI", async () => {
    const proxyAbi = [{ type: "function", name: "upgradeTo" }];
    const implAbi = [
      { type: "function", name: "swap" },
      { type: "function", name: "deposit" },
    ];
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: implAddr,
        contractName: "ProxyAdmin",
        abi: proxyAbi,
      },
      [implAddr.toLowerCase()]: {
        address: implAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: false,
        contractName: "RouterImpl",
        abi: implAbi,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", true);
    expect(res.isProxy).toBe(true);
    expect(res.address).toBe(proxyAddr); // surfaced address stays the proxy
    expect(res.implementation).toBe(implAddr);
    expect(res.abi).toEqual(implAbi);
    expect(res.abiSource).toBe("proxy-implementation");
    expect(res.contractName).toBe("RouterImpl"); // impl name wins
  });

  it("followProxy=false on a proxy returns abiSource=proxy-target with the proxy's ABI + reason=follow-proxy-disabled", async () => {
    const proxyAbi = [{ type: "function", name: "upgradeTo" }];
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: implAddr,
        contractName: "ProxyAdmin",
        abi: proxyAbi,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", false);
    expect(res.abiSource).toBe("proxy-target");
    expect(res.proxyFollowSkippedReason).toBe("follow-proxy-disabled");
    expect(res.abi).toEqual(proxyAbi);
  });

  it("proxy whose implementation is unverified returns abiSource=proxy-target with reason=implementation-unverified", async () => {
    const proxyAbi = [{ type: "function", name: "upgradeTo" }];
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: implAddr,
        contractName: "ProxyAdmin",
        abi: proxyAbi,
      },
      [implAddr.toLowerCase()]: {
        address: implAddr,
        chain: "ethereum",
        isVerified: false,
        isProxy: false,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", true);
    expect(res.abiSource).toBe("proxy-target");
    expect(res.proxyFollowSkippedReason).toBe("implementation-unverified");
    expect(res.abi).toEqual(proxyAbi); // proxy's own ABI surfaces
  });

  it("unverified target returns isVerified=false + no ABI + abiSource=direct", async () => {
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: false,
        isProxy: false,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", true);
    expect(res.isVerified).toBe(false);
    expect(res.abi).toBeUndefined();
    expect(res.abiSource).toBe("direct");
  });

  it("proxy with no implementation field falls through to direct (no follow attempt)", async () => {
    const proxyAbi = [{ type: "function", name: "fallback" }];
    mockGetContractInfo({
      [proxyAddr.toLowerCase()]: {
        address: proxyAddr,
        chain: "ethereum",
        isVerified: true,
        isProxy: true, // claims proxy but no implementation address
        implementation: undefined,
        abi: proxyAbi,
      },
    });
    const { getContractAbi } = await import("../src/modules/security/contract-abi.js");
    const res = await getContractAbi(proxyAddr, "ethereum", true);
    expect(res.abiSource).toBe("direct");
    expect(res.abi).toEqual(proxyAbi);
  });
});
