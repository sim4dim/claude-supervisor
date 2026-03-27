#!/bin/bash
# add-user.sh — Configure a claude-supervisor instance for a user
# Run as root: sudo ./add-user.sh <username> <port> <project_root>
#
# Examples:
#   sudo ./add-user.sh simon 3847 simon//$HOME//simon/projects
#   sudo ./add-user.sh elena 3848 simon//$HOME//elena/projects

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USERNAME="$1"
PORT="$2"
PROJECT_ROOT="$3"

if [ -z "$USERNAME" ] || [ -z "$PORT" ] || [ -z "$PROJECT_ROOT" ]; then
  echo "Usage: $0 <username> <port> <project_root>"
  echo "  username:     Linux user who will own this instance"
  echo "  port:         Unique port (e.g., 3847, 3848)"
  echo "  project_root: Parent directory of user's projects"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root (sudo $0 ...)"
  exit 1
fi

# Verify user exists
id "$USERNAME" >/dev/null 2>&1 || { echo "Error: user '$USERNAME' not found"; exit 1; }

# Verify project root exists
[ -d "$PROJECT_ROOT" ] || { echo "Error: $PROJECT_ROOT does not exist"; exit 1; }

# Verify install was run
[ -f /etc/systemd/system/claude-supervisor@.service ] || { echo "Error: run install.sh first"; exit 1; }

CONFIG_DIR="/etc/claude-supervisor"
mkdir -p "$CONFIG_DIR"

# ── Create env file ───────────────────────────────────
cat > "$CONFIG_DIR/${PORT}.env" <<EOF
SUPERVISOR_PROJECT_ROOT=$PROJECT_ROOT
SUPERVISOR_MODE=auto
SUPERVISOR_MODEL=claude-sonnet-4-20250514
SUPERVISOR_CONFIDENCE_THRESHOLD=0.8
SUPERVISOR_MAX_TERMINALS=5
# SUPERVISOR_DTACH_DIR=/tmp
EOF
echo "Created $CONFIG_DIR/${PORT}.env"

# ── Create systemd override ──────────────────────────
OVERRIDE_DIR="/etc/systemd/system/claude-supervisor@${PORT}.service.d"
mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE_DIR/override.conf" <<EOF
[Service]
User=$USERNAME
Group=$USERNAME
WorkingDirectory=$SCRIPT_DIR
EOF
echo "Created systemd override (User=$USERNAME, WorkingDirectory=$SCRIPT_DIR)"

# ── Install sv helper on user's PATH ──────────────────
SV_BIN="simon//$HOME//$USERNAME/.local/bin"
mkdir -p "$SV_BIN"
ln -sf "$SCRIPT_DIR/bin/sv" "$SV_BIN/sv"
chown -R "$USERNAME:$USERNAME" "simon//$HOME//$USERNAME/.local"
echo "Symlinked sv helper to $SV_BIN/sv"

# ── Enable and start ──────────────────────────────────
systemctl daemon-reload
systemctl enable "claude-supervisor@${PORT}"
systemctl restart "claude-supervisor@${PORT}"

echo ""
echo "Instance configured:"
echo "  User:         $USERNAME"
echo "  Port:         $PORT"
echo "  Project root: $PROJECT_ROOT"
echo "  Source:       $SCRIPT_DIR"
echo "  Dashboard:    http://localhost:$PORT"
echo ""
echo "Management:"
echo "  systemctl status claude-supervisor@$PORT"
echo "  systemctl restart claude-supervisor@$PORT"
echo "  journalctl -u claude-supervisor@$PORT -f"
echo ""
echo "After code changes, restart with:"
echo "  sudo systemctl restart claude-supervisor@$PORT"