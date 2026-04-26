#!/usr/bin/env bash
#
# vaultpilot-mcp installer for Linux + macOS.
#
# Hosted at:
#   https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.sh
#
# Designed for the agent-driven install path
# (claude-work/HIGH-plan-agent-driven-install.md). An LLM-coding agent
# can run this in one Bash call:
#
#   curl -fsSL https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.sh | bash
#
# What it does:
#   1. Detect OS + arch.
#   2. Download the matching server + setup binaries from the latest
#      GitHub Release into ~/.local/bin (or $VAULTPILOT_INSTALL_DIR).
#   3. Run `vaultpilot-mcp-setup --non-interactive --json`, which
#      registers MCP clients (Claude Desktop / Claude Code / Cursor)
#      and clones the companion skills.
#   4. Print the setup wizard's JSON envelope so the calling agent
#      can parse `next_steps` and relay them to the user.
#
# What it does NOT do:
#   - Collect API keys (zero-config defaults — PublicNode RPC).
#   - Pair a Ledger (requires hardware presence; user-only step).
#   - Auto-restart MCP clients (no portable way; envelope tells the
#     agent which client to ask the user to restart).
#   - Modify the user's shell rc (PATH suggestion is printed for the
#     user to add manually if needed; we never `>>` rc files).
#
# Behavior is idempotent: re-running re-downloads the binaries and
# re-runs the wizard, which is itself idempotent (already-present
# clients / skills are no-ops). This is also the update path.

set -euo pipefail

# ----------------------------------------------------------------------
# Config — overridable via env, sensible defaults otherwise.
# ----------------------------------------------------------------------

REPO="${VAULTPILOT_REPO:-szhygulin/vaultpilot-mcp}"
INSTALL_DIR="${VAULTPILOT_INSTALL_DIR:-$HOME/.local/bin}"
RELEASE_BASE_URL="${VAULTPILOT_RELEASE_URL:-https://github.com/${REPO}/releases/latest/download}"

# ----------------------------------------------------------------------
# Pretty output (no color when stdout is not a TTY — script may be
# parsed by an agent or piped into `tee`).
# ----------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"
  C_DIM="$(printf '\033[2m')"
  C_BLUE="$(printf '\033[34m')"
  C_GREEN="$(printf '\033[32m')"
  C_RED="$(printf '\033[31m')"
  C_YELLOW="$(printf '\033[33m')"
else
  C_RESET=""
  C_DIM=""
  C_BLUE=""
  C_GREEN=""
  C_RED=""
  C_YELLOW=""
fi

log()    { printf "%s[vaultpilot]%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()     { printf "%s[vaultpilot]%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn()   { printf "%s[vaultpilot]%s %s%s%s\n" "$C_BLUE" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" >&2; }
fatal()  { printf "%s[vaultpilot]%s %sERROR:%s %s\n" "$C_BLUE" "$C_RESET" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
dim()    { printf "%s%s%s" "$C_DIM" "$*" "$C_RESET"; }

# ----------------------------------------------------------------------
# OS + arch detection → asset name pair.
#
# Asset names match the release pipeline (.github/workflows/
# release-binaries.yml). Linux is x64-only at present; macOS has
# x64 + arm64. Windows is handled by install.ps1, not this script.
# ----------------------------------------------------------------------

detect_target() {
  local uname_s uname_m os arch
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  case "$uname_s" in
    Linux)  os="linux" ;;
    Darwin) os="macos" ;;
    *)
      fatal "Unsupported OS '$uname_s'. This installer supports Linux and macOS. For Windows, use install.ps1. For other OSes, install from npm: \`npm i -g vaultpilot-mcp\`."
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      fatal "Unsupported CPU arch '$uname_m'. Supported: x86_64 / amd64, arm64 / aarch64. Install from npm instead: \`npm i -g vaultpilot-mcp\`."
      ;;
  esac

  # The release pipeline ships Linux as x64 only — Linux arm64 binary
  # isn't built. Fall back to the npm install instructions in that
  # case rather than 404'ing the asset download below.
  if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
    fatal "Linux arm64 binaries are not published. Install from npm: \`npm i -g vaultpilot-mcp\` (requires Node 22+)."
  fi

  TARGET_OS="$os"
  TARGET_ARCH="$arch"
  SERVER_ASSET="vaultpilot-mcp-${os}-${arch}-server"
  SETUP_ASSET="vaultpilot-mcp-${os}-${arch}-setup"
}

# ----------------------------------------------------------------------
# Tool checks. We need curl (or wget) and a writable install dir.
# ----------------------------------------------------------------------

