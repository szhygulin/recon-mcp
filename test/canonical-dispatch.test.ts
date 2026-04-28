import { describe, it, expect } from "vitest";
import {
  assertCanonicalDispatchTarget,
  assertCanonicalDispatchOnTxChain,
  _enumerateAllowlistForTests,
} from "../src/security/canonical-dispatch.js";
import { CONTRACTS } from "../src/config/contracts.js";
import type { UnsignedTx } from "../src/types/index.js";

/**
 * These tests pin the MCP-side mirror of skill v8's Invariant #1.a.
 * Two contracts are guarded:
 *
 *   1. Every entry in EXPECTED_TARGETS resolves to a real CONTRACTS
 *      address — i.e. the allowlist cannot silently fall out of sync
 *      with the source-of-truth file.
 *   2. The asserter throws on mismatch (with the canonical
 *      `[INV_1A]` / `✗ DISPATCH-TARGET MISMATCH` prose) and is a
 *      no-op for tools outside the allowlist (sends, etc.).
 */

describe("canonical-dispatch — Invariant #1.a MCP-side mirror", () => {
  it("every allowlist address resolves to a real CONTRACTS entry", () => {
    const enumerated = _enumerateAllowlistForTests();
    expect(enumerated.length).toBeGreaterThan(0);

    // Build the inverse: every lower-cased CONTRACTS address that
    // appears anywhere under any chain.
    const knownAddresses = new Set<string>();
    for (const chain of Object.values(CONTRACTS) as Array<Record<string, unknown>>) {
      walkValues(chain, (v) => {
        if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) {
          knownAddresses.add(v.toLowerCase());
        }
      });
    }

    for (const { family, chain, addresses } of enumerated) {
      for (const addr of addresses) {
        expect(
          knownAddresses.has(addr),
          `${family} on ${chain}: ${addr} is not in CONTRACTS — drift detected`,
        ).toBe(true);
      }
    }
  });

  it("throws on mismatch for a guarded tool family with the canonical prose", () => {
    // Aave Pool on Ethereum is 0x87870Bca... — feed a bogus address.
    const bogus = "0x000000000000000000000000000000000000dead";
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", bogus),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", bogus),
    ).toThrow(/INV_1A/);
  });

  it("passes when `to` is the canonical Aave Pool (case-insensitive)", () => {
    const pool = CONTRACTS.ethereum.aave.pool;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", pool),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_aave_supply",
        "ethereum",
        pool.toLowerCase(),
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_aave_supply",
        "ethereum",
        pool.toUpperCase().replace("0X", "0x"),
      ),
    ).not.toThrow();
  });

  it("matches by tool-family prefix — covers prepare_aave_borrow / _withdraw / _repay", () => {
    const pool = CONTRACTS.ethereum.aave.pool;
    for (const tool of [
      "prepare_aave_supply",
      "prepare_aave_withdraw",
      "prepare_aave_borrow",
      "prepare_aave_repay",
    ]) {
      expect(() =>
        assertCanonicalDispatchTarget(tool, "ethereum", pool),
      ).not.toThrow();
    }
  });

  it("Compound family accepts any of the chain's canonical Comets", () => {
    const cUSDC = CONTRACTS.ethereum.compound.cUSDCv3;
    const cUSDT = CONTRACTS.ethereum.compound.cUSDTv3;
    const cWETH = CONTRACTS.ethereum.compound.cWETHv3;
    for (const comet of [cUSDC, cUSDT, cWETH]) {
      expect(() =>
        assertCanonicalDispatchTarget("prepare_compound_supply", "ethereum", comet),
      ).not.toThrow();
    }
  });

  it("Lido stake/unstake are Ethereum-only — throws on other chains", () => {
    const stETH = CONTRACTS.ethereum.lido.stETH;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_stake", "ethereum", stETH),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_lido_stake",
        "arbitrum",
        "0x0000000000000000000000000000000000000001",
      ),
    ).toThrow(/INV_1A/);
  });

  it("most-specific tool match wins — prepare_lido_unstake doesn't pick prepare_lido_*", () => {
    // prepare_lido_stake's allowlist is just stETH; prepare_lido_unstake
    // includes stETH AND withdrawalQueue. Asserting withdrawalQueue against
    // unstake should pass; against stake should fail.
    const queue = CONTRACTS.ethereum.lido.withdrawalQueue;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_unstake", "ethereum", queue),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_stake", "ethereum", queue),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
  });

  it("Uniswap swap targets SwapRouter02; v3 mint/collect/burn target NPM", () => {
    const router = CONTRACTS.ethereum.uniswap.swapRouter02;
    const npm = CONTRACTS.ethereum.uniswap.positionManager;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_swap", "ethereum", router),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_v3_mint", "ethereum", npm),
    ).not.toThrow();
    // Cross-fail: swap to NPM, or v3_mint to router
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_swap", "ethereum", npm),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_v3_mint", "ethereum", router),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
  });

  it("EigenLayer deposit is Ethereum-only", () => {
    const sm = CONTRACTS.ethereum.eigenlayer.strategyManager;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_eigenlayer_deposit", "ethereum", sm),
    ).not.toThrow();
  });

  it("is a no-op for tools without a canonical target (sends, swaps to user-supplied tokens)", () => {
    // prepare_native_send / prepare_token_send target user-supplied
    // addresses; not guarded.
    const arbitrary = "0x000000000000000000000000000000000000beef";
    expect(() =>
      assertCanonicalDispatchTarget("prepare_native_send", "ethereum", arbitrary),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_token_send", "ethereum", arbitrary),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_solana_native_send", "ethereum", arbitrary),
    ).not.toThrow();
  });
});

