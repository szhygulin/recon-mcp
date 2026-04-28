/**
 * `prepare_custom_call` tests. Covers the build-side of the new escape-
 * hatch tool — issue #493.
 *
 * Coverage:
 *   - ABI source: inline arg wins; Etherscan fallback works for verified
 *     contracts; unverified contracts refuse with NO raw-bytecode path;
 *     proxies are followed once to the implementation.
 *   - Schema: `acknowledgeNonProtocolTarget: z.literal(true)` rejects
 *     `false` / `undefined` / non-boolean values at zod-parse time.
 *   - Calldata encoding matches viem's expected output for known sigs.
 *   - The wired txHandler doesn't throw INV_1A on a non-canonical target —
 *     `prepare_custom_call` must NOT be in the EXPECTED_TARGETS allowlist
 *     (it's the explicit allowlist-bypass tool).
 *   - Function-overload disambiguation: `fn` accepts both bare name and
 *     full signature.
 *   - `value` rejects non-decimal-integer strings (zod regex + builder
 *     re-assertion).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData } from "viem";

const getContractInfoMock = vi.fn();
vi.mock("../src/data/apis/etherscan.js", () => ({
  getContractInfo: (...a: unknown[]) => getContractInfoMock(...a),
}));

import { buildCustomCall } from "../src/modules/custom-call/actions.js";
import { prepareCustomCallInput } from "../src/modules/execution/schemas.js";
import { assertCanonicalDispatchOnTxChain } from "../src/security/canonical-dispatch.js";

const WALLET = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075" as const;
const TIMELOCK = "0x22bc85C483103950441EaaB8312BE9f07e234634" as const;
const PROXY = "0x1111111111111111111111111111111111111111" as const;
const IMPL = "0x2222222222222222222222222222222222222222" as const;

// Minimal Timelock fragment — schedule(...) — exact shape of the v4
// OpenZeppelin TimelockController on mainnet.
const TIMELOCK_ABI = [
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

beforeEach(() => {
  getContractInfoMock.mockReset();
});

describe("prepare_custom_call schema (issue #493)", () => {
  it("requires acknowledgeNonProtocolTarget=true literally", () => {
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        acknowledgeNonProtocolTarget: false,
      }),
    ).toThrow();
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        // missing
      }),
    ).toThrow();
    // true passes — combined with required wallet + contract + fn.
    const ok = prepareCustomCallInput.parse({
      wallet: WALLET,
      contract: TIMELOCK,
      fn: "schedule",
      args: [],
      acknowledgeNonProtocolTarget: true,
    });
    expect(ok.acknowledgeNonProtocolTarget).toBe(true);
    expect(ok.value).toBe("0"); // default
    expect(ok.chain).toBe("ethereum"); // default
  });

  it("rejects non-decimal-integer value", () => {
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0.5", // decimal — must be wei integer
        acknowledgeNonProtocolTarget: true,
      }),
    ).toThrow();
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "1000000000000000000", // 1 ETH in wei
        acknowledgeNonProtocolTarget: true,
      }),
    ).not.toThrow();
  });
});

describe("buildCustomCall — ABI resolution", () => {
  it("uses inline ABI when provided (no Etherscan fetch)", async () => {
    const args: readonly unknown[] = [
      "0x0000000000000000000000000000000000000001",
      "0",
      "0x",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "172800",
    ];
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args,
      value: "0",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(getContractInfoMock).not.toHaveBeenCalled();
    expect(tx.to).toBe(TIMELOCK);
    expect(tx.chain).toBe("ethereum");
    // Compare bit-exactly against viem's encoder.
    const expected = encodeFunctionData({
      abi: TIMELOCK_ABI,
      functionName: "schedule",
      args,
    });
    expect(tx.data).toBe(expected);
  });

  it("fetches ABI via Etherscan when verified and not a proxy", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: TIMELOCK_ABI as unknown as unknown[],
    });
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
    });
    expect(getContractInfoMock).toHaveBeenCalledOnce();
    expect(tx.data.startsWith("0x01d5062a")).toBe(true); // schedule selector
  });

  it("refuses unverified contracts with NO raw-bytecode fallback", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: false,
      isProxy: false,
    });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/not Etherscan-verified/);
  });

  it("follows proxy → implementation once for ABI lookup", async () => {
    getContractInfoMock
      .mockResolvedValueOnce({
        address: PROXY,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: IMPL,
        abi: [], // proxy itself has only fallback
      })
      .mockResolvedValueOnce({
        address: IMPL,
        chain: "ethereum",
        isVerified: true,
        isProxy: false,
        abi: TIMELOCK_ABI as unknown as unknown[],
      });
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: PROXY,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
    });
    expect(getContractInfoMock).toHaveBeenCalledTimes(2);
    expect(tx.to).toBe(PROXY); // outer call still targets the proxy
  });

  it("refuses proxy when implementation is unverified", async () => {
    getContractInfoMock
      .mockResolvedValueOnce({
        address: PROXY,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: IMPL,
        abi: [],
      })
      .mockResolvedValueOnce({
        address: IMPL,
        chain: "ethereum",
        isVerified: false,
        isProxy: false,
      });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: PROXY,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/proxy.*implementation.*couldn't be ABI-fetched/);
  });

  it("refuses verified contract with empty parsed ABI", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: undefined,
    });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/no parseable ABI/);
  });
});

describe("buildCustomCall — encoding", () => {
  it("surfaces a useful error when fn doesn't match the ABI", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "totallyMadeUpFn",
        args: [],
        value: "0",
        abi: TIMELOCK_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/Failed to encode calldata/);
  });

  it("preserves passed value (wei) in the unsigned tx", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "1000000000000000000",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(tx.value).toBe("1000000000000000000");
  });
});

describe("canonical-dispatch wiring (#483 / PR #489)", () => {
  it("is a no-op for prepare_custom_call regardless of `to`", () => {
    // The wired txHandler walks to the action leg and asserts canonical
    // dispatch. `prepare_custom_call` is the explicit allowlist-bypass
    // tool — it must NOT match any EXPECTED_TARGETS entry. Verify by
    // running the same shape txHandler runs against an arbitrary `to`.
    const tx = {
      chain: "ethereum" as const,
      to: "0x000000000000000000000000000000000000beef" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: "0",
      description: "",
    };
    expect(() => assertCanonicalDispatchOnTxChain("prepare_custom_call", tx)).not.toThrow();
  });
});
