## Crypto/DeFi Transaction Preflight Checks
- Before preparing ANY on-chain transaction, verify: (1) sufficient native gas/bandwidth (especially TRX bandwidth for TRON), (2) pause status on lending markets (isWithdrawPaused, isSupplyPaused), (3) minimum borrow/supply thresholds, (4) approval status for ERC20 operations.
- Never use uint256.max for collateral withdrawal amounts; always fetch and use the exact balance.
- When preparing multi-step flows (approve + action), wait for approval confirmation before sending the dependent tx.

## Git/PR Workflow
- Always use PR-based workflow: never push directly to main, and never push feature work to the wrong branch. Open a PR and let CI run.
- Before force-pushing or rebasing, confirm with user.
- **Each new feature/fix must be implemented inside its own dedicated `git worktree` under `.claude/worktrees/<branch-name>`** — NEVER do feature work in the main worktree at `/home/szhygulin/dev/recon-mcp`. Multiple agents may work this repo in parallel; if two agents share a single worktree they will race on the working tree, the index, and the npm install state. Recipe: `git fetch origin main && git worktree add .claude/worktrees/<short-name> -b <branch-name> origin/main`. Worktrees are auto-cleaned on PR merge by `git worktree prune`. The main worktree stays on `main` and is for sync/inspection only — don't edit files there. Exception: cross-project `claude-work/` plan files (gitignored) and `~/.claude/projects/.../memory/` (per-user) can be edited from anywhere; they're not under git's control in this repo.

## Tool Usage Discipline
- Do not repeat the same informational tool call (e.g., lending_positions, compound_positions) within a single turn. Cache results mentally and reuse.
- If a tool returns ambiguous or empty data, verify once with a different method; do not enter polling loops without user consent.

## Security Incident Response Tone
- When diagnosing malware/compromise, start with evidence-based scoping before recommending destructive actions (wipe, nuke, rotate-all). Never delete evidence files before reading them.

## Chat Output Formatting
- Prefer Markdown hyperlinks over raw URLs everywhere: `[label](url)` instead of pasting the full URL inline. This keeps the chat scannable — long URLs (especially swiss-knife decoder URLs with multi-KB calldata query strings, Etherscan tx URLs with hashes, tenderly/phalcon simulation URLs) wrap the terminal into unreadable walls when pasted raw. Apply in user-facing responses AND in any text the server instructs the agent to render (verification blocks, prepare receipts, etc.). Raw URLs are acceptable only when the link is short and already scannable (e.g. a bare domain like `https://ledger.com`) or when explicitly required for machine-readable contexts (e.g. inside a JSON paste-block the user copies into another tool).
