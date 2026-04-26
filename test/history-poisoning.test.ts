import { describe, it, expect } from "vitest";
import { annotatePoisoning } from "../src/modules/history/poisoning.js";
import type {
  ExternalHistoryItem,
  TokenTransferHistoryItem,
  HistoryItem,
} from "../src/modules/history/schemas.js";

/**
 * Pure tests for the poisoning detector (#220). The function mutates
 * items in place; we build minimal HistoryItem fixtures and assert
 * the `suspectedPoisoning` field surfaces (or doesn't) per rule.
 *
 * No network — annotatePoisoning is dependency-free.
 */

const WALLET = "0x1234567890abcdef1234567890abcdef12344075"; // suffix 4075

function ext(opts: {
  hash?: string;
  from: string;
  to: string;
  valueNative?: string;
  valueUsd?: number;
  timestamp?: number;
}): ExternalHistoryItem {
  return {
    type: "external",
    hash: opts.hash ?? `0x${(Math.random() * 1e16).toString(16)}`,
    timestamp: opts.timestamp ?? 1_750_000_000,
    from: opts.from,
    to: opts.to,
    status: "success",
    valueNative: opts.valueNative ?? "0",
    valueNativeFormatted: "0",
    ...(opts.valueUsd !== undefined ? { valueUsd: opts.valueUsd } : {}),
  };
}

function tt(opts: {
  hash?: string;
  from: string;
  to: string;
  amount: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  valueUsd?: number;
}): TokenTransferHistoryItem {
  return {
    type: "token_transfer",
    hash: opts.hash ?? `0x${(Math.random() * 1e16).toString(16)}`,
    timestamp: 1_750_000_000,
    from: opts.from,
    to: opts.to,
    status: "success",
    tokenAddress: opts.tokenAddress ?? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenSymbol: opts.tokenSymbol ?? "USDC",
    tokenDecimals: 6,
    amount: opts.amount,
    amountFormatted: opts.amount,
    ...(opts.valueUsd !== undefined ? { valueUsd: opts.valueUsd } : {}),
  };
}

