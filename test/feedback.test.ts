import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAndRecord, hashPayload, RATE_LIMITS } from "../src/modules/feedback/rate-limit.js";
import { requestCapability } from "../src/modules/feedback/index.js";

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recon-feedback-"));
  stateFile = join(tmpDir, "feedback-log.json");
  process.env.VAULTPILOT_FEEDBACK_STATE_FILE = stateFile;
  delete process.env.VAULTPILOT_FEEDBACK_ENDPOINT;
});

afterEach(() => {
  delete process.env.VAULTPILOT_FEEDBACK_STATE_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("feedback rate limiter", () => {
  it("records the first event and allows it", () => {
    const res = checkAndRecord("hash-1", 1_000_000);
    expect(res.ok).toBe(true);
    expect(existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].hash).toBe("hash-1");
  });

  it("enforces the min-interval between consecutive calls", () => {
    const t0 = 1_000_000;
    expect(checkAndRecord("h1", t0).ok).toBe(true);
    const r = checkAndRecord("h2", t0 + 5_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Wait \d+s between calls/);
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("allows a second call once the min-interval elapses", () => {
    const t0 = 1_000_000;
    expect(checkAndRecord("h1", t0).ok).toBe(true);
    expect(checkAndRecord("h2", t0 + RATE_LIMITS.minIntervalSeconds * 1_000 + 1).ok).toBe(true);
  });

  it("enforces the hourly limit", () => {
    const t0 = 1_000_000;
    const step = (RATE_LIMITS.minIntervalSeconds + 1) * 1_000;
    for (let i = 0; i < RATE_LIMITS.perHour; i++) {
      expect(checkAndRecord(`h${i}`, t0 + i * step).ok).toBe(true);
    }
    const over = checkAndRecord("hx", t0 + RATE_LIMITS.perHour * step);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/Hourly/);
  });

  it("enforces the daily limit after hourly windows reset", () => {
    let t = 1_000_000;
    const hourStep = 61 * 60 * 1_000;
    const within = (RATE_LIMITS.minIntervalSeconds + 1) * 1_000;
    let admitted = 0;
    for (let i = 0; i < 20 && admitted < RATE_LIMITS.perDay; i++) {
      const r = checkAndRecord(`h${i}`, t);
      if (r.ok) admitted++;
      t += within;
      if (admitted % RATE_LIMITS.perHour === 0) t += hourStep;
    }
    expect(admitted).toBe(RATE_LIMITS.perDay);
    const over = checkAndRecord("hx", t + hourStep);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/Daily/);
  });

  it("dedupes identical hashes within the 7-day window", () => {
    const t0 = 1_000_000;
    expect(checkAndRecord("same", t0).ok).toBe(true);
    const step = (RATE_LIMITS.minIntervalSeconds + 1) * 1_000;
    const dup = checkAndRecord("same", t0 + step);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/equivalent capability request/i);
  });

  it("allows resubmission after the dedupe window", () => {
    const t0 = 1_000_000;
    expect(checkAndRecord("same", t0).ok).toBe(true);
    const after = t0 + (RATE_LIMITS.dedupeWindowDays * 86_400 + 1) * 1_000;
    expect(checkAndRecord("same", after).ok).toBe(true);
  });

  it("rejects NaN/Infinity timestamps from a corrupted state file (B3)", () => {
    writeFileSync(
      stateFile,
      JSON.stringify([
        { ts: Number.NaN, hash: "poison" },
        { ts: Number.POSITIVE_INFINITY, hash: "poison2" },
      ])
    );
    const t0 = 1_000_000;
    const r = checkAndRecord("real", t0);
    expect(r.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].hash).toBe("real");
    expect(Number.isFinite(persisted[0].ts)).toBe(true);
  });

  it("fails closed when the state file is a symlink (B2)", () => {
    const decoy = join(tmpDir, "decoy.txt");
    writeFileSync(decoy, "not-the-state-file");
    symlinkSync(decoy, stateFile);
    expect(() => checkAndRecord("h1", 1_000_000)).toThrow(/symlink|hardlink|non-regular/i);
    expect(readFileSync(decoy, "utf8")).toBe("not-the-state-file");
  });

  it("hashPayload normalizes whitespace + case so trivial rewordings dedupe", () => {
    expect(hashPayload("Add Pendle", "Please support PT tokens."))
      .toBe(hashPayload("  ADD PENDLE  ", "please support pt tokens."));
  });

  it("ignores malformed JSON and treats state as empty", () => {
    writeFileSync(stateFile, "{not-json");
    expect(checkAndRecord("h1", 1_000_000).ok).toBe(true);
  });
});

