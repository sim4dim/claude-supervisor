#!/usr/bin/env bash
# PreCompact Hook — fires before context window compaction
# Saves uncommitted work, writes progress snapshot, and notifies the supervisor
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

INPUT=$(cat)

TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# ─── Notify supervisor server ─────────────────────────────────────────────

curl -s --max-time 5 \
    -X POST "${SUPERVISOR_URL}/api/hook/compact" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg trigger "$TRIGGER" \
        --arg session "$SESSION_ID" \
        --arg project "$PROJECT" \
        '{trigger: $trigger, session_id: $session, project: $project}'
    )" >/dev/null 2>&1 || true

# ─── Publish MQTT notification ────────────────────────────────────────────

mosquitto_pub -h "$MQTT_HOST" \
    -t "supervisor/$PROJECT/compaction" \
    -m "$(jq -n \
        --arg trigger "$TRIGGER" \
        --arg session "$SESSION_ID" \
        --arg project "$PROJECT" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{trigger: $trigger, session_id: $session, project: $project, timestamp: $timestamp}'
    )" 2>/dev/null || true

# ─── Write progress snapshot ──────────────────────────────────────────────

if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    SNAPSHOT="$CLAUDE_PROJECT_DIR/.claude/progress-snapshot.md"
    mkdir -p "$(dirname "$SNAPSHOT")"

    {
        echo "# Progress Snapshot"
        echo ""
        echo "Auto-generated at $(date -u +%Y-%m-%dT%H:%M:%SZ) before context compaction."
        echo "**Read this file immediately after compaction to recover working state.**"
        echo ""

        # Git state
        echo "## Uncommitted Changes"
        echo ""
        cd "$CLAUDE_PROJECT_DIR"
        if git diff --quiet HEAD 2>/dev/null && [[ -z "$(git ls-files --others --exclude-standard 2>/dev/null)" ]]; then
            echo "None (working tree clean)"
        else
            echo '```'
            git status --short 2>/dev/null || echo "(could not read git status)"
            echo '```'
        fi
        echo ""

        # Recent commits
        echo "## Recent Commits"
        echo ""
        echo '```'
        git log --oneline -10 2>/dev/null || echo "(no git history)"
        echo '```'
        echo ""

        # Diff summary (what was being worked on)
        DIFF_STAT=$(git diff --stat HEAD 2>/dev/null || true)
        if [[ -n "$DIFF_STAT" ]]; then
            echo "## Uncommitted Diff Summary"
            echo ""
            echo '```'
            echo "$DIFF_STAT"
            echo '```'
            echo ""
        fi

        # Active agent tasks from supervisor API
        AGENT_DATA=$(curl -s --max-time 3 -H "$(_sv_auth_header)" "${SUPERVISOR_URL}/api/state" 2>/dev/null || echo "{}")
        AGENT_MSGS=$(echo "$AGENT_DATA" | jq -r '.agentMessages // []' 2>/dev/null)
        if [[ -n "$AGENT_MSGS" ]] && [[ "$AGENT_MSGS" != "[]" ]] && [[ "$AGENT_MSGS" != "null" ]]; then
            echo "## Recent Agent Activity"
            echo ""
            # Get messages for this project, last 20
            echo "$AGENT_MSGS" | jq -r --arg p "$PROJECT" '
                [.[] | select(.project == $p)] | .[-20:] | .[] |
                "- **\(.taskId // "agent")** [\(.msgType // "?")] \(.payload.message // .payload.description // .payload.status // .payload.finding // "" | .[:120])"
            ' 2>/dev/null || true
            echo ""
        fi

        # Pending approvals
        PENDING=$(echo "$AGENT_DATA" | jq -r '.pending // []' 2>/dev/null)
        if [[ -n "$PENDING" ]] && [[ "$PENDING" != "[]" ]] && [[ "$PENDING" != "null" ]]; then
            echo "## Pending Approvals"
            echo ""
            echo "$PENDING" | jq -r --arg p "$PROJECT" '
                [.[] | select(.project == $p)] | .[] |
                "- \(.tool // "?") — \(.summary // "" | .[:150])"
            ' 2>/dev/null || true
            echo ""
        fi

    } > "$SNAPSHOT" 2>/dev/null || true

    # ─── Extract transcript excerpt ──────────────────────────────────────────
    EXCERPT="$CLAUDE_PROJECT_DIR/.claude/transcript-excerpt.md"
    if [[ -n "$SESSION_ID" ]] && [[ "$SESSION_ID" != "unknown" ]]; then
        python3 "$HOME/.local/bin/extract-transcript" \
            "$SESSION_ID" "$CLAUDE_PROJECT_DIR" \
            > "$EXCERPT" 2>/dev/null || true
        # Remove if empty (script produced no output)
        [[ -s "$EXCERPT" ]] || rm -f "$EXCERPT"
    fi
fi

# ─── Auto-commit uncommitted work ─────────────────────────────────────────

if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] && [[ -d "$CLAUDE_PROJECT_DIR/.git" ]]; then
    cd "$CLAUDE_PROJECT_DIR"

    # Check if there are any changes to save
    if ! git diff --quiet HEAD 2>/dev/null || [[ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]]; then
        git add -A 2>/dev/null || true
        git commit -m "Auto-save before context compaction ($TRIGGER)

Automatic commit triggered by PreCompact hook to preserve
uncommitted work before context window compaction.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" 2>/dev/null || true
    fi
fi

exit 0
