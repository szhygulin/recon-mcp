# Installing VaultPilot from a binary release

This guide is for users who want to run `vaultpilot-mcp` without
installing Node.js, npm, or any compile toolchain. Each release ships
a self-contained executable per platform — pick the matching pair for
your OS, run the setup wizard once, and point your MCP client at the
server binary.

If you already have Node.js and want to install from npm or source,
see the **Install** section in [`README.md`](./README.md) instead.

## 1. Download the binaries for your OS

Open the [latest release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest)
and download **two** files for your platform:

| Platform | Server binary | Setup wizard |
|---|---|---|
| Linux x64 | `vaultpilot-mcp-linux-x64` | `vaultpilot-mcp-setup-linux-x64` |
| macOS Apple silicon (M1/M2/M3) | `vaultpilot-mcp-macos-arm64` | `vaultpilot-mcp-setup-macos-arm64` |
| macOS Intel | `vaultpilot-mcp-macos-x64` | `vaultpilot-mcp-setup-macos-x64` |
| Windows x64 | `vaultpilot-mcp-windows-x64.exe` | `vaultpilot-mcp-setup-windows-x64.exe` |

Move both files into a stable location — somewhere they will live
permanently and your MCP client can reach them. Suggested paths:

- **macOS / Linux**: `~/.local/bin/`
- **Windows**: `%LOCALAPPDATA%\Programs\vaultpilot-mcp\`

Create the directory first if it doesn't exist (`mkdir -p ~/.local/bin`
on Unix; right-click → New folder on Windows).

## 2. Make the binaries runnable

### macOS

macOS Gatekeeper blocks unsigned binaries by default. Two options to
get past it:

**Option A — strip the quarantine attribute (one-time, command-line)**

```bash
chmod +x ~/.local/bin/vaultpilot-mcp-macos-* ~/.local/bin/vaultpilot-mcp-setup-macos-*
xattr -d com.apple.quarantine ~/.local/bin/vaultpilot-mcp-macos-* 2>/dev/null
xattr -d com.apple.quarantine ~/.local/bin/vaultpilot-mcp-setup-macos-* 2>/dev/null
```

**Option B — Finder right-click → Open**

Right-click the file in Finder, choose **Open**, click **Open** in the
"unidentified developer" dialog. Repeat for both files. macOS remembers
your choice; you only do this once per file.

If you see *"Apple could not verify ... is free of malware"*, that's
Gatekeeper warning you. The binaries are built in our public CI from
this repo's source — you can verify by reading
[`.github/workflows/release-binaries.yml`](./.github/workflows/release-binaries.yml)
in the repo and matching the build provenance against the asset
filenames. Code-signing is on the roadmap but not shipped yet.

### Linux

```bash
chmod +x ~/.local/bin/vaultpilot-mcp-linux-x64 ~/.local/bin/vaultpilot-mcp-setup-linux-x64
```

If you plan to use TRON or Solana hardware-signing flows, you also need
[Ledger udev rules](https://github.com/LedgerHQ/udev-rules). The setup
wizard in the next step detects this and prints the install one-liner
if they're missing.

### Windows

Windows SmartScreen will warn when you run an unsigned binary. Click
**More info** → **Run anyway** the first time you launch each binary.

## 3. Run the setup wizard

This is the one mandatory configuration step. It writes
`~/.vaultpilot-mcp/config.json` (or `%USERPROFILE%\.vaultpilot-mcp\config.json`
on Windows) with your RPC providers and optional API keys.

```bash
# macOS / Linux
~/.local/bin/vaultpilot-mcp-setup-<platform>

# Windows (PowerShell)
& "$env:LOCALAPPDATA\Programs\vaultpilot-mcp\vaultpilot-mcp-setup-windows-x64.exe"
```

The wizard:

- Asks what you want to do (read balances / sign EVM / sign Solana /
  sign TRON) and only prompts for the keys that use case actually
  needs. Read-only portfolio works with **zero** keys (PublicNode
  defaults ship out of the box).
- Detects Claude Desktop / Claude Code / Cursor and offers to add a
  `vaultpilot-mcp` entry to each of their MCP-server configs
  automatically. You don't need to find or edit JSON files.
- Offers to clone the two companion Claude Code skills
  ([`vaultpilot-skill`](https://github.com/szhygulin/vaultpilot-skill)
  for signing-time integrity invariants and
  [`vaultpilot-setup-skill`](https://github.com/szhygulin/vaultpilot-setup-skill)
  for the conversational `/setup` flow) into `~/.claude/skills/`.

You can re-run the wizard any time to add or change a key.

## 4. Verify it works

The setup wizard probably auto-registered VaultPilot with at least
one of your MCP clients. Restart the client and try a read-only
question:

> "Show me my crypto portfolio."

If your client knows about VaultPilot, the agent will call
`get_ledger_status` and `get_portfolio_summary` (or similar) and return
results. If the client says it doesn't know about VaultPilot, see
**Manual MCP client wiring** below.

You can also confirm the server binary itself runs:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  ~/.local/bin/vaultpilot-mcp-<platform> | head -c 200
```

