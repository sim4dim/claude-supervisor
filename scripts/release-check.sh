#!/usr/bin/env bash
# Daily lightweight release check for Claude Code.
# Compares installed vs latest npm version.
# If a new version exists, writes a marker file and publishes via mosquitto_pub.
# The full evaluation happens when the user runs /release-monitor in a supervisor session.
# Idempotent: won't re-notify if marker file already exists for that version.

set -euo pipefail

PROJECT_DIR="${CLAUDE_SUPERVISOR_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DROPS_DIR="$PROJECT_DIR/drops"
mkdir -p "$DROPS_DIR"

# Get current installed version
CURRENT_VERSION=$(claude --version 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "unknown")

# Get latest npm version
LATEST_VERSION=$(npm view @anthropic-ai/claude-code version 2>/dev/null || echo "")

if [[ -z "$LATEST_VERSION" ]]; then
    echo "$(date -Iseconds) release-check: could not fetch latest version from npm" >&2
    exit 0
fi

echo "$(date -Iseconds) release-check: current=$CURRENT_VERSION latest=$LATEST_VERSION"

if [[ "$CURRENT_VERSION" == "$LATEST_VERSION" ]]; then
    # No new release — exit silently
    exit 0
fi

# New version found — check if we already notified for this version
MARKER_FILE="$DROPS_DIR/new-release-${LATEST_VERSION}.marker"

if [[ -f "$MARKER_FILE" ]]; then
    # Already notified for this version — don't spam
    echo "$(date -Iseconds) release-check: already notified for $LATEST_VERSION, skipping"
    exit 0
fi

# Write marker file
TIMESTAMP=$(date -Iseconds)
cat > "$MARKER_FILE" <<EOF
version=$LATEST_VERSION
current=$CURRENT_VERSION
timestamp=$TIMESTAMP
EOF

# Publish via mosquitto_pub
PAYLOAD=$(printf '{"current": "%s", "latest": "%s", "timestamp": "%s"}' "$CURRENT_VERSION" "$LATEST_VERSION" "$TIMESTAMP")
mosquitto_pub -t "supervisor/claude-supervisor/releases" -m "$PAYLOAD" 2>/dev/null || true

echo "$(date -Iseconds) release-check: new version $LATEST_VERSION detected, notification published"
