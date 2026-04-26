# Contributing

Real contributions from real people are very welcome. This document exists to filter the unreal kind.

## Before opening a PR

- **Sign the [CLA](./CLA.md).** The CLA Assistant bot prompts you on your first PR — one signature covers all future contributions.
- **Read [CLAUDE.md](./CLAUDE.md).** It documents the worktree-per-feature rule, the PR-based workflow, the chat-output conventions, and the security posture this repo cares about.
- **Run the tests.** `npm install && npm run build && npx vitest run`. PRs that don't keep the suite green won't be reviewed.
- **Use a worktree, not the main checkout.** `.claude/worktrees/<short-name>` per feature. Multiple agents share this repo and race on the index otherwise.

## What kinds of PRs land

Bug fixes against an open issue, small focused features matching an existing tracked plan, test or doc improvements, and dependency upgrades that pass the existing checks. PRs that touch fewer than ~500 lines, do one thing, and come with tests have the highest land rate.

## What kinds of comments and PRs are off-topic

Tracking issues — those tagged for design discussion or roadmap follow-up rather than work-ready scope — are **not bounty surfaces**. Unsolicited "I have experience with X, want me to build this?" comments on tracking issues are off-topic and will be hidden as such. The same applies to drive-by PRs from automated bounty-fishing pipelines (templated credentials list + verbatim restate of the issue's own decisions table + closing CTA).

This is not a comment on legitimate contributors who happen to be new — those are welcome. The filter is on the bot pattern: opaque GitHub profile, no prior project context, generic boilerplate that adds no information beyond what the issue already says, and a "let me know if you'd like a PR" closer.

If you genuinely want to contribute on a tracking issue, demonstrate it by:

1. Opening a small, focused PR against an actual bug or already-scoped task first, so we have signal that you understand the codebase.
2. Asking a specific clarifying question that shows you read the issue and the linked code — pick one of the open decisions in the issue and propose a defensible answer with reasoning.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. See [SECURITY.md](./SECURITY.md) for the disclosure process.
