#!/bin/bash
# FileChanged hook — hot-reload policy and notify on config file changes

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')
EVENT=$(echo "$INPUT" | jq -r '.event // "change"')
FILENAME=$(basename "$FILE_PATH")

# Auth token for supervisor API
_sv_auth_header() {
  local token_file="$HOME/.claude/.supervisor-hook-token"
  if [ -f "$token_file" ]; then
    echo "Authorization: Bearer $(cat "$token_file")"
  fi
}

case "$FILENAME" in
  supervisor-policy.md)
    curl -s -X POST http://localhost:3847/api/reload-policy \
      -H "Content-Type: application/json" \
      -H "$(_sv_auth_header)" > /dev/null 2>&1
    ;;
  settings.json)
    sv pub discovery "Settings changed: $EVENT"
    ;;
  dynamic-approvals.sh)
    sv pub discovery "Dynamic approvals updated"
    ;;
esac

exit 0