describe("annotatePoisoning — zero_amount_transfer", () => {
  it("flags a token_transfer with amount === '0'", () => {
    const items: HistoryItem[] = [
      tt({ from: "0xdeadbeef00000000000000000000000000000001", to: WALLET, amount: "0" }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning?.reasons).toEqual(["zero_amount_transfer"]);
  });

  it("does NOT flag a token_transfer with amount > 0", () => {
    const items: HistoryItem[] = [
      tt({ from: "0xdeadbeef00000000000000000000000000000001", to: WALLET, amount: "1000000" }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });

  it("does NOT flag external (non-token) entries even at zero value", () => {
    const items: HistoryItem[] = [
      ext({ from: "0xdeadbeef00000000000000000000000000000001", to: WALLET, valueNative: "0" }),
    ];
    annotatePoisoning(items, WALLET);
    // Zero-amount external isn't a known poisoning class (just an
    // empty contract call); rule 1 is token-transfer only.
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });
});

describe("annotatePoisoning — vanity_suffix_lookalike", () => {
  // Real legit counterparty + a vanity-mined lookalike that mimics it.
  // Both share first-4 (after 0x) `dead` and last-4 `4361`.
  const LEGIT = "0xdead000000000000000000000000000000004361";
  const FAKE = "0xdead111111111111111111111111111111114361";

  it("flags a dust tx whose counterparty mimics another counterparty in the same history", () => {
    const items: HistoryItem[] = [
      // Big legit tx from LEGIT — establishes LEGIT in counterparty set.
      ext({
        from: LEGIT,
        to: WALLET,
        valueNative: "1000000000000000000", // 1 ETH
        valueUsd: 3000,
      }),
      // Dust tx from the lookalike FAKE — should be flagged with
      // mimics: LEGIT.
      ext({
        from: FAKE,
        to: WALLET,
        valueNative: "1", // 1 wei = dust
      }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
    expect(items[1].suspectedPoisoning?.reasons).toEqual(["vanity_suffix_lookalike"]);
    expect(items[1].suspectedPoisoning?.mimics).toBe(LEGIT.toLowerCase());
  });

  it("does NOT flag a non-dust tx even when the counterparty has a lookalike sibling", () => {
    const items: HistoryItem[] = [
      ext({ from: LEGIT, to: WALLET, valueNative: "1000000000000000000" }),
      // FAKE sends a meaningful (non-dust) amount — could be legit-but-
      // -with-a-similar-suffix; suppress the flag (per issue: keep
      // precision high).
      ext({
        from: FAKE,
        to: WALLET,
        valueNative: "100000000000000", // 0.0001 ETH; ~$0.30 — not dust by either threshold
        valueUsd: 0.3,
      }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[1].suspectedPoisoning).toBeUndefined();
  });

  it("treats USD ≤ 0.01 as dust (token-transfer path, no native amount)", () => {
    const items: HistoryItem[] = [
      // Legit USDC transfer that pins the matched-suffix counterparty
      // in the history set.
      tt({ from: LEGIT, to: WALLET, amount: "100000000", valueUsd: 100 }),
      // Dust-USD lookalike token transfer.
      tt({ from: FAKE, to: WALLET, amount: "10", valueUsd: 0.001 }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[1].suspectedPoisoning?.reasons).toEqual(["vanity_suffix_lookalike"]);
    expect(items[1].suspectedPoisoning?.mimics).toBe(LEGIT.toLowerCase());
  });

  it("does NOT flag when only one counterparty matches the suffix (no impersonation pair)", () => {
    const items: HistoryItem[] = [
      // Single dust from a unique address — no matching sibling, so no
      // rule 2 match (and the suffix doesn't match the wallet, so rule
      // 3 is also off).
      ext({
        from: "0xdead111111111111111111111111111111114361",
        to: WALLET,
        valueNative: "1",
      }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });
});

describe("annotatePoisoning — self_suffix_lookalike", () => {
  // WALLET is `0x1234...4075`. Construct a lookalike that mimics the
  // wallet's own first-4/last-4: `1234...4075`.
  const SELF_LOOKALIKE = "0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4075";

  it("flags a dust tx whose counterparty mimics the wallet itself", () => {
    const items: HistoryItem[] = [
      ext({ from: SELF_LOOKALIKE, to: WALLET, valueNative: "1" }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning?.reasons).toEqual(["self_suffix_lookalike"]);
    expect(items[0].suspectedPoisoning?.mimics).toBe(WALLET.toLowerCase());
  });

  it("does NOT flag a self-send (from === to === wallet)", () => {
    const items: HistoryItem[] = [
      ext({ from: WALLET, to: WALLET, valueNative: "1" }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });

  it("prefers `mimics: wallet` when both rule 2 AND rule 3 fire", () => {
    // SELF_LOOKALIKE shares wallet's suffix (1234...4075). Add another
    // counterparty that ALSO shares 1234...4075 — both rules now fire
    // on SELF_LOOKALIKE. The detector should bias `mimics` toward the
    // wallet (more specific / more dangerous claim).
    const ANOTHER_PEER = "0x1234bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb4075";
    const items: HistoryItem[] = [
      ext({ from: ANOTHER_PEER, to: WALLET, valueNative: "1000000000000000000" }),
      ext({ from: SELF_LOOKALIKE, to: WALLET, valueNative: "1" }),
    ];
    annotatePoisoning(items, WALLET);
    const reasons = items[1].suspectedPoisoning?.reasons ?? [];
    expect(reasons).toContain("vanity_suffix_lookalike");
    expect(reasons).toContain("self_suffix_lookalike");
    expect(items[1].suspectedPoisoning?.mimics).toBe(WALLET.toLowerCase());
  });
});

describe("annotatePoisoning — combined / negative cases", () => {
  it("combines zero_amount + vanity_suffix when a token-transfer is both 0-amount AND a lookalike", () => {
    const LEGIT = "0xdead000000000000000000000000000000004361";
    const FAKE = "0xdead111111111111111111111111111111114361";
    const items: HistoryItem[] = [
      tt({ from: LEGIT, to: WALLET, amount: "1000000", valueUsd: 1 }),
      tt({ from: FAKE, to: WALLET, amount: "0" }),
    ];
    annotatePoisoning(items, WALLET);
    const reasons = items[1].suspectedPoisoning?.reasons ?? [];
    expect(reasons).toContain("zero_amount_transfer");
    // Zero-amount tokens have no native value AND no valueUsd, so the
    // dust check returns false → vanity rule is not evaluated. Just
    // the zero-amount flag.
    expect(reasons).toEqual(["zero_amount_transfer"]);
  });

  it("does NOT flag clean activity (legit dust gas-refund without suffix match)", () => {
    const items: HistoryItem[] = [
      ext({
        from: "0x9999999999999999999999999999999999999999",
        to: WALLET,
        valueNative: "1", // dust — but no suffix match, no zero token, no self-mimic
      }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });

  it("normalizes case: mixed-case fixtures still match each other", () => {
    // Same address, mixed case (EIP-55 checksummed vs lowercase).
    const LEGIT_CHECKSUM = "0xDeAd000000000000000000000000000000004361";
    const LEGIT_LOWER = "0xdead000000000000000000000000000000004361";
    const FAKE = "0xdead111111111111111111111111111111114361";
    const items: HistoryItem[] = [
      ext({ from: LEGIT_CHECKSUM, to: WALLET, valueNative: "1000000000000000000" }),
      ext({ from: FAKE, to: WALLET, valueNative: "1" }),
    ];
    annotatePoisoning(items, WALLET);
    expect(items[1].suspectedPoisoning?.reasons).toEqual(["vanity_suffix_lookalike"]);
    expect(items[1].suspectedPoisoning?.mimics).toBe(LEGIT_LOWER);
  });

  it("zero-amount rule still applies on TRON (non-EVM wallet shape)", () => {
    // TRON wallet (T-prefix base58); rule 1 is chain-agnostic.
    const TRON_WALLET = "TXYZabcdefghijkmnopqrstuvwxyz23456";
    const items: HistoryItem[] = [
      tt({
        from: "TFakeBeefdeadbeefdeadbeefdeadbeefDe",
        to: TRON_WALLET,
        amount: "0",
        tokenSymbol: "USDT",
      }),
    ];
    annotatePoisoning(items, TRON_WALLET);
    expect(items[0].suspectedPoisoning?.reasons).toEqual(["zero_amount_transfer"]);
    // Suffix rules don't fire on non-EVM wallets — no mimics.
    expect(items[0].suspectedPoisoning?.mimics).toBeUndefined();
  });

  it("suffix rules do NOT fire on non-EVM wallets even when they could match", () => {
    const TRON_WALLET = "TXYZabcdefghijkmnopqrstuvwxyz23456";
    const items: HistoryItem[] = [
      ext({
        from: "TXYZ_lookalike_dead_dead_dead_23456",
        to: TRON_WALLET,
        valueNative: "1",
      }),
    ];
    annotatePoisoning(items, TRON_WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });
});
