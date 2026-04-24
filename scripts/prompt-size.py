#!/usr/bin/env python3
"""
Per-turn prompt-size analyzer for Claude Code session transcripts.

Phase 0 deliverable for the input-side prompt-compression plan at
claude-work/plan-input-compression-phased.md. Produces empirical data on
per-turn input/output tokens so compression effort (Phases 1-3) can be
gated on "does it actually matter?" rather than guesswork.

## Data source

Claude Code writes each session's events to
  ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
Every `assistant` event that dispatched an Anthropic API call carries
`message.usage` with:
  - input_tokens:                 new uncached input this call
  - cache_creation_input_tokens:  new content written to cache this call
  - cache_read_input_tokens:      prior content read from cache (cheap)
  - output_tokens:                tokens the model generated

Anthropic prompt caching makes `cache_read` much cheaper than uncached
input — the model doesn't re-process cached content from scratch. So the
"work the model actually did this turn" is approximately
`input_tokens + cache_creation_input_tokens` (uncached new content +
newly-cached content). Call that `new_work` below.

The `cache_read` field is still informative — it measures the size of
persisted context the agent carries across turns, which grows with
conversation length.

## Usage

    python3 scripts/prompt-size.py                  # latest recon-mcp transcript
    python3 scripts/prompt-size.py --file <path>    # specific session
    python3 scripts/prompt-size.py --top 10         # top 10 heaviest turns

## What to look for

1. How big is the FIRST turn's `cache_creation`? That's the session's
   baseline prompt (server `instructions` + tool schemas + skill + system).
   If it's >10k tokens, the baseline itself is a meaningful cost.
2. How does `new_work` trend over the session? Steady growth = accumulated
   tool results are the issue. Spikes on specific tool calls = those
   responses are the compression target.
3. How big are the `output_tokens` on turns that "felt slow"? If
   `output_tokens` is large (>500), output compression (a la v1.6) might
   actually help; if small, the cost is on the input side.
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime

PROJECT_DIR = (
    pathlib.Path.home() / ".claude/projects/-home-szhygulin-dev-recon-mcp"
)


def latest_transcript() -> pathlib.Path:
    if not PROJECT_DIR.exists():
        sys.exit(
            f"Project transcript directory not found: {PROJECT_DIR}\n"
            "If you're running against a different project, pass --file."
        )
    files = sorted(
        PROJECT_DIR.glob("*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        sys.exit(f"No .jsonl transcripts found in {PROJECT_DIR}")
    return files[0]


def parse_ts(s: str):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_turns(path: pathlib.Path):
    """Yield one dict per assistant event that carried a usage block."""
    turns = []
    for line in open(path):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "assistant":
            continue
        msg = e.get("message", {})
        if not isinstance(msg, dict):
            continue
        usage = msg.get("usage")
        if not usage:
            continue
        ts = parse_ts(e.get("timestamp", ""))
        inp = usage.get("input_tokens", 0) or 0
        cc = usage.get("cache_creation_input_tokens", 0) or 0
        cr = usage.get("cache_read_input_tokens", 0) or 0
        out = usage.get("output_tokens", 0) or 0
        # Scan message content to label the turn (tool calls, text snippet).
        content = msg.get("content", [])
        tool_names = []
        text_preview = ""
        if isinstance(content, list):
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "tool_use":
                    tool_names.append(c.get("name", "") or "")
                elif c.get("type") == "text":
                    if not text_preview:
                        text_preview = (
                            (c.get("text", "") or "")[:60].replace("\n", " ")
                        )
        turns.append(
            {
                "ts": ts,
                "input": inp,
                "cache_creation": cc,
                "cache_read": cr,
                "output": out,
                "total_in": inp + cc + cr,
                "new_work": inp + cc,
                "tools": tool_names,
                "text": text_preview,
            }
        )
    return turns


def label_for(t: dict) -> str:
    if t["tools"]:
        return ",".join(t["tools"])[:60]
    return t["text"][:60] or "(assistant text)"


def print_waterfall(turns: list, limit: int):
    print(
        f"{'turn':>4}  {'time':<8}  {'input':>5}  {'cache+':>7}  "
        f"{'cache_r':>8}  {'out':>5}  {'new_work':>9}  label"
    )
    shown = turns[:limit]
    for i, t in enumerate(shown):
        ts_label = t["ts"].strftime("%H:%M:%S") if t["ts"] else "-"
        print(
            f"{i:>4}  {ts_label:<8}  {t['input']:>5}  "
            f"{t['cache_creation']:>7}  {t['cache_read']:>8}  "
            f"{t['output']:>5}  {t['new_work']:>9}  {label_for(t)}"
        )
    if len(turns) > limit:
        print(f"... (waterfall truncated; {len(turns) - limit} more turns — see summary below)")


def print_summary(turns: list, top_n: int):
    peak_total = max(turns, key=lambda t: t["total_in"])
    peak_work = max(turns, key=lambda t: t["new_work"])
    peak_out = max(turns, key=lambda t: t["output"])
    print("\nSummary")
    print(f"  turns with usage:           {len(turns)}")
    print(
        f"  peak total_in (one turn):   {peak_total['total_in']} "
        f"(input={peak_total['input']}, cache_creation={peak_total['cache_creation']}, "
        f"cache_read={peak_total['cache_read']})"
    )
    print(
        f"  peak new_work (one turn):   {peak_work['new_work']} "
        f"at {peak_work['ts'].strftime('%H:%M:%S') if peak_work['ts'] else '-'}  "
        f"[{label_for(peak_work)}]"
    )
    print(
        f"  peak output (one turn):     {peak_out['output']} "
        f"at {peak_out['ts'].strftime('%H:%M:%S') if peak_out['ts'] else '-'}  "
        f"[{label_for(peak_out)}]"
    )
    print(f"  cumulative output:          {sum(t['output'] for t in turns)} tokens")
    print(
        f"  cumulative cache_creation:  {sum(t['cache_creation'] for t in turns)} tokens  "
        f"(new content the model had to fully process across the session)"
    )
    print(
        f"  cumulative cache_read:      {sum(t['cache_read'] for t in turns)} tokens  "
        f"(persisted context re-read each turn)"
    )

    print(
        f"\nTop {top_n} turns by new_work "
        f"(input + cache_creation — tokens the model processed fresh this turn):"
    )
    top = sorted(turns, key=lambda t: t["new_work"], reverse=True)[:top_n]
    for i, t in enumerate(top):
        ts_label = t["ts"].strftime("%H:%M:%S") if t["ts"] else "-"
        print(
            f"  {i + 1}. {t['new_work']:>6} tokens  "
            f"(input={t['input']}, cache_creation={t['cache_creation']}, "
            f"output={t['output']})  at {ts_label}  [{label_for(t)}]"
        )

    print(
        f"\nTop {top_n} turns by output_tokens "
        f"(where the model spent the most autoregressive generation time):"
    )
    top_o = sorted(turns, key=lambda t: t["output"], reverse=True)[:top_n]
    for i, t in enumerate(top_o):
        ts_label = t["ts"].strftime("%H:%M:%S") if t["ts"] else "-"
        print(
            f"  {i + 1}. {t['output']:>6} tokens  "
            f"(new_work={t['new_work']})  at {ts_label}  [{label_for(t)}]"
        )


def main():
    ap = argparse.ArgumentParser(
        description="Per-turn prompt-size analyzer (see module docstring for detail).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--file",
        type=pathlib.Path,
        help="Session JSONL path (default: most-recent for recon-mcp project)",
    )
    ap.add_argument(
        "--top",
        type=int,
        default=5,
        help="Show N heaviest turns in the summary rankings (default 5)",
    )
    ap.add_argument(
        "--waterfall-limit",
        type=int,
        default=40,
        help="Max turns to show in the per-turn waterfall (default 40)",
    )
    args = ap.parse_args()
    path = args.file or latest_transcript()
    if not path.exists():
        sys.exit(f"File not found: {path}")

    turns = extract_turns(path)
    if not turns:
        print(f"No assistant events with usage found in {path}")
        return

    print(f"Transcript: {path.name}")
    print(f"Path:       {path}\n")
    print_waterfall(turns, args.waterfall_limit)
    print_summary(turns, args.top)


if __name__ == "__main__":
    main()
