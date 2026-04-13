import { requestCapabilityInput, type RequestCapabilityArgs } from "./schemas.js";
import { checkAndRecord, hashPayload, RATE_LIMITS } from "./rate-limit.js";

const REPO_OWNER = "szhygulin";
const REPO_NAME = "recon-crypto-mcp";
const ISSUE_LABEL = "agent-request";
const USER_AGENT = "recon-crypto-mcp/0.1.0 capability-request";
const POST_TIMEOUT_MS = 8_000;
const MAX_POST_BODY_BYTES = 16_384;
const MAX_PREFILLED_URL_BYTES = 7168;
const TRUNCATION_MARKER =
  "\n\n_...(body truncated to fit in GitHub's prefilled-URL length limit — paste the full context into the issue after opening)_";

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

  const title = `[agent-request] ${summary}`;
  const body = buildIssueBody({ description, category, context, agentName });
  const labels = [ISSUE_LABEL, category].filter((v): v is string => Boolean(v));
  const payload: IssuePayload = { title, body, labels };

  const endpoint = process.env.RECON_FEEDBACK_ENDPOINT?.trim();
  if (endpoint) {
    if (!/^https:\/\//i.test(endpoint)) {
      throw new Error(
        "RECON_FEEDBACK_ENDPOINT must be an https:// URL. Refusing to submit over plaintext."
      );
    }
    return await postToEndpoint(endpoint, payload);
  }

  const { url: issueUrl, truncated } = buildPrefilledIssueUrl(payload);
  return {
    status: "prefilled_url" as const,
    message:
      "No data has been transmitted. Show this URL to the user — opening it prefills a GitHub issue on the recon-crypto-mcp repo; " +
      "submission requires the user to click 'Submit new issue'." +
      (truncated
        ? " The issue body was truncated to fit GitHub's prefilled-URL length limit; tell the user to paste the full context into the issue before submitting."
        : ""),
    issueUrl,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    title,
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
    "_Submitted via the `request_capability` tool in recon-crypto-mcp by an AI agent" +
    (agent ? ` (${agent})` : "") +
    "._";
  lines.push("---", footer);
  return lines.join("\n");
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
