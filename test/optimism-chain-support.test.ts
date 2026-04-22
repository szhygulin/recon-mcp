import { describe, it, expect } from "vitest";
import {
  CHAIN_IDS,
  CHAIN_ID_TO_NAME,
  SUPPORTED_CHAINS,
} from "../src/types/index.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../src/config/contracts.js";
import { VIEM_CHAINS } from "../src/config/chains.js";

/**
 * Invariants for Optimism (chainId 10) — mirrors base-chain-support.test.ts.
 * Locks the chain registration so removing Optimism requires intentional
 * deletion of this suite rather than a silent refactor of one of the
 * Record<SupportedChain, …> tables.
 */
describe("Optimism chain registration", () => {
  it("is listed in SUPPORTED_CHAINS", () => {
    expect(SUPPORTED_CHAINS).toContain("optimism");
  });

  it("maps to chainId 10 in both directions", () => {
    expect(CHAIN_IDS.optimism).toBe(10);
    expect(CHAIN_ID_TO_NAME[10]).toBe("optimism");
  });

  it("uses ETH as its native symbol", () => {
    expect(NATIVE_SYMBOL.optimism).toBe("ETH");
  });

  it("has a viem Chain registered with matching chainId", () => {
    expect(VIEM_CHAINS.optimism).toBeDefined();
    expect(VIEM_CHAINS.optimism.id).toBe(10);
  });
});

describe("Optimism contract addresses", () => {
  const optimismContracts = CONTRACTS.optimism;

  it("includes Aave V3 deployment triple (provider + uiPoolDataProvider + pool)", () => {
    expect(optimismContracts.aave.poolAddressProvider).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(optimismContracts.aave.uiPoolDataProvider).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(optimismContracts.aave.pool).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("pins the Aave V3 Pool to the canonical Optimism deployment", () => {
    // Used by pre-sign-check.ts as the allowlist entry for Aave txs on
    // Optimism. Hard-pin so a refactor can't silently swap it for an attacker
    // contract. Sourced from bgd-labs/aave-address-book AaveV3Optimism.sol.
    expect(optimismContracts.aave.pool).toBe("0x794a61358D6845594F94dc1DB02A252b5b4814aD");
  });

  it("uses the canonical cross-chain Uniswap V3 deployment (not Base's chain-specific one)", () => {
    // Optimism follows the standard Uniswap V3 addresses shared across
    // Ethereum/Arbitrum/Polygon. Only Base diverged. Pin both factory and
    // SwapRouter02 so a copy-paste from the Base block fails this assertion.
    expect(optimismContracts.uniswap.factory).toBe(
      "0x1F98431c8aD98523631AE4a59f267346ea31F984"
    );
    expect(optimismContracts.uniswap.swapRouter02).toBe(
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    );
  });

  it("includes Compound V3 USDC + WETH + USDT markets", () => {
    expect(optimismContracts.compound.cUSDCv3).toBe(
      "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB"
    );
    expect(optimismContracts.compound.cWETHv3).toBe(
      "0xE36A30D249f7761327fd973001A32010b521b6Fd"
    );
    expect(optimismContracts.compound.cUSDTv3).toBe(
      "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214"
    );
  });

  it("exposes the OP-stack predeploy WETH + native USDC + OP token", () => {
    expect(optimismContracts.tokens.WETH).toBe("0x4200000000000000000000000000000000000006");
    expect(optimismContracts.tokens.USDC).toBe("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
    expect(optimismContracts.tokens.OP).toBe("0x4200000000000000000000000000000000000042");
  });

  it("does NOT register Lido or EigenLayer (L1-only protocols)", () => {
    expect((optimismContracts as Record<string, unknown>).lido).toBeUndefined();
    expect((optimismContracts as Record<string, unknown>).eigenlayer).toBeUndefined();
  });

  it("does NOT register Morpho Blue (deferred — discovery block unverified)", () => {
    // Morpho Blue is deployed on Optimism, but the discovery scan in
    // src/modules/morpho/discover.ts requires a known deployment block.
    // Same tripwire as Base.
    expect((optimismContracts as Record<string, unknown>).morpho).toBeUndefined();
  });
});