require_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
  else
    fatal "Neither \`curl\` nor \`wget\` is installed. Install one and retry."
  fi
}

# Download $1 (URL) → $2 (path), atomically (write to .tmp then mv) so
# a partial download never leaves a corrupt binary at the final path.
download() {
  local url="$1" dest="$2" tmp="$2.partial"
  if [ "$DOWNLOADER" = "curl" ]; then
    # -f: fail on HTTP error (4xx/5xx); -L: follow redirects (GH
    # Releases /latest/download/ is a redirect); -o: output path.
    # We do NOT pin --proto "=https" here — the default URL is HTTPS,
    # and an attacker controlling the env-overridden VAULTPILOT_RELEASE_URL
    # would just use HTTPS too. Restricting the scheme would block
    # local smoke tests against http://127.0.0.1 without buying real
    # safety.
    curl -fL -o "$tmp" "$url"
  else
    wget -O "$tmp" "$url"
  fi
  mv "$tmp" "$dest"
}

# ----------------------------------------------------------------------
# Install binaries.
# ----------------------------------------------------------------------

install_binaries() {
  mkdir -p "$INSTALL_DIR"

  local server_path="$INSTALL_DIR/vaultpilot-mcp"
  local setup_path="$INSTALL_DIR/vaultpilot-mcp-setup"

  log "Downloading server binary…"
  log "  $(dim "$RELEASE_BASE_URL/$SERVER_ASSET")"
  download "$RELEASE_BASE_URL/$SERVER_ASSET" "$server_path"
  chmod +x "$server_path"

  log "Downloading setup wizard binary…"
  log "  $(dim "$RELEASE_BASE_URL/$SETUP_ASSET")"
  download "$RELEASE_BASE_URL/$SETUP_ASSET" "$setup_path"
  chmod +x "$setup_path"

  # macOS: strip the quarantine xattr so Gatekeeper doesn't refuse to
  # run the unsigned binary on first launch. `xattr -d` exits non-zero
  # if the attribute isn't there — that's fine, we silence it.
  if [ "$TARGET_OS" = "macos" ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$server_path" 2>/dev/null || true
    xattr -d com.apple.quarantine "$setup_path"  2>/dev/null || true
  fi

  ok "Installed binaries to $INSTALL_DIR"
  SETUP_PATH="$setup_path"
  SERVER_PATH="$server_path"
}

# ----------------------------------------------------------------------
# PATH check. Don't auto-edit shell rc — print the one-liner instead so
# the user (or agent) can decide. Touching ~/.bashrc / ~/.zshrc without
# explicit consent is the kind of action this server's CLAUDE.md
# warns against ("hard-to-reverse" / "shared state").
# ----------------------------------------------------------------------

advise_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      ok "$INSTALL_DIR is on your PATH."
      return
      ;;
  esac
  warn "$INSTALL_DIR is NOT on your PATH."
  warn "  Add it by appending this line to your shell rc:"
  warn ""
  warn "    export PATH=\"$INSTALL_DIR:\$PATH\""
  warn ""
  warn "  Then reopen your terminal (or \`source\` the rc file)."
}

# ----------------------------------------------------------------------
# Run the setup wizard in --non-interactive --json mode and print the
# envelope. The wizard registers MCP clients + installs companion
# skills. Zero-config defaults; no API keys collected; no Ledger
# pairing.
# ----------------------------------------------------------------------

run_setup() {
  log "Running setup wizard (non-interactive, JSON output)…"
  printf "\n"
  # The wizard emits the InstallEnvelope on stdout. We pass it through
  # verbatim so the calling agent can parse it.
  if "$SETUP_PATH" --non-interactive --json; then
    printf "\n"
    ok "Setup completed."
  else
    fatal "Setup wizard exited with a non-zero status. See the JSON envelope above for the structured error."
  fi
}

# ----------------------------------------------------------------------
# Main.
# ----------------------------------------------------------------------

main() {
  log "VaultPilot MCP installer"
  detect_target
  log "Target: $TARGET_OS/$TARGET_ARCH"
  log "Install dir: $INSTALL_DIR"
  printf "\n"

  require_downloader
  install_binaries
  advise_path
  printf "\n"
  run_setup

  printf "\n"
  log "Done. The JSON envelope above lists which MCP clients were registered (or"
  log "already-present), and a \`next_steps\` array — usually 'restart your MCP"
  log "client' so vaultpilot-mcp's tools become visible. To pair your Ledger or"
  log "set provider API keys, run \`vaultpilot-mcp-setup\` interactively."
}

main "$@"
