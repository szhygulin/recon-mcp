import { describe, it, expect } from "vitest";
import {
  INTERMEDIATE_CHAIN_BRIDGES,
  matchIntermediateChainBridge,
} from "../src/modules/swap/intermediate-chain-bridges.js";

/**
 * Pin the literal chain-ID values in INTERMEDIATE_CHAIN_BRIDGES so a
 * developer typo, accidental rebase fixup, or merge-conflict
 * mis-resolution that drifts the constant is caught at CI time.
 *
 * THIS IS A SECURITY TEST. The whole tamper-resistance argument for the
 * chainId-mismatch defense's NEAR-Intents allowlist rests on the
 * intermediate chain ID being a hardcoded literal. If this test goes
 * red, do NOT update the expected value to make it pass — investigate
 * what changed in the source and why.
 */
describe("INTERMEDIATE_CHAIN_BRIDGES — literal-value pin (security)", () => {
  it("pins NEAR Intents at LiFi's published pseudo-chain ID (1885080386571452)", () => {
    const near = INTERMEDIATE_CHAIN_BRIDGES.find(
      (e) => e.bridgeName === "near",
    );
    expect(near).toBeDefined();
    // If THIS literal needs to change, the bridge protocol changed
    // identifiers — confirm against li.quest/v1/chains and update both
    // this test and the source constant in the same commit.
    expect(near?.intermediateChainId).toBe(1885080386571452n);
  });

  it("entries are immutable in shape — every entry has a non-empty lowercase bridge name and a positive bigint chain ID", () => {
    expect(INTERMEDIATE_CHAIN_BRIDGES.length).toBeGreaterThan(0);
    for (const entry of INTERMEDIATE_CHAIN_BRIDGES) {
      expect(entry.bridgeName).toBe(entry.bridgeName.toLowerCase());
      expect(entry.bridgeName.length).toBeGreaterThan(0);
      expect(typeof entry.intermediateChainId).toBe("bigint");
      expect(entry.intermediateChainId).toBeGreaterThan(0n);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("matchIntermediateChainBridge", () => {
  it("matches a NEAR-bridge / NEAR-chain-ID pair (case-insensitive on bridge name)", () => {
    const m = matchIntermediateChainBridge({
      bridge: "near",
      destinationChainId: 1885080386571452n,
    });
    expect(m).not.toBeNull();
    expect(m?.bridgeName).toBe("near");

    // Case-insensitive: real LiFi responses use "near" lowercase, but
    // a bridge label arriving as "NEAR" or "Near" should still match
    // — the `===` security boundary is on the chain ID, not on case.
    expect(
      matchIntermediateChainBridge({
        bridge: "NEAR",
        destinationChainId: 1885080386571452n,
      }),
    ).not.toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "Near",
        destinationChainId: 1885080386571452n,
      }),
    ).not.toBeNull();
  });

  it("REJECTS bridge=NEAR with a non-NEAR chain ID (chain-ID tamper attempt)", () => {
    // Attacker spoofs the bridge name "near" but encodes some other
    // chain ID, hoping the allowlist match is name-only. Must be null.
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 728126428n, // TRON
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 99999999n, // arbitrary
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 0n,
      }),
    ).toBeNull();
  });

  it("REJECTS the NEAR chain ID with a non-NEAR bridge name (bridge-name tamper attempt)", () => {
    // Attacker uses NEAR's chain ID but labels the bridge as "across"
    // — hoping the allowlist match is chain-ID-only. Must be null.
    expect(
      matchIntermediateChainBridge({
        bridge: "across",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "wormhole",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
  });

  it("REJECTS unknown (bridge, chain) pairs entirely", () => {
    expect(
      matchIntermediateChainBridge({
        bridge: "across",
        destinationChainId: 42161n, // arbitrum, a real chain
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "made-up-bridge",
        destinationChainId: 1n,
      }),
    ).toBeNull();
  });
});
