/**
 * Issue #88 regression: `coverage.compound.note` used to be a generic
 * "fetch failed on at least one market" string, leaving the agent with no
 * way to tell the user which market/chain was broken or whether it was
 * worth retrying. The portfolio aggregator now plumbs the per-market
 * failure detail from `getCompoundPositions.erroredMarkets` into the note.
 */
import { describe, it, expect } from "vitest";
import { formatCompoundErrorNote } from "../src/modules/portfolio/index.js";

describe("formatCompoundErrorNote (#88)", () => {
  it("falls back to the generic message when no per-market detail is available", () => {
    const note = formatCompoundErrorNote(undefined);
    expect(note).toMatch(/fetch failed on at least one market/);
    // No "Failures:" suffix when we have nothing concrete to attach.
    expect(note).not.toMatch(/Failures:/);
  });

  it("appends per-chain + per-market + raw error text when details are present", () => {
    const note = formatCompoundErrorNote([
      {
        chain: "ethereum",
        market: "cUSDCv3",
        error: "multicall3 returned 0x for balanceOf",
      },
      {
        chain: "base",
        market: "cUSDCv3",
        error: "connection reset by peer",
      },
    ]);
    expect(note).toMatch(
      /ethereum\/cUSDCv3: multicall3 returned 0x for balanceOf/,
    );
    expect(note).toMatch(/base\/cUSDCv3: connection reset by peer/);
    // Pointer to the deeper tool so the agent knows where to dig on the
    // user's behalf; generic hint is preserved.
    expect(note).toContain("get_compound_positions");
    expect(note).toMatch(/fetch failed on at least one market/);
  });

  it("truncates very long error strings so the note stays readable (get_compound_positions has the full detail)", () => {
    const giant = "x".repeat(500);
    const note = formatCompoundErrorNote([
      { chain: "arbitrum", market: "cUSDCv3", error: giant },
    ]);
    // Truncation cap ~120 chars + ellipsis; the full 500-char string must
    // not appear intact.
    expect(note).not.toContain(giant);
    expect(note).toMatch(/…/);
    expect(note).toContain("arbitrum/cUSDCv3:");
  });

  it("joins multiple market failures with a readable separator", () => {
    const note = formatCompoundErrorNote([
      { chain: "ethereum", market: "cUSDCv3", error: "rpc timeout" },
      { chain: "ethereum", market: "cWETHv3", error: "rpc timeout" },
      { chain: "polygon", market: "cUSDCv3", error: "chain not deployed" },
    ]);
    // Each failure is its own delimited entry; the agent can mentally parse
    // three concerns rather than one indistinct blob.
    const failureSegment = note.match(/Failures: (.+?)\. Call/);
    expect(failureSegment).not.toBeNull();
    const parts = failureSegment![1].split("; ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("ethereum/cUSDCv3");
    expect(parts[1]).toContain("ethereum/cWETHv3");
    expect(parts[2]).toContain("polygon/cUSDCv3");
  });
});