describe("assertCanonicalDispatchOnTxChain — txHandler wiring shape (issue #483)", () => {
  // The wiring inside `txHandler` (src/index.ts) walks the `next` chain to
  // its tail, then calls `assertCanonicalDispatchTarget` against the tail's
  // chain + to. These tests pin that contract end-to-end, exercising the
  // exact helper `txHandler` calls — so a refactor that breaks the
  // walk-to-tail step (or skips the assertion) fails here.

  const aavePool = CONTRACTS.ethereum.aave.pool as `0x${string}`;
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
  const stETH = CONTRACTS.ethereum.lido.stETH as `0x${string}`;
  const npm = CONTRACTS.ethereum.uniswap.positionManager as `0x${string}`;
  const swapRouter = CONTRACTS.ethereum.uniswap.swapRouter02 as `0x${string}`;
  const cUSDCv3 = CONTRACTS.ethereum.compound.cUSDCv3 as `0x${string}`;
  const morphoBlue = CONTRACTS.ethereum.morpho.blue as `0x${string}`;
  const eigenSM = CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`;
  const bogus = "0x000000000000000000000000000000000000dead" as `0x${string}`;

  function leg(to: `0x${string}`, next?: UnsignedTx): UnsignedTx {
    return {
      chain: "ethereum",
      to,
      data: "0x",
      value: "0",
      description: "",
      ...(next ? { next } : {}),
    };
  }

  it("approve→action chain: tail-leg `to` outside allowlist throws INV_1A (Aave supply)", () => {
    const chain = leg(usdc, leg(bogus));
    expect(() => assertCanonicalDispatchOnTxChain("prepare_aave_supply", chain)).toThrow(
      /INV_1A.*DISPATCH-TARGET MISMATCH/,
    );
  });

  it("approve→action chain: canonical tail-leg `to` passes (token contract at head is ignored)", () => {
    // Approval to USDC sits ahead of an Aave Pool action. The walk-to-tail
    // skips the approval leg (token contract is never canonical) and
    // checks the action leg against the allowlist.
    const chain = leg(usdc, leg(aavePool));
    expect(() => assertCanonicalDispatchOnTxChain("prepare_aave_supply", chain)).not.toThrow();
  });

  it("single-tx flows (no approval): canonical `to` passes, bogus throws (Lido stake)", () => {
    expect(() => assertCanonicalDispatchOnTxChain("prepare_lido_stake", leg(stETH))).not.toThrow();
    expect(() => assertCanonicalDispatchOnTxChain("prepare_lido_stake", leg(bogus))).toThrow(
      /INV_1A/,
    );
  });

  it("Compound supply chain: builder substituting an off-allowlist Comet at the tail throws", () => {
    const chain = leg(usdc, leg(bogus));
    expect(() => assertCanonicalDispatchOnTxChain("prepare_compound_supply", chain)).toThrow(
      /INV_1A.*DISPATCH-TARGET MISMATCH/,
    );
    // Canonical Comet on the tail passes.
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_compound_supply", leg(usdc, leg(cUSDCv3))),
    ).not.toThrow();
  });

  it("Morpho supply chain: bogus tail throws, Morpho Blue tail passes", () => {
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_morpho_supply", leg(usdc, leg(bogus))),
    ).toThrow(/INV_1A/);
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_morpho_supply", leg(usdc, leg(morphoBlue))),
    ).not.toThrow();
  });

  it("Uniswap swap chain (approve→swap): bogus router-substitute throws, SwapRouter02 passes", () => {
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_uniswap_swap", leg(usdc, leg(bogus))),
    ).toThrow(/INV_1A/);
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_uniswap_swap", leg(usdc, leg(swapRouter))),
    ).not.toThrow();
  });

  it("Uniswap V3 mint chain (approve→approve→mint): two-deep tail walk hits the NPM leg", () => {
    const wbtc = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as `0x${string}`;
    // Two approvals (token0, token1) precede the NPM mint.
    expect(() =>
      assertCanonicalDispatchOnTxChain(
        "prepare_uniswap_v3_mint",
        leg(usdc, leg(wbtc, leg(npm))),
      ),
    ).not.toThrow();
    // Substituted final leg is caught.
    expect(() =>
      assertCanonicalDispatchOnTxChain(
        "prepare_uniswap_v3_mint",
        leg(usdc, leg(wbtc, leg(bogus))),
      ),
    ).toThrow(/INV_1A/);
  });

  it("EigenLayer deposit (approve→deposit): bogus tail throws, StrategyManager passes", () => {
    expect(() =>
      assertCanonicalDispatchOnTxChain(
        "prepare_eigenlayer_deposit",
        leg(usdc, leg(bogus)),
      ),
    ).toThrow(/INV_1A/);
    expect(() =>
      assertCanonicalDispatchOnTxChain(
        "prepare_eigenlayer_deposit",
        leg(usdc, leg(eigenSM)),
      ),
    ).not.toThrow();
  });

  it("non-guarded prepare_* (sends, LiFi swap): wiring is a no-op even with arbitrary `to`", () => {
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_native_send", leg(bogus)),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_token_send", leg(usdc, leg(bogus))),
    ).not.toThrow();
    // prepare_swap (LiFi) is not in the allowlist either — the helper short-circuits.
    expect(() =>
      assertCanonicalDispatchOnTxChain("prepare_swap", leg(bogus)),
    ).not.toThrow();
  });
});

function walkValues(obj: unknown, fn: (v: unknown) => void): void {
  if (obj === null || obj === undefined) return;
  fn(obj);
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) walkValues(v, fn);
  } else if (Array.isArray(obj)) {
    for (const v of obj) walkValues(v, fn);
  }
}
