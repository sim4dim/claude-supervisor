#!/usr/bin/env bash
# StopFailure Hook — fires when a session turn ends due to an API error
set -euo pipefail

SUPERVISOR_URL="${CLAUDE_SUPERVISOR_URL:-http://localhost:3847}"
MQTT_HOST="${SUPERVISOR_MQTT_HOST:-localhost}"

# Auth token for supervisor API
_sv_auth_header() {
  local token_file="$HOME/.claude/.supervisor-hook-token"
  if [ -f "$token_file" ]; then
    echo "Authorization: Bearer $(cat "$token_file")"
  fi
}
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"
TASK_ID="${SV_TASK_ID:-agent}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
ERROR_CODE=$(echo "$INPUT" | jq -r '.error.code // .error_code // ""')
ERROR_MSG=$(echo "$INPUT" | jq -r '.error.message // .error_message // .message // "unknown error"')

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_FILE="${CLAUDE_PROJECT_DIR:-$PWD}/logs/stop-failures.log"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# ─── Log to file ────────────────────────────────────────────────────────────
echo "[$TIMESTAMP] session=$SESSION_ID project=$PROJECT error_code=$ERROR_CODE message=$ERROR_MSG" \
  >> "$LOG_FILE" 2>/dev/null || true

# ─── Publish general failure status to MQTT ─────────────────────────────────
sv pub status failed "API error: $ERROR_CODE — $ERROR_MSG" 2>/dev/null || true

# ─── Rate limit (429): publish specific alert ────────────────────────────────
if [ "$ERROR_CODE" = "429" ] || echo "$ERROR_MSG" | grep -qi "rate.limit\|too many requests"; then
  sv pub alert rate-limit "Rate limit hit on project $PROJECT (session $SESSION_ID): $ERROR_MSG" 2>/dev/null || true
fi

# ─── Auth failure (401): trigger token refresh if available ──────────────────
if [ "$ERROR_CODE" = "401" ] || echo "$ERROR_MSG" | grep -qi "unauthorized\|authentication\|invalid.*token\|token.*invalid"; then
  REFRESH_SCRIPT="${CLAUDE_PROJECT_DIR:-$PWD}/bin/refresh-token.sh"
  if [ -x "$REFRESH_SCRIPT" ]; then
    sv pub alert auth-failure "Auth failure on project $PROJECT — triggering token refresh" 2>/dev/null || true
    "$REFRESH_SCRIPT" 2>/dev/null || true
  else
    sv pub alert auth-failure "Auth failure on project $PROJECT (no refresh-token.sh found): $ERROR_MSG" 2>/dev/null || true
  fi
fi

# ─── Notify supervisor HTTP endpoint ─────────────────────────────────────────
curl -s --max-time 3 \
    -X POST "${SUPERVISOR_URL}/api/hook/log" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg session "$SESSION_ID" \
        --arg event "StopFailure" \
        --arg summary "API error ($ERROR_CODE): $ERROR_MSG" \
        --arg project "$PROJECT" \
        '{tool: "agent", summary: $summary, session_id: $session, event: $event, project: $project}'
    )" >/dev/null 2>&1 || true

exit 0
