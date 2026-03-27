#!/usr/bin/env bash
# PostToolUse Hook — logs completed tool calls to the supervisor
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
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# Build summary
case "$TOOL_NAME" in
    Bash)   SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.command // ""' | head -c 200) ;;
    Write)  SUMMARY="wrote $(echo "$TOOL_INPUT" | jq -r '.file_path // "?"')" ;;
    Edit|NotebookEdit)  SUMMARY="edited $(echo "$TOOL_INPUT" | jq -r '.file_path // "?"')" ;;
    Read)   SUMMARY="read $(echo "$TOOL_INPUT" | jq -r '.file_path // "?"')" ;;
    *)      SUMMARY="$TOOL_NAME completed" ;;
esac

# Fire-and-forget log to supervisor
curl -s --max-time 3 \
    -X POST "${SUPERVISOR_URL}/api/hook/log" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg tool "$TOOL_NAME" \
        --arg summary "$SUMMARY" \
        --arg session "$SESSION_ID" \
        --arg event "PostToolUse" \
        --arg project "$PROJECT" \
        '{tool: $tool, summary: $summary, session_id: $session, event: $event, project: $project}'
    )" >/dev/null 2>&1 || true

# ─── Auto-publish agent activity to MQTT ──────────────────────────────────

MQTT_HOST="${SUPERVISOR_MQTT_HOST:-localhost}"
TASK_ID="${SV_TASK_ID:-agent}"

# Publish agent activity to MQTT for all tools
case "$TOOL_NAME" in
  Bash)
    COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""' | head -c 200)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': 'Running: ' + sys.argv[1][:150]}, ensure_ascii=False))
" "$COMMAND")" 2>/dev/null || true
    ;;
  Edit|Write|NotebookEdit)
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': 'Editing: ' + sys.argv[1]}, ensure_ascii=False))
" "$FILE_PATH")" 2>/dev/null || true
    ;;
  Task|Agent)
    TASK_DESC=$(echo "$TOOL_INPUT" | jq -r '.description // ""' | head -c 200)
    # Generate a unique task ID for each subagent so they get separate rows in agent activity
    SUB_ID=$(echo "$TOOL_INPUT" | jq -r '.description // "subagent"' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 40)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$SUB_ID/status" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'status': 'completed', 'description': sys.argv[1][:150], 'hook': True}, ensure_ascii=False))
" "$TASK_DESC")" 2>/dev/null || true
    ;;
  Read|Glob|Grep)
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .pattern // .path // ""' | head -c 200)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': sys.argv[1] + ': ' + sys.argv[2][:150]}, ensure_ascii=False))
" "$TOOL_NAME" "$FILE_PATH")" 2>/dev/null || true
    ;;
  WebSearch)
    QUERY=$(echo "$TOOL_INPUT" | jq -r '.query // ""' | head -c 200)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': 'WebSearch: ' + sys.argv[1][:150]}, ensure_ascii=False))
" "$QUERY")" 2>/dev/null || true
    ;;
  WebFetch)
    URL=$(echo "$TOOL_INPUT" | jq -r '.url // ""' | head -c 200)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': 'WebFetch: ' + sys.argv[1][:150]}, ensure_ascii=False))
" "$URL")" 2>/dev/null || true
    ;;
  *)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$TASK_ID/progress" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'percent': -1, 'message': sys.argv[1]}, ensure_ascii=False))
" "$TOOL_NAME")" 2>/dev/null || true
    ;;
esac

exit 0
