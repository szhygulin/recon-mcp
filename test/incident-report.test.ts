/**
 * Issue #425 v1 — `build_incident_report` read tool.
 *
 * Coverage:
 *   - redactAddress fuzzes EVM / Solana / TRON / BTC / tx hashes;
 *     leaves non-address strings alone.
 *   - redactEnvelope walks nested objects / arrays.
 *   - redactAmountUsd buckets only under "all".
 *   - buildIncidentReport (scope: "session", no wallet) — gathers
 *     demo-mode + pairings + notices, no on-chain reads, returns
 *     a narrative.
 *   - buildIncidentReport (scope: "wallet", missing wallet arg) —
 *     records wallet_context_error in the envelope rather than
 *     throwing, so the report still ships.
 *   - Deterministic incident_id collapses to the same value on a
 *     re-run within the same minute bucket.
 *   - Redaction default is "addresses": full-hex EVM addresses
 *     never appear in the rendered narrative for that mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  redactAddress,
  redactEnvelope,
  redactAmountUsd,
} from "../src/modules/incident-report/redact.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL_WHALE = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const TRON_WHALE = "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm";
const BTC_BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";
const BTC_LEGACY = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const TX_HASH = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("redactAddress — fuzzes addresses, leaves other strings alone", () => {
  it("EVM: 0x + first-4 + ellipsis + last-4", () => {
    const out = redactAddress(VITALIK, "addresses");
    expect(out).toBe("0xd8dA…6045");
    expect(out).not.toContain("BF26964aF9D7"); // middle hex stripped
  });

  it("Solana: first-4 + ellipsis + last-4", () => {
    expect(redactAddress(SOL_WHALE, "addresses")).toBe("H8sM…3WjS");
  });

  it("TRON: T + first-4-after-prefix + ellipsis + last-4", () => {
    expect(redactAddress(TRON_WHALE, "addresses")).toBe("TQrY8…4STm");
  });

  it("Bitcoin bech32: keep prefix + last-4", () => {
    expect(redactAddress(BTC_BECH, "addresses")).toBe("bc1qm3…7s3h");
  });

  it("Bitcoin legacy: first-4 + ellipsis + last-4", () => {
    expect(redactAddress(BTC_LEGACY, "addresses")).toBe("1A1z…vfNa");
  });

  it("EVM tx hash: 0x + first-4 + ellipsis + last-4", () => {
    expect(redactAddress(TX_HASH, "addresses")).toBe("0xabcd…6789");
  });

  it("non-address strings pass through unchanged", () => {
    expect(redactAddress("USDC", "addresses")).toBe("USDC");
    expect(redactAddress("hello world", "addresses")).toBe("hello world");
    expect(redactAddress("0xnotahex", "addresses")).toBe("0xnotahex");
  });

  it("mode 'none' returns input unchanged", () => {
    expect(redactAddress(VITALIK, "none")).toBe(VITALIK);
    expect(redactAddress(SOL_WHALE, "none")).toBe(SOL_WHALE);
  });
});

describe("redactAmountUsd — buckets only in 'all' mode", () => {
  it("'addresses' mode preserves exact USD value", () => {
    expect(redactAmountUsd(123.45, "addresses")).toBe("$123.45");
    expect(redactAmountUsd(0, "addresses")).toBe("$0.00");
  });

  it("'all' mode buckets to coarse ranges", () => {
    expect(redactAmountUsd(0, "all")).toBe("$0");
    expect(redactAmountUsd(5, "all")).toBe("<$10");
    expect(redactAmountUsd(50, "all")).toBe("~$10–100");
    expect(redactAmountUsd(500, "all")).toBe("~$100–1k");
    expect(redactAmountUsd(5_000, "all")).toBe("~$1k–10k");
    expect(redactAmountUsd(50_000, "all")).toBe("~$10k–100k");
    expect(redactAmountUsd(500_000, "all")).toBe("~$100k–1M");
    expect(redactAmountUsd(5_000_000, "all")).toBe("~$1M+");
  });
});

describe("redactEnvelope — recursive walk + USD bucketing under 'all'", () => {
  it("recurses into nested objects and arrays", () => {
    const input = {
      wallet: VITALIK,
      pairings: [{ chain: "solana", address: SOL_WHALE }],
      meta: { txHash: TX_HASH, label: "test" },
    };
    const out = redactEnvelope(input, "addresses");
    expect((out as typeof input).wallet).toBe("0xd8dA…6045");
    expect((out as typeof input).pairings[0]!.address).toBe("H8sM…3WjS");
    expect((out as typeof input).meta.txHash).toBe("0xabcd…6789");
    expect((out as typeof input).meta.label).toBe("test");
  });

  it("does not mutate the input object", () => {
    const input = { wallet: VITALIK };
    redactEnvelope(input, "addresses");
    expect(input.wallet).toBe(VITALIK); // unchanged
  });

  it("'all' mode buckets *Usd / *USD field-name suffixes", () => {
    const input = { totalUsd: 12_345.67, valueUSD: 50, plain: 100 };
    const out = redactEnvelope(input, "all") as Record<string, unknown>;
    expect(out.totalUsd).toBe("~$10k–100k");
    expect(out.valueUSD).toBe("~$10–100");
    expect(out.plain).toBe(100); // not USD-suffixed → untouched
  });

  it("'none' returns input reference unchanged", () => {
    const input = { wallet: VITALIK };
    const out = redactEnvelope(input, "none");
    expect(out).toBe(input); // same reference
  });
});

describe("buildIncidentReport — session scope (no on-chain reads)", () => {
  let savedDemo: string | undefined;

  beforeEach(async () => {
    savedDemo = process.env.VAULTPILOT_DEMO;
    delete process.env.VAULTPILOT_DEMO;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
  });

  afterEach(async () => {
    if (savedDemo === undefined) delete process.env.VAULTPILOT_DEMO;
    else process.env.VAULTPILOT_DEMO = savedDemo;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _resetAutoDemoLatchForTests();
    vi.restoreAllMocks();
  });

  it("returns envelope + narrative with always-included evidence", async () => {
    const { buildIncidentReport } = await import(
      "../src/modules/incident-report/index.js"
    );
    const { envelope, narrative } = await buildIncidentReport({
      scope: "session",
      redact: "addresses",
    });

    // Envelope shape
    expect(envelope.incident_id).toMatch(/^incident-[0-9a-f]{12}$/);
    expect(envelope.scope).toBe("session");
    expect(envelope.redaction_mode).toBe("addresses");
    expect(envelope.evidence.demo_mode).toBeDefined();
    expect(typeof envelope.evidence.demo_mode.live_wallet_active).toBe("boolean");
    expect(Array.isArray(envelope.evidence.pairings)).toBe(true);
    expect(envelope.evidence.notices).toMatchObject({
      preflight_skill_installed: expect.any(Boolean) as unknown as boolean,
      setup_skill_installed: expect.any(Boolean) as unknown as boolean,
    });
    // No wallet evidence on session scope
    expect(envelope.evidence.wallet_context).toBeUndefined();

    // Narrative shape
    expect(narrative).toContain("# VaultPilot incident report");
    expect(narrative).toContain("## Demo-mode state");
    expect(narrative).toContain("## Paired Ledger wallets");
    expect(narrative).toContain("## Skill / integrity notices");
    expect(narrative).toContain(envelope.incident_id);
  });

  it("incident_id is deterministic within the same minute bucket", async () => {
    const { buildIncidentReport } = await import(
      "../src/modules/incident-report/index.js"
    );
    const a = await buildIncidentReport({
      scope: "session",
      redact: "addresses",
      txHash: TX_HASH,
    });
    const b = await buildIncidentReport({
      scope: "session",
      redact: "addresses",
      txHash: TX_HASH,
    });
    expect(a.envelope.incident_id).toBe(b.envelope.incident_id);
  });

  it("'addresses' redaction default keeps full hex out of the narrative", async () => {
    // Set up an active live demo wallet so the narrative references
    // an EVM address; without it, the narrative has no addresses to
    // redact and the assertion is vacuous.
    process.env.VAULTPILOT_DEMO = "true";
    const { setLivePersona } = await import("../src/demo/index.js");
    setLivePersona("whale");

    const { buildIncidentReport } = await import(
      "../src/modules/incident-report/index.js"
    );
    const { narrative } = await buildIncidentReport({
      scope: "session",
      redact: "addresses",
    });
    // Full vitalik address must NOT appear; the redacted form should.
    expect(narrative).not.toContain(VITALIK);
  });

  it("'none' redaction passes addresses through unchanged", async () => {
    process.env.VAULTPILOT_DEMO = "true";
    const { setLivePersona } = await import("../src/demo/index.js");
    setLivePersona("whale");

    const { buildIncidentReport } = await import(
      "../src/modules/incident-report/index.js"
    );
    const { envelope } = await buildIncidentReport({
      scope: "session",
      redact: "none",
    });
    // The live-wallet bundle (when present) carries the unredacted
    // EVM address. Just assert the envelope's redaction mode and
    // that the narrative doesn't mangle addresses.
    expect(envelope.redaction_mode).toBe("none");
    // Demo whale persona's EVM cell is vitalik in current curation.
    expect(envelope.evidence.demo_mode.live_wallet?.addresses.evm[0]).toBe(VITALIK);
  });
});

describe("buildIncidentReport — wallet scope error path", () => {
  it("scope='wallet' without `wallet` arg surfaces error in envelope, not throw", async () => {
    const { buildIncidentReport } = await import(
      "../src/modules/incident-report/index.js"
    );
    const { envelope } = await buildIncidentReport({
      scope: "wallet",
      redact: "addresses",
    });
    expect(envelope.evidence.wallet_context).toBeUndefined();
    expect(envelope.evidence.wallet_context_error).toBeDefined();
    expect(envelope.evidence.wallet_context_error).toMatch(/requires a `wallet`/);
  });
});
