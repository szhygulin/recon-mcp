/**
 * Tests for the v1 cross-check banner refactor — `pasteableBlock` shrunk
 * from ~80 lines of agent-task prose to ~25-30 lines (banner + compact
 * inline instructions + payload). The "lazy user" target: skim banner +
 * instructions in <10 seconds; reject if anything looks injected.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  buildCrossCheckBanner,
  CROSS_CHECK_SPEC_VERSION,
  CROSS_CHECK_SPEC_SHA256,
  CROSS_CHECK_SPEC_URL,
  PACKAGE_VERSION,
  _recomputeSpecSha256ForTests,
} from "../src/signing/cross-check-banner.js";
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { getVerificationArtifact } from "../src/modules/execution/index.js";
import { issueHandles } from "../src/signing/tx-store.js";
import type { EvmVerificationArtifact } from "../src/modules/execution/index.js";
import type { UnsignedTx } from "../src/types/index.js";
import { CONTRACTS } from "../src/config/contracts.js";

const USDC = getAddress(CONTRACTS.ethereum.tokens.USDC);
const RECIPIENT = getAddress("0xe2D1DC7bbF35Cb39E95CdBEAAE03322450A2F6DC");
const SENDER = getAddress("0xC0f5b7f7703BA95dC7C09D4eF50A830622234075");

function usdtTransfer(amount: bigint): UnsignedTx {
  return {
    chain: "ethereum",
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, amount],
    }),
    value: "0",
    from: SENDER,
    description: `Send ${amount.toString()} USDC to ${RECIPIENT}`,
  };
}

describe("buildCrossCheckBanner", () => {
  it("includes the version string", () => {
    expect(buildCrossCheckBanner()).toContain(`VAULTPILOT CROSS-CHECK ${CROSS_CHECK_SPEC_VERSION}`);
  });

  it("includes the SHA-256 of the spec doc", () => {
    expect(buildCrossCheckBanner()).toContain(`SHA-256: ${CROSS_CHECK_SPEC_SHA256}`);
  });

  it("includes the canonical github URL pinned to the package version", () => {
    const banner = buildCrossCheckBanner();
    expect(banner).toContain("github.com/szhygulin/vaultpilot-mcp");
    expect(banner).toContain("docs/cross-check-v1.md");
    expect(banner).toContain(`v${PACKAGE_VERSION}`);
  });

  it("SHA-256 in the banner matches sha256(docs/cross-check-v1.md) on disk", () => {
    // Tamper-detection invariant: the SHA the agent prints == the SHA the
    // user can compute themselves via `sha256sum docs/cross-check-v1.md`.
    // If this test fails, either the doc was edited without bumping the
    // version (drop the change) OR the banner got out of sync (fix it).
    const here = fileURLToPath(import.meta.url);
    // test file lives at <repo>/test/cross-check-banner.test.ts
    const docPath = join(here, "..", "..", "docs", "cross-check-v1.md");
    const onDisk = createHash("sha256")
      .update(readFileSync(docPath))
      .digest("hex");
    expect(CROSS_CHECK_SPEC_SHA256).toBe(onDisk);
    expect(_recomputeSpecSha256ForTests()).toBe(onDisk);
  });

  it("URL points at github (not a redirect domain or attacker domain)", () => {
    expect(CROSS_CHECK_SPEC_URL.startsWith("https://github.com/szhygulin/vaultpilot-mcp/")).toBe(
      true,
    );
  });
});

describe("pasteableBlock — compact v2 shape", () => {
  it("EVM transfer: opens with banner, ends with PAYLOAD, total length << old 80-line block", () => {
    const stamped = issueHandles(usdtTransfer(2_000_000_000n));
    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as EvmVerificationArtifact;
    const block = artifact.pasteableBlock;
    const lines = block.split("\n");

    // The old block was ~80 lines pre-refactor; the redesigned block must
    // be substantially smaller. 35 is a generous ceiling — actual is ~28.
    // If this fails because instructions grew, the refactor regressed and
    // the lazy-user-skim affordance is gone.
    expect(lines.length).toBeLessThan(35);

    // Must contain the banner sentinel + the spec URL + the SHA.
    expect(block).toContain(`VAULTPILOT CROSS-CHECK ${CROSS_CHECK_SPEC_VERSION}`);
    expect(block).toContain(`SHA-256: ${CROSS_CHECK_SPEC_SHA256}`);
    expect(block).toContain(CROSS_CHECK_SPEC_URL);

    // Must contain the inline audit-task instructions.
    expect(block).toMatch(/Audit task \(EVM\):/);
    expect(block).toMatch(/Decode payload\.data yourself/);
    expect(block).toMatch(/MISMATCH/);

    // Must contain the JSON PAYLOAD section.
    expect(block).toContain("PAYLOAD:");
    expect(block).toMatch(/"chain":\s*"ethereum"/);
  });

  it("does NOT include the legacy 80-line agent-task prose", () => {
    const stamped = issueHandles(usdtTransfer(2_000_000_000n));
    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as EvmVerificationArtifact;
    const block = artifact.pasteableBlock;
    // Sentinels from the old prose that should NOT survive the refactor.
    // If any of these are still in the rendered block, the compact-form
    // refactor regressed.
    expect(block).not.toContain(
      "You are auditing an EVM transaction a user is about to sign on a Ledger",
    );
    expect(block).not.toContain("Do these steps in order");
    // The new compact prompts use `MISMATCH` capitalized — old prose did
    // too, so we don't assert against that. But the 6-step numbered list
    // ("  6. Remind the user the last check happens on-device") is gone.
    expect(block).not.toMatch(/^ {2}6\. Remind the user the last check happens on-device/m);
  });

  it("starts with the START marker before the banner so users know where to copy", () => {
    const stamped = issueHandles(usdtTransfer(1n));
    const artifact = getVerificationArtifact({ handle: stamped.handle! }) as EvmVerificationArtifact;
    expect(artifact.pasteableBlock).toMatch(/^=====.*COPY FROM THIS LINE/);
    expect(artifact.pasteableBlock.split("\n").pop()).toMatch(/=====.*END.*STOP COPYING HERE.*=====/);
  });
});
