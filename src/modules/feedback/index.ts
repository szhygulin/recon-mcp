import { requestCapabilityInput, type RequestCapabilityArgs } from "./schemas.js";
import { checkAndRecord, hashPayload, RATE_LIMITS } from "./rate-limit.js";

const REPO_OWNER = "szhygulin";
const REPO_NAME = "vaultpilot-mcp";
const ISSUE_LABEL = "agent-request";
const USER_AGENT = "vaultpilot-mcp/0.1.0 capability-request";
const POST_TIMEOUT_MS = 8_000;
const MAX_POST_BODY_BYTES = 16_384;
const MAX_PREFILLED_URL_BYTES = 7168;
const TRUNCATION_MARKER =
  "\n\n_...(body truncated to fit in GitHub's prefilled-URL length limit — paste the full context into the issue after opening)_";
/**
 * HEREDOC terminator for the `ghCommand` shell snippet. Must be an unusual
 * string that agent-supplied body content is vanishingly unlikely to contain.
 * If a body ever does contain this literal line, `buildGhCommand` throws so
 * the caller falls back to the URL path rather than shipping a broken shell
 * snippet.
 */
const GH_HEREDOC_TAG = "VAULTPILOT_FEEDBACK_EOF_7a3f9b";

/**
 * Neutralize GitHub @-mentions in agent-supplied strings before they enter the
 * issue body. Without this, a prompt-injected agent could craft a feedback
 * payload that pings arbitrary GitHub users when the user clicks "Submit".
 * Inserting a zero-width space after `@` keeps the text readable while
 * breaking the mention parser.
 */
function neutralizeMentions(input: string): string {
  return input.replace(/@/g, "@\u200B");
}

