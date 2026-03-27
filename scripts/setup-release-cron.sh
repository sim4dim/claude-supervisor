#!/usr/bin/env bash
# Sets up a daily crontab entry to run the Claude Code release check at 6am.
# Safe to run multiple times — idempotent (won't add duplicate entries).

set -euo pipefail

PROJECT_DIR="${CLAUDE_SUPERVISOR_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
RELEASE_CHECK="$PROJECT_DIR/scripts/release-check.sh"

if [[ ! -f "$RELEASE_CHECK" ]]; then
    echo "Error: $RELEASE_CHECK not found" >&2
    exit 1
fi

chmod +x "$RELEASE_CHECK"

CRON_ENTRY="0 6 * * * cd $PROJECT_DIR && ./scripts/release-check.sh >> logs/release-check.log 2>&1"
CRON_MARKER="release-check.sh"

# Check if entry already exists
if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
    echo "Cron entry already present — no changes made."
    crontab -l | grep "$CRON_MARKER"
    exit 0
fi

# Add the new entry
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -

echo "Cron entry added:"
echo "  $CRON_ENTRY"
echo ""
echo "The release check will run daily at 6am."
echo "Logs: $PROJECT_DIR/logs/release-check.log"
echo "Run manually: $RELEASE_CHECK"
