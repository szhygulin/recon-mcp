# vaultpilot-mcp installer for Windows.
#
# Hosted at:
#   https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.ps1
#
# Designed for the agent-driven install path
# (claude-work/HIGH-plan-agent-driven-install.md). An LLM-coding agent
# can run this in one PowerShell call:
#
#   iwr https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.ps1 -UseBasicParsing | iex
#
# What it does:
#   1. Detect arch (x64 only at the moment — the release pipeline
#      doesn't ship Windows arm64 yet).
#   2. Download the unified vaultpilot-mcp.exe from the latest GitHub
#      Release into %LOCALAPPDATA%\Programs\vaultpilot-mcp\
#      (or $env:VAULTPILOT_INSTALL_DIR).
#   3. Run `vaultpilot-mcp setup --non-interactive --json` which
#      registers MCP clients (Claude Desktop / Claude Code / Cursor)
#      and clones the companion skills.
#   4. Print the setup wizard's JSON envelope so the calling agent
#      can parse `next_steps` and relay them to the user.
#
# Prior shape (≤ v0.12.0): two separate .exe binaries (`*-server.exe`
# and `*-setup.exe`). Unified into one in v0.13.0 — the setup wizard
# is now `vaultpilot-mcp setup`.
#
# What it does NOT do:
#   - Collect API keys (zero-config defaults — PublicNode RPC).
#   - Pair a Ledger (requires hardware presence; user-only step).
#   - Auto-restart MCP clients (tell the user via `next_steps`).
#   - Persistently modify the user's PATH (a session-scope `$env:PATH`
#     update lets the wizard run; a permanent edit is suggested as a
#     one-liner the user can run themselves).
#
# Behavior is idempotent: re-running re-downloads and re-runs the
# wizard, which is itself idempotent. This is also the update path.

#Requires -Version 5.1

# Strict mode + stop on any error so a bad download or 404 surfaces
# immediately rather than continuing and emitting confusing later
# failures.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Modern TLS — older PS5.1 defaults to TLS 1.0 which GitHub's CDN
# rejects. Idempotent assignment.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ----------------------------------------------------------------------
# Config — overridable via env, sensible defaults otherwise.
# ----------------------------------------------------------------------

$Repo = if ($env:VAULTPILOT_REPO) { $env:VAULTPILOT_REPO } else { 'szhygulin/vaultpilot-mcp' }
$InstallDir = if ($env:VAULTPILOT_INSTALL_DIR) {
  $env:VAULTPILOT_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'Programs\vaultpilot-mcp'
}
$ReleaseBaseUrl = if ($env:VAULTPILOT_RELEASE_URL) {
  $env:VAULTPILOT_RELEASE_URL
} else {
  "https://github.com/$Repo/releases/latest/download"
}

# ----------------------------------------------------------------------
# Pretty output. Use Write-Host with colors so messages render in the
# integrated terminal of VS Code / Cursor / Claude Code on Windows.
# ----------------------------------------------------------------------

function Log     { param([string]$msg) Write-Host "[vaultpilot] $msg" -ForegroundColor Blue }
function Ok      { param([string]$msg) Write-Host "[vaultpilot] $msg" -ForegroundColor Green }
function WarnMsg { param([string]$msg) Write-Host "[vaultpilot] $msg" -ForegroundColor Yellow }
function Fatal   { param([string]$msg) Write-Host "[vaultpilot] ERROR: $msg" -ForegroundColor Red; exit 1 }

# ----------------------------------------------------------------------
# Arch detection → asset name pair.
#
# Matches the release pipeline (.github/workflows/release-binaries.yml).
# Windows is x64-only at present.
# ----------------------------------------------------------------------

function Detect-Target {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -ne 'AMD64' -and $arch -ne 'x64') {
    Fatal "Unsupported Windows arch '$arch'. Only x64 is published; install from npm: ``npm i -g vaultpilot-mcp`` (requires Node 22+)."
  }
  $script:ServerAsset = 'vaultpilot-mcp-windows-x64-server.exe'
  $script:TargetArch  = 'x64'
}