/** Escape triple-backticks so agent-supplied strings can't break out of fenced code blocks. */
function escapeCodeFences(input: string): string {
  return input.replace(/```/g, "`\u200B``");
}

export { requestCapabilityInput };
export type { RequestCapabilityArgs };

type IssuePayload = { title: string; body: string; labels: string[] };

export async function requestCapability(args: RequestCapabilityArgs) {
  const { summary, description, category, context, agentName } = args;
  const hash = hashPayload(summary, description);

  const check = checkAndRecord(hash);
  if (!check.ok) {
    const err = new Error(check.reason) as Error & { retryAfterSeconds?: number };
    if ("retryAfterSeconds" in check && check.retryAfterSeconds !== undefined) {
      err.retryAfterSeconds = check.retryAfterSeconds;
    }
    throw err;
  }

  // Titles parse @-mentions too — a prompt-injected summary containing
  // `@someuser` would ping arbitrary GitHub users when the issue is opened.
  const title = `[agent-request] ${neutralizeMentions(summary)}`;
  const body = buildIssueBody({ description, category, context, agentName });
  const labels = [ISSUE_LABEL, category].filter((v): v is string => Boolean(v));
  const payload: IssuePayload = { title, body, labels };

  const endpoint = (
    process.env.VAULTPILOT_FEEDBACK_ENDPOINT ?? process.env.RECON_FEEDBACK_ENDPOINT
  )?.trim();
  if (endpoint) {
    if (!/^https:\/\//i.test(endpoint)) {
      throw new Error(
        "VAULTPILOT_FEEDBACK_ENDPOINT must be an https:// URL. Refusing to submit over plaintext."
      );
    }
    return await postToEndpoint(endpoint, payload);
  }

  const { url: issueUrl, truncated } = buildPrefilledIssueUrl(payload);
  const ghCommand = buildGhCommand(payload);
  return {
    status: "prefilled_url" as const,
    message:
      "No data has been transmitted. TWO submission paths — pick whichever suits the " +
      "user's environment: " +
      "(a) `ghCommand` — a ready-to-run `gh issue create` shell snippet. If the user " +
      "has the GitHub CLI installed and authenticated (common for developer audiences, " +
      "esp. Claude Code / Cursor users), run it via the Bash tool. The body is passed " +
      "via HEREDOC so multi-KB descriptions work without URL-length limits or shell " +
      "escaping. Returns the created issue URL on success. " +
      "(b) `issueUrl` — a prefilled GitHub issue URL to render as a Markdown link; " +
      "the user opens it in a browser and clicks 'Submit new issue'. No gh CLI " +
      "required. Note: URLs over a few KB may not render as clickable in terminal " +
      "chat clients, forcing copy/paste." +
      (truncated
        ? " Only the URL body was truncated to fit GitHub's prefilled-URL length limit; ghCommand carries the full body and is preferred when available. Tell the user to paste the full context into the issue manually if they go with the URL path."
        : ""),
    issueUrl,
    ghCommand,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    title,
    body,
    labels,
    bodyTruncated: truncated,
    rateLimit: RATE_LIMITS,
  };
}

function buildIssueBody(opts: {
  description: string;
  category?: RequestCapabilityArgs["category"];
  context?: RequestCapabilityArgs["context"];
  agentName?: string;
}): string {
  const lines: string[] = [];
  lines.push("### Description", "", neutralizeMentions(opts.description), "");

  if (opts.category) {
    lines.push(`**Category:** \`${opts.category}\``, "");
  }

  if (opts.context && Object.values(opts.context).some((v) => v)) {
    lines.push("### Context");
    if (opts.context.toolAttempted) {
      lines.push(
        `- **Tool attempted:** \`${escapeCodeFences(opts.context.toolAttempted)}\``
      );
    }
    if (opts.context.chain) {
      lines.push(`- **Chain:** ${neutralizeMentions(opts.context.chain)}`);
    }
    if (opts.context.errorObserved) {
      const safe = escapeCodeFences(neutralizeMentions(opts.context.errorObserved));
      lines.push("- **Error observed:**");
      lines.push("  ```");
      for (const l of safe.split("\n")) lines.push(`  ${l}`);
      lines.push("  ```");
    }
    lines.push("");
  }

  const agent = opts.agentName ? neutralizeMentions(opts.agentName) : undefined;
  const footer =
    "_Submitted via the `request_capability` tool in vaultpilot-mcp by an AI agent" +
    (agent ? ` (${agent})` : "") +
    "._";
  lines.push("---", footer);
  return lines.join("\n");
}

/**
 * Escape a string for use inside a POSIX shell single-quoted argument. The
 * only char that can't appear inside `'...'` is `'` itself; the standard
 * workaround ends the quoted run, emits an escaped literal quote, and starts
 * a new quoted run: `can't` → `'can'\''t'`.
 */
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build a ready-to-run `gh issue create` shell snippet that ships the full
 * issue body via HEREDOC. The HEREDOC form is chosen deliberately:
 *
 * - URL-encoded `--body` inherits the ~7 KB prefilled-URL limit (issue #89)
 *   — the very limit this command is meant to bypass.
 * - Single-quoted `--body '...'` fails on bodies containing single quotes
 *   (easy to hit — e.g. "Claude's attempt to..."), forcing brittle escape
 *   dance.
 * - HEREDOC inside `"$(cat <<'TAG' ... TAG)"` passes the body bytes literally
 *   through command substitution; no per-char escaping needed.
 *
 * Throws if the body contains the HEREDOC terminator as a standalone line,
 * so the caller can fall back to the URL path instead of shipping a snippet
 * that would interpret part of the body as shell text.
 */
function buildGhCommand(payload: IssuePayload): string {
  const bodyLines = payload.body.split("\n");
  for (const line of bodyLines) {
    if (line.trim() === GH_HEREDOC_TAG) {
      throw new Error(
        `Body contains the HEREDOC terminator '${GH_HEREDOC_TAG}' as a standalone line; cannot safely embed in a gh issue create snippet. Fall back to the issueUrl path or trim the body.`,
      );
    }
  }
  const cmdHead = [
    "gh issue create \\",
    `  --repo ${REPO_OWNER}/${REPO_NAME} \\`,
    `  --title ${shellSingleQuote(payload.title)} \\`,
    `  --label ${shellSingleQuote(payload.labels.join(","))} \\`,
    `  --body "$(cat <<'${GH_HEREDOC_TAG}'`,
  ].join("\n");
  const cmdTail = `${GH_HEREDOC_TAG}\n)"`;
  return `${cmdHead}\n${payload.body}\n${cmdTail}`;
}

function buildPrefilledIssueUrl(payload: IssuePayload): { url: string; truncated: boolean } {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`;
  const build = (body: string): string => {
    const params = new URLSearchParams({
      title: payload.title,
      body,
      labels: payload.labels.join(","),
    });
    return `${base}?${params.toString()}`;
  };

  const fullUrl = build(payload.body);
  if (Buffer.byteLength(fullUrl, "utf8") <= MAX_PREFILLED_URL_BYTES) {
    return { url: fullUrl, truncated: false };
  }

  // Binary-search the largest body length whose resulting URL still fits. The
  // relationship body-length → encoded-URL-length isn't strictly linear
  // (high-byte chars encode as %XX%XX), so we don't guess a ratio.
  let lo = 0;
  let hi = payload.body.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = payload.body.slice(0, mid) + TRUNCATION_MARKER;
    if (Buffer.byteLength(build(candidate), "utf8") <= MAX_PREFILLED_URL_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const trimmedBody = payload.body.slice(0, lo) + TRUNCATION_MARKER;
  return { url: build(trimmedBody), truncated: true };
}

async function postToEndpoint(url: string, payload: IssuePayload) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_POST_BODY_BYTES) {
    throw new Error(
      `Capability-request payload exceeds ${MAX_POST_BODY_BYTES} bytes after serialization. Trim the description.`
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: serialized,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Capability-request endpoint returned ${res.status} ${res.statusText}${
        text ? `: ${text.slice(0, 200)}` : ""
      }`
    );
  }
  const data: unknown = await res.json().catch(() => null);
  return {
    status: "submitted" as const,
    endpoint: url,
    response: data,
    rateLimit: RATE_LIMITS,
  };
}