A JSON envelope listing tools should print to stdout.

## 5. Manual MCP client wiring (if auto-register didn't run)

If the setup wizard couldn't detect your client, or you skipped the
auto-register prompt, add the entry manually. The exact JSON shape:

```json
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "/absolute/path/to/vaultpilot-mcp-<platform>"
    }
  }
}
```

Per-client config locations:

| Client | Config path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude Code (user-level) | `~/.claude.json` |
| Cursor (user-level) | `~/.cursor/mcp.json` |

If the file already has a `mcpServers` block, **merge** into it — don't
overwrite. Always back up the file before editing.

## 6. Pair Ledger (only if you'll sign transactions)

VaultPilot is self-custodial: it never holds your keys. To sign, your
hardware wallet pairs once per chain.

- **EVM signing** (Ethereum / Arbitrum / Polygon / Base / Optimism /
  Solana via WalletConnect): the agent will tell you to call
  `pair_ledger_live` — open Ledger Live on your phone and complete the
  WC handshake.
- **Solana signing**: plug in your Ledger, open the Solana app
  (Settings → enable **Allow blind signing** for SPL/MarginFi/Jupiter
  flows; SOL native sends clear-sign without it), and the agent will
  call `pair_ledger_solana`.
- **TRON signing**: plug in your Ledger, open the Tron app, and the
  agent will call `pair_ledger_tron`.

Read-only portfolio reads need **none** of this — they just need
on-chain data, which the public RPC fallbacks provide.

## 7. Update to a new version

1. Download the new binaries from the [latest release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest).
2. Replace the old files at the same paths.
3. On macOS, re-run the `xattr -d com.apple.quarantine` step on the
   new files (or right-click → Open once each).
4. On Windows, click through SmartScreen once each.
5. Restart your MCP client so it picks up the new binary.

Your config file at `~/.vaultpilot-mcp/config.json` is preserved
across updates.

## 8. Uninstall

1. Remove the binaries from `~/.local/bin/` (or
   `%LOCALAPPDATA%\Programs\vaultpilot-mcp\`).
2. Remove the config: `rm -rf ~/.vaultpilot-mcp/` (Unix) or delete
   `%USERPROFILE%\.vaultpilot-mcp\` (Windows).
3. Remove the `vaultpilot-mcp` entry from your MCP client's config
   file (paths in section 5).
4. Optional — remove the companion skills:
   `rm -rf ~/.claude/skills/vaultpilot-{preflight,setup}/`.

## 9. Troubleshooting

**"Permission denied" on Linux/macOS launch.** You forgot
`chmod +x`. Re-run with the path from section 2.

**"Apple could not verify..."** macOS Gatekeeper. Right-click → Open,
or run the `xattr -d com.apple.quarantine` one-liner from section 2.

**"Windows protected your PC"** SmartScreen. Click **More info** →
**Run anyway**.

**Setup wizard hangs at "Pairing Ledger Live..."**: the WalletConnect
relay timed out. Check your Ledger Live mobile app is open, has
internet, and is on a recent build. Hit Ctrl-C and re-run setup with
`--skip-pairing` (you can pair later via `pair_ledger_live`).

**MCP client doesn't see `vaultpilot-mcp`.** Most likely the
auto-register didn't catch your client. Verify the JSON config exists
at the path in section 5 and contains a `mcpServers.vaultpilot-mcp`
entry pointing at the server binary's absolute path. Restart the
client after editing.

**Solana sends fail with "blockhash expired"** on slow Ledger blind-
signing. As of v0.6.1, every Solana send is durable-nonce-protected,
so this should not happen — if it does, file an issue with the
preview output.

**Linux: TRON / Solana signing returns "permission denied" on USB.**
Ledger udev rules aren't installed. Re-run the setup wizard; it
detects this and prints the install one-liner. Or install directly
from [Ledger's repo](https://github.com/LedgerHQ/udev-rules).

**Anything else.** File an issue with the [vaultpilot-mcp issue tracker](https://github.com/szhygulin/vaultpilot-mcp/issues)
including your OS, the binary version (`./vaultpilot-mcp-<platform>
--version`), the failing tool name, and the agent's verbatim output
(redact any wallet addresses or hashes you don't want in public logs).

## What's bundled inside the binary

For the technically curious: each binary contains the Node.js 22
runtime, the compiled `dist/` JS, every npm dependency, and the
platform-specific native `.node` artifacts for `node-hid`, `usb`,
`bufferutil`, and `utf-8-validate`. The binaries are built per-OS via
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) on a GitHub Actions
matrix — see [`.github/workflows/release-binaries.yml`](./.github/workflows/release-binaries.yml).
At first launch the runtime extracts the bundled `.node` files to a
platform-specific cache directory (override via `PKG_NATIVE_CACHE_PATH`).
