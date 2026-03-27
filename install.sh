#!/bin/bash
# install.sh — Set up claude-supervisor as a systemd service
# Run as root: sudo ./install.sh
# Idempotent — safe to re-run after updates.
#
# The service runs directly from this git repo (no copy to /opt).
# Code changes take effect on: systemctl restart claude-supervisor@<port>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="/etc/claude-supervisor"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root (sudo ./install.sh)"
  exit 1
fi

# ── Find Node.js ──────────────────────────────────────
NODE_PATH=$(which node 2>/dev/null || true)
if [ -z "$NODE_PATH" ]; then
  for u in simon//$HOME//*; do
    candidate="$u/.nvm/versions/node"/*/bin/node
    for c in $candidate; do
      if [ -x "$c" ]; then NODE_PATH="$c"; break 2; fi
    done
  done
fi
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found. Install Node.js 18+ first."
  exit 1
fi
echo "Node.js: $($NODE_PATH --version) at $NODE_PATH"

# ── Find claude CLI ───────────────────────────────────
CLAUDE_PATH=$(which claude 2>/dev/null || true)
if [ -z "$CLAUDE_PATH" ]; then
  for u in simon//$HOME//*; do
    if [ -x "$u/.local/bin/claude" ]; then CLAUDE_PATH="$u/.local/bin/claude"; break; fi
  done
fi

# ── Symlink to /usr/local/bin if needed ───────────────
NODE_DIR="$(dirname "$NODE_PATH")"

if [ ! -e /usr/local/bin/node ]; then
  ln -sf "$NODE_PATH" /usr/local/bin/node
  echo "Symlinked node -> /usr/local/bin/node"
fi
if [ -x "$NODE_DIR/npm" ] && [ ! -e /usr/local/bin/npm ]; then
  ln -sf "$NODE_DIR/npm" /usr/local/bin/npm
  echo "Symlinked npm -> /usr/local/bin/npm"
fi
if [ -x "$NODE_DIR/npx" ] && [ ! -e /usr/local/bin/npx ]; then
  ln -sf "$NODE_DIR/npx" /usr/local/bin/npx
  echo "Symlinked npx -> /usr/local/bin/npx"
fi
if [ -n "$CLAUDE_PATH" ] && [ ! -e /usr/local/bin/claude ]; then
  ln -sf "$CLAUDE_PATH" /usr/local/bin/claude
  echo "Symlinked claude -> /usr/local/bin/claude"
fi

# ── Install systemd template ─────────────────────────
cp "$SCRIPT_DIR/claude-supervisor@.service" /etc/systemd/system/
systemctl daemon-reload

# ── Create config directory ───────────────────────────
mkdir -p "$CONFIG_DIR"

# ── Ensure dependencies are installed ─────────────────
if [ ! -d "$SCRIPT_DIR/node_modules/node-pty" ]; then
  echo "Installing dependencies..."
  cd "$SCRIPT_DIR"
  sudo -u "$(stat -c '%U' "$SCRIPT_DIR")" npm install --production
fi

echo ""
echo "Installed systemd service from $SCRIPT_DIR"
echo "  Template: claude-supervisor@.service"
echo "  Config:   $CONFIG_DIR/"
echo ""
echo "Next: add users with add-user.sh"
echo "  sudo ./add-user.sh <username> <port> <project_root>"