import { describe, it, expect } from "vitest";
import {
  CHAIN_IDS,
  CHAIN_ID_TO_NAME,
  SUPPORTED_CHAINS,
} from "../src/types/index.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../src/config/contracts.js";
import { VIEM_CHAINS } from "../src/config/chains.js";

/**
 * Invariants for Base (chainId 8453) — the goal of this file is to lock the
 * chain registration down so removing Base requires intentional deletion of
 * this suite rather than a silent refactor of one of the Record<SupportedChain, …>
 * tables.
 */
describe("Base chain registration", () => {
  it("is listed in SUPPORTED_CHAINS", () => {
    expect(SUPPORTED_CHAINS).toContain("base");
  });

  it("maps to chainId 8453 in both directions", () => {
    expect(CHAIN_IDS.base).toBe(8453);
    expect(CHAIN_ID_TO_NAME[8453]).toBe("base");
  });

  it("uses ETH as its native symbol", () => {
    expect(NATIVE_SYMBOL.base).toBe("ETH");
  });

  it("has a viem Chain registered with matching chainId", () => {
    expect(VIEM_CHAINS.base).toBeDefined();
    expect(VIEM_CHAINS.base.id).toBe(8453);
  });
});

describe("Base contract addresses", () => {
  const baseContracts = CONTRACTS.base;

  it("includes Aave V3 deployment triple (provider + uiPoolDataProvider + pool)", () => {
    expect(baseContracts.aave.poolAddressProvider).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(baseContracts.aave.uiPoolDataProvider).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(baseContracts.aave.pool).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("pins the Aave V3 Pool to the canonical Base deployment", () => {
    // This address is used by pre-sign-check.ts as the allowlist entry for
    // Aave txs on Base. A refactor that changes it would let a compromised
    // RPC forge a malicious pool past the safety check, so we hard-pin.
    expect(baseContracts.aave.pool).toBe("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
  });

  it("includes Uniswap V3 PositionManager + factory", () => {
    expect(baseContracts.uniswap.positionManager).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(baseContracts.uniswap.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("includes Compound V3 USDC + WETH markets", () => {
    expect(baseContracts.compound.cUSDCv3).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(baseContracts.compound.cWETHv3).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("exposes WETH + native USDC in tokens", () => {
    // WETH on Base is the canonical L2 predeploy address (0x4200…0006); the
    // native Circle-issued USDC is the one we expose as `USDC`.
    expect(baseContracts.tokens.WETH).toBe("0x4200000000000000000000000000000000000006");
    expect(baseContracts.tokens.USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("does NOT register Lido or EigenLayer (L1-only protocols)", () => {
    // Reader modules short-circuit when these keys are absent. Regressing
    // here (e.g. copy-pasting mainnet's `lido` entry onto Base) would send
    // Lido queries to random addresses.
    expect((baseContracts as Record<string, unknown>).lido).toBeUndefined();
    expect((baseContracts as Record<string, unknown>).eigenlayer).toBeUndefined();
  });

  it("does NOT register Morpho Blue (deferred — discovery block unverified)", () => {
    // Morpho Blue IS deployed on Base at the same address as mainnet, but
    // we can't enable the discover-by-event-logs path until the deployment
    // block is pinned. This test exists as a tripwire so the deferral isn't
    // silently undone.
    expect((baseContracts as Record<string, unknown>).morpho).toBeUndefined();
  });
});

describe("Cross-module Base wiring", () => {
  it("every Record<SupportedChain, …> in the codebase has an entry for base (sampled via public re-exports)", () => {
    // We sample the tables most prone to drift. The type-checker already
    // enforces exhaustiveness at build-time, but this catches a regression
    // where someone widens one of these to `Partial<Record<…>>` and forgets
    // to re-add `base`.
    for (const chain of SUPPORTED_CHAINS) {
      expect(VIEM_CHAINS[chain], `VIEM_CHAINS.${chain}`).toBeDefined();
      expect(NATIVE_SYMBOL[chain], `NATIVE_SYMBOL.${chain}`).toBeTruthy();
      expect(CHAIN_IDS[chain], `CHAIN_IDS.${chain}`).toBeTypeOf("number");
    }
  });
});
