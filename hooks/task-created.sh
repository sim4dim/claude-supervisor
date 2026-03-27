#!/usr/bin/env bash
# TaskCreated Hook — fires when Claude Code creates a new Task
# Logs the raw payload and publishes to MQTT so agent activity is tracked
#
# Exit codes:
#   0 = always (non-blocking)

set -euo pipefail

MQTT_HOST="${SUPERVISOR_MQTT_HOST:-localhost}"
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# Read full input from stdin
INPUT=$(cat)

# ─── Debug: append full raw input to log file ─────────────────────────────
echo "$INPUT" >> /tmp/task-created-debug.json

# ─── Extract task_id — try multiple paths ─────────────────────────────────
TASK_ID=$(echo "$INPUT" | jq -r '.task_id // .id // .input.task_id // ""' 2>/dev/null || true)

# ─── Extract description — try multiple paths ─────────────────────────────
DESCRIPTION=$(echo "$INPUT" | jq -r '.description // .input.description // .title // ""' 2>/dev/null || true)
if [[ -z "$DESCRIPTION" ]]; then
    # Fall back to the full input summary
    DESCRIPTION=$(echo "$INPUT" | jq -c '.' 2>/dev/null | head -c 150 || true)
fi

# ─── Derive a slug from the description ───────────────────────────────────
# Lowercase, replace non-alphanumeric runs with hyphens, truncate to 40 chars
SLUG=$(echo "$DESCRIPTION" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g' \
    | sed 's/--*/-/g' \
    | sed 's/^-//; s/-$//' \
    | head -c 40)

# If we have an explicit task_id, prefer it as the slug
if [[ -n "$TASK_ID" && "$TASK_ID" != "null" ]]; then
    SLUG=$(echo "$TASK_ID" \
        | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9]/-/g' \
        | sed 's/--*/-/g' \
        | head -c 40)
fi

# Fallback slug if both are empty
if [[ -z "$SLUG" ]]; then
    SLUG="task-$(date +%s)"
fi

# ─── Publish to MQTT via sv ───────────────────────────────────────────────
# sv pub publishes to supervisor/$PROJECT/$SV_TASK_ID/status
export SV_TASK_ID="$SLUG"
sv pub status started "$DESCRIPTION" 2>/dev/null || true

# Also publish directly to MQTT so the supervisor dashboard picks it up
mosquitto_pub -h "$MQTT_HOST" \
    -t "supervisor/$PROJECT/$SLUG/status" \
    -m "$(python3 -c "
import json, sys
print(json.dumps({'status': 'started', 'description': sys.argv[1][:150], 'hook': True, 'event': 'TaskCreated'}, ensure_ascii=False))
" "$DESCRIPTION")" 2>/dev/null || true

exit 0
