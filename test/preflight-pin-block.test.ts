/**
 * Issue #414 — the `PREFLIGHT SKILL INTEGRITY PIN` block previously lived
 * only in the server-level `instructions` field, which Claude Code
 * truncates at ~2KB. The pin sat ~24KB into that field, so Step 0 of the
 * vaultpilot-preflight skill could not run.
 *
 * Fix: emit a short `VAULTPILOT PIN — Preflight skill integrity` text
 * block on every tool response. These tests lock:
 *   - The block carries the SHA-256 + all three sentinel fragments at
 *     stable, parseable positions (so the skill's Step 0 can grep them).
 *   - The block has the same defensive shape as the VAULTPILOT NOTICE
 *     family — no imperative agent verbs, no pasted shell, named header.
 *   - It does NOT contain the assembled sentinel literal anywhere in the
 *     block (the fragments-only constraint is what stops a naive context
 *     search from short-circuiting Step 4 of the skill protocol).
 *   - The block stays short enough to comfortably fit alongside other
 *     content blocks on every tool response without bloating output.
 */
import { describe, it, expect } from "vitest";
import { renderPreflightSkillPinBlock } from "../src/signing/render-verification.js";
import {
  EXPECTED_SKILL_SHA256,
  EXPECTED_SKILL_SENTINEL_A,
  EXPECTED_SKILL_SENTINEL_B,
  EXPECTED_SKILL_SENTINEL_C,
} from "../src/diagnostics/skill-pin-drift.js";

function realPin() {
  return {
    expectedSha256: EXPECTED_SKILL_SHA256,
    sentinelA: EXPECTED_SKILL_SENTINEL_A,
    sentinelB: EXPECTED_SKILL_SENTINEL_B,
    sentinelC: EXPECTED_SKILL_SENTINEL_C,
  };
}

describe("renderPreflightSkillPinBlock — issue #414", () => {
  it("emits the SHA-256 verbatim on its own line", () => {
    const out = renderPreflightSkillPinBlock(realPin());
    // The skill's Step 0 will grep for the 64-hex-char hash. Make sure it's
    // present exactly, and on its own line (so a regex anchored to bol/eol
    // can pick it up without sibling-line contamination).
    expect(out).toMatch(new RegExp(`^\\s*${EXPECTED_SKILL_SHA256}\\s*$`, "m"));
  });

  it("emits each sentinel fragment in a `fragment X: \\`value\\`` line", () => {
    const out = renderPreflightSkillPinBlock(realPin());
    expect(out).toMatch(
      new RegExp(`fragment A: \`${EXPECTED_SKILL_SENTINEL_A}\``),
    );
    expect(out).toMatch(
      new RegExp(`fragment B: \`${EXPECTED_SKILL_SENTINEL_B}\``),
    );
    expect(out).toMatch(
      new RegExp(`fragment C: \`${EXPECTED_SKILL_SENTINEL_C}\``),
    );
  });

  it("does NOT contain the assembled A+B+C literal anywhere", () => {
    // If it did, a naive search of the agent's context for the assembled
    // sentinel would always succeed — silently bypassing Step 4 of the
    // preflight protocol (which checks the Skill tool's RESULT TEXT for
    // the literal). Same constraint that drove the fragments-only design
    // in the original `instructions` block.
    const out = renderPreflightSkillPinBlock(realPin());
    const assembled =
      EXPECTED_SKILL_SENTINEL_A +
      EXPECTED_SKILL_SENTINEL_B +
      EXPECTED_SKILL_SENTINEL_C;
    expect(out).not.toContain(assembled);
  });

  it("starts with the `VAULTPILOT PIN —` prefix the agent uses to authenticate the block", () => {
    const out = renderPreflightSkillPinBlock(realPin());
    expect(out).toMatch(/^VAULTPILOT PIN — /);
  });

  it("carries no imperative agent verbs and no pasted shell commands", () => {
    // Defense-in-depth: this exact pattern is what made the original
    // missing-skill notice get flagged as prompt injection. The pin block
    // ships on every response, so any regression here would taint every
    // tool result.
    const out = renderPreflightSkillPinBlock(realPin());
    expect(out).not.toMatch(/AGENT TASK/);
    expect(out).not.toMatch(/RELAY TO USER FIRST/);
    // No verbatim shell embedded for the agent to execute. Step 0 of the
    // skill is what tells the agent to run `sha256sum`; this block stays
    // pure data.
    expect(out).not.toMatch(/^\s*sha256sum\s/m);
    expect(out).not.toMatch(/```/);
  });

  it("stays under 700 chars — small enough to ride on every tool response without bloat (#613 finding 5)", () => {
    // Issue #613 finding 5: per-response repetition of the PIN block
    // accrued ~870 × N tool calls per session of redundant copy. The
    // block was tightened to ~510 chars; the < 700 cap leaves headroom
    // for minor wording adjustments while catching a regression that
    // reflates it back toward the old shape.
    const out = renderPreflightSkillPinBlock(realPin());
    expect(out.length).toBeLessThan(700);
  });

  it("documents itself as server-generated and references issue #414", () => {
    const out = renderPreflightSkillPinBlock(realPin());
    expect(out).toMatch(/server-emitted|server-generated/);
    expect(out).toMatch(/#414|truncat/i);
  });
});