# ----------------------------------------------------------------------
# Atomic download: write to .partial then rename, so a partial download
# never leaves a corrupt binary at the final path.
# ----------------------------------------------------------------------

function Download-File {
  param(
    [Parameter(Mandatory)] [string] $Url,
    [Parameter(Mandatory)] [string] $Dest
  )
  $tmp = "$Dest.partial"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  # -UseBasicParsing matters on Windows PowerShell 5.1 (avoids loading
  # the legacy IE engine which can hang on machines without IE
  # configured). Implicit on PS Core 6+ but harmless there.
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  if (Test-Path $Dest) { Remove-Item $Dest -Force }
  Move-Item $tmp $Dest
}

# ----------------------------------------------------------------------
# Install binaries.
# ----------------------------------------------------------------------

function Install-Binaries {
  if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  $serverPath = Join-Path $InstallDir 'vaultpilot-mcp.exe'

  Log "Downloading vaultpilot-mcp binary..."
  Log "  $ReleaseBaseUrl/$ServerAsset"
  Download-File -Url "$ReleaseBaseUrl/$ServerAsset" -Dest $serverPath

  Ok "Installed binary to $InstallDir"
  $script:ServerPath = $serverPath
}

# ----------------------------------------------------------------------
# PATH advisory. Don't permanently modify the user's PATH from a script
# piped into iex — that's the kind of action this server's CLAUDE.md
# warns against ("hard-to-reverse" / "shared state"). Update the
# session-scope PATH so the wizard finds the binary, and print a
# one-liner the user can run themselves to make it permanent.
# ----------------------------------------------------------------------

function Advise-Path {
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  $pathEntries = if ($userPath) { $userPath.Split(';') } else { @() }
  if ($pathEntries -contains $InstallDir) {
    Ok "$InstallDir is on your User PATH."
    return
  }
  WarnMsg "$InstallDir is NOT on your User PATH."
  WarnMsg "  Updated this PowerShell session's PATH so the wizard can run."
  WarnMsg "  To make this permanent, run (once, in any PowerShell):"
  WarnMsg ""
  WarnMsg "    [Environment]::SetEnvironmentVariable('PATH', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('PATH','User'), 'User')"
  WarnMsg ""
  # Update the in-process PATH so `Run-Setup` below can find the binary
  # on the script's own search path. This is process-scope only.
  $env:PATH = "$InstallDir;$env:PATH"
}

# ----------------------------------------------------------------------
# Run the setup wizard in --non-interactive --json mode and print the
# envelope verbatim. The wizard registers MCP clients + installs
# companion skills. Zero-config defaults; no API keys; no Ledger
# pairing.
# ----------------------------------------------------------------------

function Run-Setup {
  Log "Running setup wizard (non-interactive, JSON output)..."
  Write-Host ""
  # Invoke directly via the absolute path so we don't depend on the
  # PATH advisory branch having succeeded. `setup` subcommand routes
  # into the wizard inside the unified binary.
  & $ServerPath 'setup' '--non-interactive' '--json'
  $exitCode = $LASTEXITCODE
  Write-Host ""
  if ($exitCode -ne 0) {
    Fatal "Setup wizard exited with code $exitCode. See the JSON envelope above for the structured error."
  }
  Ok "Setup completed."
}

# ----------------------------------------------------------------------
# Main.
# ----------------------------------------------------------------------

Log "VaultPilot MCP installer"
Detect-Target
Log "Target: windows/$TargetArch"
Log "Install dir: $InstallDir"
Write-Host ""

Install-Binaries
Advise-Path
Write-Host ""
Run-Setup

Write-Host ""
Log "Done. The JSON envelope above lists which MCP clients were registered (or"
Log "already-present), and a 'next_steps' array — usually 'restart your MCP"
Log "client' so vaultpilot-mcp's tools become visible. To pair your Ledger or"
Log "set provider API keys, run 'vaultpilot-mcp setup' interactively."
