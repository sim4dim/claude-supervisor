#!/usr/bin/env bash
# Stop Hook — logs when Claude Code finishes responding
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
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

STOP_REASON=$(echo "$INPUT" | jq -r '.stop_hook_reason // .reason // "end_turn"')

curl -s --max-time 3 \
    -X POST "${SUPERVISOR_URL}/api/hook/log" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg session "$SESSION_ID" \
        --arg event "Stop" \
        --arg summary "Claude finished responding ($STOP_REASON)" \
        --arg project "$PROJECT" \
        '{tool: "agent", summary: $summary, session_id: $session, event: $event, project: $project}'
    )" >/dev/null 2>&1 || true

# ─── Publish session stop to MQTT ─────────────────────────────────────────

MQTT_HOST="${SUPERVISOR_MQTT_HOST:-localhost}"
TASK_ID="${SV_TASK_ID:-agent}"

mosquitto_pub -h "$MQTT_HOST" \
  -t "supervisor/$PROJECT/$TASK_ID/status" \
  -m "$(python3 -c "
import json, sys
print(json.dumps({'status': sys.argv[1], 'description': 'Session stopped'}, ensure_ascii=False))
" "$STOP_REASON")" 2>/dev/null || true

# ─── Write session handoff file on real session end ───────────────────────────
# Skip end_turn (fires every turn) — only write for actual session endings

if [ "$STOP_REASON" != "end_turn" ]; then
  HANDOFF_FILE="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/session-handoff.md"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  {
    echo "# Session Handoff"
    echo "Generated: $TIMESTAMP"
    echo "Stop reason: $STOP_REASON"
    echo ""
    echo "## Git State"
    if cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null; then
      git status --short 2>/dev/null || echo "(not a git repo)"
      echo ""
      echo "## Uncommitted Changes"
      DIFF_STAT=$(git diff --stat 2>/dev/null)
      if [ -n "$DIFF_STAT" ]; then
        echo "$DIFF_STAT"
      else
        echo "None"
      fi
      echo ""
      echo "## Recent Commits (this session)"
      git log --oneline -5 2>/dev/null || echo "(no commits)"
    else
      echo "(could not determine git state)"
    fi
    echo ""
    echo "## Checklist for Next Session"
    echo "- [ ] Check uncommitted changes above — were they intentional?"
    echo "- [ ] Review any background tasks that may have been running"
  } > "$HANDOFF_FILE" 2>/dev/null || true
fi

exit 0
