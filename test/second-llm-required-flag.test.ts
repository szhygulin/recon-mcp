/**
 * Inv #12.5 hard-trigger flag (issue #501) — `secondLlmRequired` on
 * `UnsignedTx` causes the verification renderer to surface a
 * mandatory `⚠ SECOND-LLM CHECK REQUIRED` line so the agent knows
 * to call `get_verification_artifact` and relay the `pasteableBlock`
 * before the user's 'send' reply.
 *
 * No producer wires the flag yet — pure scaffold for when hard-
 * trigger op classes ship (#481 EIP-7702, #453 Permit2 batch, #451
 * opaque-facet bridges, future Safe enableModule / setGuard, etc.).
 */
import { describe, it, expect } from "vitest";
import { CONTRACTS } from "../src/config/contracts.js";

const HEX_DATA =
  "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042b1d8d3a3f0000";

const baseTx = {
  chain: "ethereum" as const,
  to: CONTRACTS.ethereum.tokens.USDC as `0x${string}`,
  value: "0",
  data: HEX_DATA as `0x${string}`,
  verification: {
    payloadHash: "0xdeadbeef" as `0x${string}`,
    payloadHashShort: "deadbeef",
    comparisonString: "ignored",
    humanDecode: {
      functionName: "transfer" as const,
      args: [],
      source: "none" as const,
    },
  },
};

describe("renderVerificationBlock — secondLlmRequired surfaces a ⚠ line", () => {
  it("omits the line when secondLlmRequired is absent or false (default for plain prepares)", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const omitted = renderVerificationBlock({ ...baseTx });
    const explicitFalse = renderVerificationBlock({
      ...baseTx,
      secondLlmRequired: false,
    });
    expect(omitted).not.toMatch(/SECOND-LLM CHECK REQUIRED/);
    expect(explicitFalse).not.toMatch(/SECOND-LLM CHECK REQUIRED/);
  });

  it("emits the ⚠ line when secondLlmRequired is true", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderVerificationBlock({
      ...baseTx,
      secondLlmRequired: true,
    });
    expect(block).toMatch(/⚠ SECOND-LLM CHECK REQUIRED/);
    expect(block).toMatch(/get_verification_artifact/);
    expect(block).toMatch(/Inv #12\.5/);
    // Surfaces below the hash line so the agent reads it at the
    // same scan position as other ⚠ warnings (recipient + token-
    // class), where the user's attention lands before 'send'.
    const hashIdx = block.indexOf("Hash:");
    const warnIdx = block.indexOf("⚠ SECOND-LLM CHECK REQUIRED");
    expect(warnIdx).toBeGreaterThan(hashIdx);
  });

  it("composes with other ⚠ warnings (recipient + tokenClass + secondLlmRequired all surface together)", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderVerificationBlock({
      ...baseTx,
      to: CONTRACTS.ethereum.lido.stETH as `0x${string}`,
      recipient: {
        source: "literal",
        warnings: [
          "contacts file failed verification — recipient label not checked",
        ],
      },
      tokenClass: {
        flags: ["rebasing"],
        warnings: ["stETH is rebasing — recipient may receive 1-2 wei less."],
      },
      secondLlmRequired: true,
    });
    expect(block).toMatch(/⚠ contacts file failed verification/);
    expect(block).toMatch(/⚠ stETH is rebasing/);
    expect(block).toMatch(/⚠ SECOND-LLM CHECK REQUIRED/);
  });
});
