/**
 * `read_contract` tests. Covers the new generic view/pure ABI reader — issue #602.
 *
 * Coverage:
 *   - Happy path: `getRoleMember(EXECUTOR_ROLE, 0)` against a Timelock-shape ABI
 *     (the issue's exact reproducer).
 *   - ABI source: inline arg wins; Etherscan fallback works for verified
 *     contracts; unverified contracts refuse; proxies are followed once.
 *   - Refusal: state-changing function (`stateMutability: "nonpayable"`) refuses
 *     with STATE_CHANGING_FN — `eth_call` would simulate and return a misleading
 *     hypothetical.
 *   - Refusal: function not in ABI returns "did you mean" hint.
 *   - Refusal: ambiguous overload requires full signature.
 *   - Full-signature path resolves to the right overload.
 *   - resultRaw is captured alongside the decoded result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getContractInfoMock = vi.fn();
vi.mock("../src/data/apis/etherscan.js", () => ({
  getContractInfo: (...a: unknown[]) => getContractInfoMock(...a),
}));

const readContractMock = vi.fn();
const callMock = vi.fn();
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: (...a: unknown[]) => readContractMock(...a),
    call: (...a: unknown[]) => callMock(...a),
  }),
}));

import { readContract } from "../src/modules/read-contract/actions.js";

const TIMELOCK = "0x22bc85C483103950441EaaB8312BE9f07e234634" as const;
const SAFE = "0x1111111111111111111111111111111111111111" as const;
const PROXY = "0x2222222222222222222222222222222222222222" as const;
const IMPL = "0x3333333333333333333333333333333333333333" as const;

// EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE")
const EXECUTOR_ROLE = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469482" as const;

const TIMELOCK_ABI = [
  {
    type: "function",
    name: "getRoleMember",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getRoleMemberCount",
    stateMutability: "view",
    inputs: [{ name: "role", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const OVERLOADED_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

beforeEach(() => {
  getContractInfoMock.mockReset();
  readContractMock.mockReset();
  callMock.mockReset();
});

describe("read_contract — issue #602 reproducer", () => {
  it("resolves getRoleMember(EXECUTOR_ROLE, 0) on a verified timelock", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: TIMELOCK_ABI,
    });
    readContractMock.mockResolvedValueOnce(SAFE);
    callMock.mockResolvedValueOnce({
      data: ("0x" + "0".repeat(24) + SAFE.slice(2)) as `0x${string}`,
    });

    const out = await readContract({
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "getRoleMember",
      args: [EXECUTOR_ROLE, 0],
    });

    expect(out.function).toBe("getRoleMember(bytes32,uint256)");
    expect(out.result).toBe(SAFE);
    expect(out.abiSource).toBe("etherscan");
    expect(out.contractIsProxy).toBe(false);
    expect(out.resultRaw).toMatch(/^0x/);
  });
});

describe("read_contract ABI sourcing", () => {
  it("inline ABI wins over Etherscan fetch", async () => {
    readContractMock.mockResolvedValueOnce(0n);
    callMock.mockResolvedValueOnce({ data: "0x00" });

    const out = await readContract({
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "getRoleMemberCount",
      args: [EXECUTOR_ROLE],
      abi: TIMELOCK_ABI as unknown as unknown[],
    });

    expect(out.abiSource).toBe("user-supplied");
    expect(getContractInfoMock).not.toHaveBeenCalled();
  });

  it("refuses on unverified contract with no inline ABI", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: false,
      isProxy: false,
    });

    await expect(
      readContract({
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "getRoleMember",
        args: [EXECUTOR_ROLE, 0],
      }),
    ).rejects.toThrow(/not Etherscan-verified/);
  });

  it("follows proxy to implementation ABI", async () => {
    getContractInfoMock
      .mockResolvedValueOnce({
        address: PROXY,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: IMPL,
      })
      .mockResolvedValueOnce({
        address: IMPL,
        chain: "ethereum",
        isVerified: true,
        isProxy: false,
        abi: TIMELOCK_ABI,
      });
    readContractMock.mockResolvedValueOnce(SAFE);
    callMock.mockResolvedValueOnce({ data: "0x" });

    const out = await readContract({
      chain: "ethereum",
      contract: PROXY,
      fn: "getRoleMember",
      args: [EXECUTOR_ROLE, 0],
    });

    expect(out.contractIsProxy).toBe(true);
    expect(out.implementationAddress).toBe(IMPL);
  });
});

describe("read_contract refusal taxonomy", () => {
  it("refuses on state-changing function (nonpayable)", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: TIMELOCK_ABI,
    });

    await expect(
      readContract({
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "schedule",
        args: [SAFE, "0"],
      }),
    ).rejects.toThrow(/STATE_CHANGING_FN/);
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("refuses on unknown function name with did-you-mean hint", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: TIMELOCK_ABI,
    });

    await expect(
      readContract({
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "getRole",
        args: [],
      }),
    ).rejects.toThrow(/Did you mean.*getRoleMember/);
  });

  it("refuses on ambiguous overload, requires full signature", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: OVERLOADED_ABI,
    });

    await expect(
      readContract({
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "transfer",
        args: [SAFE, "0"],
      }),
    ).rejects.toThrow(/overloaded.*Pass the full signature/);
  });

  it("full-signature path resolves the right overload", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: OVERLOADED_ABI,
    });
    readContractMock.mockResolvedValueOnce(true);
    callMock.mockResolvedValueOnce({ data: "0x01" });

    const out = await readContract({
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "transfer(address,uint256,bytes)",
      args: [SAFE, "0", "0x"],
    });

    expect(out.function).toBe("transfer(address,uint256,bytes)");
    expect(out.result).toBe(true);
  });
});
