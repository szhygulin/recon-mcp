# Installing VaultPilot

> **Agents installing on the user's behalf**: skip the table — use the
> [one-line install](#one-line-install-for-agents-and-power-users) below.
> See [AGENTS.md](./AGENTS.md) for the consent + post-install relay
> conventions.

Four install paths — pick whichever matches your setup. All four end
at the same place: a `vaultpilot-mcp` server binary your MCP client
runs, plus a one-time setup wizard that writes the config file.

| Path | Best for | Prerequisites |
|---|---|---|
| **0. One-line install** | Anyone who'd rather not click through the release page; agent-driven installs | None — script handles everything |
| **A. Bundled binary** | Manual download path; users who want to inspect each step | None — runtime is bundled |
| **B. From npm** | Developers with Node.js already installed | Node.js ≥ 18.17, npm |
| **C. From source** | Contributors, anyone who wants to build their own | Node.js ≥ 18.17, npm, git, OS build toolchain |

Sections **3–9** (setup wizard, verification, MCP client wiring, Ledger
pairing, update, uninstall, troubleshooting) apply to all four paths.

## One-line install (for agents and power users)

This is exactly what Path A does, scripted: detect OS + arch, download
the matching server + setup binaries from the latest GitHub release,
place them in `~/.local/bin` (or `%LOCALAPPDATA%\Programs\vaultpilot-mcp\`
on Windows), then run `vaultpilot-mcp-setup --non-interactive --json`.

**Linux / macOS** (bash or zsh):

```bash
curl -fsSL https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.sh | bash
```

**Windows** (PowerShell):

```powershell
iwr https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.ps1 -UseBasicParsing | iex
```

What happens:
1. OS + arch detected. Linux x64, macOS x64/arm64, and Windows x64 are
   supported. (Linux arm64 isn't published as a binary — falls back to a
   helpful "use Path B (npm)" message.)
2. Two binaries downloaded: `vaultpilot-mcp` (the MCP server) and
   `vaultpilot-mcp-setup` (the wizard). Atomic write so a network drop
   never leaves a corrupt binary at the final path.
3. macOS: Gatekeeper quarantine xattr is stripped automatically.
4. PATH is checked. If your install dir isn't on `$PATH`, the script
   prints the one-line `export PATH="..."` you can append to your shell
   rc — never edits it for you.
5. The setup wizard runs in non-interactive mode, registers the MCP
   server with detected MCP clients (Claude Desktop, Claude Code,
   Cursor), and clones the companion preflight + setup skills into
   `~/.claude/skills/`.
6. The wizard emits a JSON envelope on stdout (the `InstallEnvelope`
   shape — see [`src/setup/output-json.ts`](./src/setup/output-json.ts)).
   The envelope's `next_steps` typically includes "restart your MCP
   client" so the new tools become visible.

**Idempotent**: re-running re-downloads (this is also the update path)
and the wizard recognizes already-present clients/skills, so a re-run
on a configured machine emits `status: "already_installed"`.

**Zero-config**: no API keys are collected. The runtime falls back to
free public RPC endpoints (PublicNode for EVM, etc.). When you're ready
to add provider keys (Infura/Alchemy/Helius/TronGrid/Etherscan/1inch),
run `vaultpilot-mcp-setup` interactively — it prompts per-key.

**Customization** via env vars (rarely needed):

| Env var | Default | Purpose |
|---|---|---|
| `VAULTPILOT_INSTALL_DIR` | `~/.local/bin` (Unix) / `%LOCALAPPDATA%\Programs\vaultpilot-mcp\` (Windows) | Where binaries go |
| `VAULTPILOT_RELEASE_URL` | `https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download` | Source of binaries (override for mirrors / smoke tests) |
| `VAULTPILOT_REPO` | `szhygulin/vaultpilot-mcp` | Underlying repo (only used when `VAULTPILOT_RELEASE_URL` is unset) |

**Security**: the install scripts are short and inspectable. Read them
on the [release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest)
or in the repo at [`scripts/install.sh`](./scripts/install.sh) /
[`scripts/install.ps1`](./scripts/install.ps1) before running. They
never `sudo`, never edit your shell rc, never collect keys, and never
pair your Ledger (the user does that interactively when ready).

## Path A — Bundled binary

### A1. Download the binaries for your OS

Open the [latest release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest)
and download **two** files for your platform:

| Platform | Server binary | Setup wizard |
|---|---|---|
| Linux x64 | `vaultpilot-mcp-linux-x64-server` | `vaultpilot-mcp-linux-x64-setup` |
| macOS Apple silicon (M1/M2/M3) | `vaultpilot-mcp-macos-arm64-server` | `vaultpilot-mcp-macos-arm64-setup` |
| macOS Intel | `vaultpilot-mcp-macos-x64-server` | `vaultpilot-mcp-macos-x64-setup` |
| Windows x64 | `vaultpilot-mcp-windows-x64-server.exe` | `vaultpilot-mcp-windows-x64-setup.exe` |

Move both files into a stable location — somewhere they will live
permanently and your MCP client can reach them. Suggested paths:

- **macOS / Linux**: `~/.local/bin/`
- **Windows**: `%LOCALAPPDATA%\Programs\vaultpilot-mcp\`

Create the directory first if it doesn't exist (`mkdir -p ~/.local/bin`
on Unix; right-click → New folder on Windows).

### A2. Make the binaries runnable

### macOS

macOS Gatekeeper blocks unsigned binaries by default. Two options to
get past it:

**Option A — strip the quarantine attribute (one-time, command-line)**

```bash
chmod +x ~/.local/bin/vaultpilot-mcp-macos-*
xattr -d com.apple.quarantine ~/.local/bin/vaultpilot-mcp-macos-* 2>/dev/null
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
chmod +x ~/.local/bin/vaultpilot-mcp-linux-x64-*
```

If you plan to use TRON or Solana hardware-signing flows, you also need
[Ledger udev rules](https://github.com/LedgerHQ/udev-rules). The setup
wizard in the next step detects this and prints the install one-liner
if they're missing.

### Windows

Windows SmartScreen will warn when you run an unsigned binary. Click
**More info** → **Run anyway** the first time you launch each binary.

Now skip to **section 3 — Run the setup wizard**.

## Path B — From npm

Prerequisites: Node.js ≥ 18.17 and npm. Check with `node -v` and
`npm -v`. If you don't have them, install via [nvm](https://github.com/nvm-sh/nvm)
on Unix or the [official Node.js installer](https://nodejs.org/) on
Windows. On macOS / Linux, prefer nvm so the global-install path lands
under your home directory rather than `/usr/local/` (avoids `EACCES`
permission errors).

### B1. Install globally

```bash
npm install -g vaultpilot-mcp
```

This places two executables on your PATH:

- `vaultpilot-mcp` — the MCP server
- `vaultpilot-mcp-setup` — the setup wizard

Linux: if you also want TRON / Solana hardware-signing, install the
build toolchain so `node-hid` can compile during install:

```bash
sudo apt install libudev-dev build-essential   # Debian / Ubuntu
sudo dnf install systemd-devel gcc-c++ make    # Fedora
```

### B2. Verify the install

```bash
which vaultpilot-mcp        # macOS / Linux
where.exe vaultpilot-mcp    # Windows
```

Both paths should resolve. If not, check `npm bin -g` is on your
PATH.

Now go to **section 3 — Run the setup wizard**.

## Path C — From source

Prerequisites: Node.js ≥ 18.17, npm, git, plus the OS build toolchain
listed in Path B (Linux only — macOS includes Xcode CLT, Windows ships
MSBuild with current Visual Studio installs).

### C1. Clone and build

```bash
git clone https://github.com/szhygulin/vaultpilot-mcp.git
cd vaultpilot-mcp
npm install --legacy-peer-deps
npm run build
```

`--legacy-peer-deps` is required because the Kamino SDK has a
transitive peer-dep nest npm 7+ rejects by default.

### C2. Run from the source checkout

You have two options for invoking the server:

```bash
# Option 1: run via npm scripts (stays in the repo)
npm start          # MCP server
npm run setup      # setup wizard

# Option 2: link globally so you can call from anywhere
npm link
# Then `vaultpilot-mcp` and `vaultpilot-mcp-setup` work from any directory.
```

`npm link` is reversible: `npm unlink -g vaultpilot-mcp` removes the
symlink. Useful if you want to test a local fork against your real
config without uninstalling the npm-published version.

### C3. Run the test suite (optional sanity check)

```bash
npm test
```

A successful run prints `Tests <N> passed`. As of v0.6.1 the suite is
~1,000 cases and runs in ~15s.

Now go to **section 3 — Run the setup wizard**.

## 3. Run the setup wizard

This is the one mandatory configuration step. It writes
`~/.vaultpilot-mcp/config.json` (or `%USERPROFILE%\.vaultpilot-mcp\config.json`
on Windows) with your RPC providers and optional API keys.

How you invoke the wizard depends on which install path you used:

```bash
# Path A — bundled binary (macOS / Linux)
~/.local/bin/vaultpilot-mcp-<platform>-<arch>-setup

# Path A — bundled binary (Windows, PowerShell)
& "$env:LOCALAPPDATA\Programs\vaultpilot-mcp\vaultpilot-mcp-windows-x64-setup.exe"

# Path B — installed via npm
vaultpilot-mcp-setup

# Path C — from source
npm run setup
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

You can also confirm the server itself runs by piping a JSON-RPC
request into stdin:

```bash
# Path A — bundled binary
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  ~/.local/bin/vaultpilot-mcp-<platform>-<arch>-server | head -c 200

# Path B — installed via npm
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  vaultpilot-mcp | head -c 200

# Path C — from source
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  node dist/index.js | head -c 200
```

A JSON envelope listing tools should print to stdout.

## 5. Manual MCP client wiring (if auto-register didn't run)

If the setup wizard couldn't detect your client, or you skipped the
auto-register prompt, add the entry manually. The JSON shape varies
slightly per install path:

```jsonc
// Path A — bundled binary (use the absolute path to the server binary)
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "/absolute/path/to/vaultpilot-mcp-<platform>-<arch>-server"
    }
  }
}

// Path B — installed via npm (the bin shim is on PATH)
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "vaultpilot-mcp"
    }
  }
}

// Path C — from source
{
  "mcpServers": {
    "vaultpilot-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/vaultpilot-mcp/dist/index.js"]
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

**Path A — bundled binary**

1. Download the new binaries from the [latest release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest).
2. Replace the old files at the same paths.
3. On macOS, re-run `xattr -d com.apple.quarantine` (or right-click →
   Open once each). On Windows, click through SmartScreen once each.
4. Restart your MCP client so it picks up the new binary.

**Path B — npm**

```bash
npm update -g vaultpilot-mcp
# or for a specific version:
npm install -g vaultpilot-mcp@<version>
```

Then restart your MCP client.

**Path C — from source**

```bash
cd /path/to/vaultpilot-mcp
git pull --ff-only
npm install --legacy-peer-deps
npm run build
```

Your config file at `~/.vaultpilot-mcp/config.json` is preserved
across all three update paths.

## 8. Uninstall

**Path A — bundled binary**

```bash
# Remove the binaries
rm ~/.local/bin/vaultpilot-mcp-*-server ~/.local/bin/vaultpilot-mcp-*-setup
# (Windows: delete the files in %LOCALAPPDATA%\Programs\vaultpilot-mcp\)
```

**Path B — npm**

```bash
npm uninstall -g vaultpilot-mcp
```

**Path C — from source**

```bash
# If you ran `npm link`:
npm unlink -g vaultpilot-mcp
# Then delete the source checkout:
rm -rf /path/to/vaultpilot-mcp
```

**All paths — clean up shared state**

1. Remove the config: `rm -rf ~/.vaultpilot-mcp/` (Unix) or delete
   `%USERPROFILE%\.vaultpilot-mcp\` (Windows).
2. Remove the `vaultpilot-mcp` entry from your MCP client's config
   file (paths in section 5).
3. Optional — remove the companion skills:
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

**WalletConnect "peer not currently reachable" on `send_transaction`.**
Closing the WalletConnect subapp inside Ledger Live — or putting the
host machine to sleep — temporarily breaks reachability without ending
the session. The MCP retains the persisted session across these
transient drops, so the recovery is: open WalletConnect in Ledger Live
again (Discover → WalletConnect, or Settings → Connected Apps →
WalletConnect depending on Ledger Live version) and re-call
`send_transaction` on the **same handle** within its 15-minute TTL —
no re-pair needed. Only if reopening doesn't restore reachability after
a few seconds is the session genuinely ended; in that case run
`pair_ledger_live` for a fresh one. Mobile Ledger Live can drop the
session faster than desktop because OS-level app suspension can
outlast the relay's topic TTL.

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
