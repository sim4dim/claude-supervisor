#!/usr/bin/env bash
# Notification Hook — forwards Claude Code notifications to the supervisor web UI
set -euo pipefail

SUPERVISOR_URL="${CLAUDE_SUPERVISOR_URL:-http://localhost:3847}"

# Auth token for supervisor API
_sv_auth_header() {
  local token_file="$HOME/.claude/.supervisor-hook-token"
  if [ -f "$token_file" ]; then
    echo "Authorization: Bearer $(cat "$token_file")"
  fi
}

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude Code needs attention"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")

# Forward to supervisor (fire-and-forget)
curl -s --max-time 3 \
    -X POST "${SUPERVISOR_URL}/api/hook/notify" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n --arg msg "$MESSAGE" --arg sid "$SESSION_ID" --arg project "$PROJECT" \
        '{message: $msg, session_id: $sid, type: "notification", project: $project}'
    )" >/dev/null 2>&1 || true

# Also trigger system notification on Linux
if command -v notify-send &>/dev/null; then
    notify-send "Claude Code" "$MESSAGE" -u normal -t 5000 2>/dev/null || true
fi

exit 0
