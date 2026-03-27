#!/usr/bin/env bash
# StatusLine hook — receives JSON from Claude Code after every assistant message.
# Posts usage data to supervisor server, then outputs status text for the terminal.

INPUT=$(cat)

# Post usage data to supervisor in background (don't block the status line)
SUPERVISOR_URL="${CLAUDE_SUPERVISOR_URL:-http://localhost:3847}"
curl -s --max-time 2 -X POST "${SUPERVISOR_URL}/api/hook/usage" \
  -H "Content-Type: application/json" \
  -d "$INPUT" >/dev/null 2>&1 &

# Output status line text for the terminal
# Extract key metrics from JSON
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // .model.id // "?"')
CTX_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // "?"')
TOTAL_IN=$(echo "$INPUT" | jq -r '.context_window.total_input_tokens // 0')
TOTAL_OUT=$(echo "$INPUT" | jq -r '.context_window.total_output_tokens // 0')

# Format token counts (e.g., 150234 → 150K)
format_tokens() {
  local n=$1
  if [ "$n" -ge 1000000 ]; then
    printf "%.1fM" "$(echo "$n / 1000000" | bc -l)"
  elif [ "$n" -ge 1000 ]; then
    printf "%.0fK" "$(echo "$n / 1000" | bc -l)"
  else
    printf "%d" "$n"
  fi
}

IN_FMT=$(format_tokens "$TOTAL_IN")
OUT_FMT=$(format_tokens "$TOTAL_OUT")

printf '\033[01;34m%s\033[00m ctx:%s%% %s↓%s↑' "$MODEL" "$CTX_PCT" "$IN_FMT" "$OUT_FMT"