describe("requestCapability (prefilled URL mode)", () => {
  it("returns a GitHub issue URL and surfaces the rate-limit config", async () => {
    const res = (await requestCapability({
      summary: "Add support for Pendle PT/YT positions",
      description: "User asked for Pendle positions; no existing tool reads them.",
    })) as { status: string; issueUrl: string; repo: string; rateLimit: unknown };
    expect(res.status).toBe("prefilled_url");
    expect(res.issueUrl).toMatch(/^https:\/\/github\.com\/szhygulin\/vaultpilot-mcp\/issues\/new\?/);
    expect(res.repo).toBe("szhygulin/vaultpilot-mcp");
    expect(res.rateLimit).toEqual(RATE_LIMITS);
  });

  it("neutralizes @-mentions in the issue body (S1)", async () => {
    const res = (await requestCapability({
      summary: "Mention-phishing attempt via feedback",
      description: "Hi @everyone please click @octocat and @fake-admin to review this.",
    })) as { issueUrl: string };
    const body = new URL(res.issueUrl).searchParams.get("body") ?? "";
    expect(body).not.toMatch(/(^|\s)@[a-zA-Z0-9_-]/);
    expect(body).toContain("@\u200Beveryone");
    expect(body).toContain("@\u200Bfake-admin");
  });

  it("neutralizes @-mentions in the issue title (S1b)", async () => {
    // GitHub parses @-mentions in titles too — a prompt-injected summary
    // containing "@someone" would ping arbitrary users at open-issue time.
    const res = (await requestCapability({
      summary: "Ping @octocat and @fake-admin about this",
      description: "Body content long enough to satisfy the zod min-length check.",
    })) as { issueUrl: string; title: string };
    const title = new URL(res.issueUrl).searchParams.get("title") ?? "";
    expect(title).not.toMatch(/@[a-zA-Z0-9_-]/);
    expect(title).toContain("@\u200Boctocat");
    expect(title).toContain("@\u200Bfake-admin");
    expect(res.title).toContain("@\u200Boctocat");
  });

  it("escapes embedded triple-backticks in errorObserved (B4)", async () => {
    const res = (await requestCapability({
      summary: "Error report with fenced block",
      description: "See the error trace attached.",
      context: {
        errorObserved: "prefix ``` attacker content ``` suffix",
      },
    })) as { issueUrl: string };
    const body = new URL(res.issueUrl).searchParams.get("body") ?? "";
    expect(body).not.toMatch(/```\s*attacker/);
    expect(body).toContain("`\u200B``");
  });

  it("truncates the body and flags it when the URL would exceed the GitHub limit (B1)", async () => {
    // Each `我` is 3 UTF-8 bytes and URL-encodes to `%E6%88%91` (9 bytes), so
    // a max-length (4000-char) description of these blows past the 7168-byte
    // cap and forces the truncation path.
    const huge = "我".repeat(4000);
    const res = (await requestCapability({
      summary: "Very long feedback payload with multi-byte characters",
      description: huge,
    })) as { issueUrl: string; bodyTruncated: boolean; message: string };
    expect(res.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(res.issueUrl, "utf8")).toBeLessThanOrEqual(7168);
    const body = new URL(res.issueUrl).searchParams.get("body") ?? "";
    expect(body).toMatch(/body truncated to fit/i);
    expect(res.message).toMatch(/truncated/i);
  });

  it("does not truncate when the body fits well within the limit", async () => {
    const res = (await requestCapability({
      summary: "Small request",
      description: "Please support X. This is short.",
    })) as { bodyTruncated: boolean };
    expect(res.bodyTruncated).toBe(false);
  });

  // Issue #89 — the prefilled URL blew past terminal URL-length limits on
  // moderate bodies and stopped rendering as clickable; ghCommand gives the
  // agent a shell snippet that bypasses the URL path entirely via HEREDOC.
  it("returns a gh issue create shell snippet with the full body via HEREDOC (#89)", async () => {
    const longBody = "Body line that needs to survive intact. ".repeat(100);
    const res = (await requestCapability({
      summary: "Long body that would blow past URL limits",
      description: longBody,
    })) as {
      ghCommand: string;
      body: string;
      title: string;
      labels: string[];
      bodyTruncated: boolean;
    };
    expect(res.ghCommand).toMatch(/^gh issue create/);
    expect(res.ghCommand).toContain("--repo szhygulin/vaultpilot-mcp");
    // Title and labels are single-quoted shell args.
    expect(res.ghCommand).toContain(`--title '${res.title}'`);
    expect(res.ghCommand).toContain("--label 'agent-request'");
    // Full body rides through HEREDOC — NOT URL-encoded, NOT truncated, even
    // when the URL form had to truncate.
    expect(res.body).toBe(longBody.trim() === longBody ? longBody : res.body);
    expect(res.ghCommand).toContain(res.body);
    // HEREDOC open + close markers with the chosen tag.
    expect(res.ghCommand).toMatch(
      /--body "\$\(cat <<'VAULTPILOT_FEEDBACK_EOF_[a-z0-9]+'/,
    );
    expect(res.ghCommand).toMatch(/\nVAULTPILOT_FEEDBACK_EOF_[a-z0-9]+\n\)"/);
  });

  it("single-quote-escapes titles containing apostrophes so the gh snippet remains valid shell (#89)", async () => {
    // Common natural-language input — the naive `--title '...'` breaks on
    // this; the shellSingleQuote helper is what makes it robust. Title is
    // prefixed with `[agent-request] ` by requestCapability itself, so the
    // apostrophe sits mid-string.
    const res = (await requestCapability({
      summary: "Claude's attempt to support a new protocol",
      description: "Description sufficient to pass the zod min-length check.",
    })) as { ghCommand: string; title: string };
    // Embedded apostrophe escaped via the standard '\'' dance.
    expect(res.ghCommand).toContain("Claude'\\''s");
    // And the whole title is otherwise single-quoted — so the shell sees one
    // continuous --title arg rather than fragmenting on the apostrophe.
    expect(res.ghCommand).toContain(
      "--title '[agent-request] Claude'\\''s attempt to support a new protocol'",
    );
  });

  it("refuses to build a gh snippet when the body contains the HEREDOC terminator (#89 edge case)", async () => {
    // Extremely unlikely from an honest agent, but ship a guard so we
    // don't emit a snippet that would interpret part of the body as shell
    // text. Matches the errOR-and-fallback posture already used for
    // post-endpoint size caps.
    await expect(
      requestCapability({
        summary: "Body collides with HEREDOC tag",
        description:
          "Pretend description that ends with the terminator:\nVAULTPILOT_FEEDBACK_EOF_7a3f9b",
      }),
    ).rejects.toThrow(/HEREDOC terminator/);
  });

  it("propagates rate-limit rejection as a thrown error", async () => {
    // Seed an event "just now" so min-interval rejects the next call. The
    // persisted file is written by the first call; the second hits the cap.
    await requestCapability({
      summary: "First request in this suite run",
      description: "Content that passes validation trivially.",
    });
    await expect(
      requestCapability({
        summary: "Second request fired immediately",
        description: "Different content so dedupe does not trigger first.",
      })
    ).rejects.toThrow(/between calls/i);
  });

  it("rejects a non-https VAULTPILOT_FEEDBACK_ENDPOINT", async () => {
    process.env.VAULTPILOT_FEEDBACK_ENDPOINT = "http://insecure.example/hook";
    try {
      await expect(
        requestCapability({
          summary: "Plaintext endpoint should be refused",
          description: "Prevent accidental cleartext submission.",
        })
      ).rejects.toThrow(/https:\/\//i);
    } finally {
      delete process.env.VAULTPILOT_FEEDBACK_ENDPOINT;
    }
  });
});
