#!/usr/bin/env bash
# Statusline hook — displays rate limit gauges from Claude Code 2.1.80+
# Receives JSON on stdin with a rate_limits field.
# Output is shown in the Claude Code statusline.

set -euo pipefail

input=$(cat)

# Parse rate_limits using jq (preferred) or python3 fallback
if command -v jq &>/dev/null; then
    pct_5h=$(echo "$input"  | jq -r '.rate_limits."5h".used_percentage  // empty' 2>/dev/null)
    pct_7d=$(echo "$input"  | jq -r '.rate_limits."7d".used_percentage  // empty' 2>/dev/null)
    resets_5h=$(echo "$input" | jq -r '.rate_limits."5h".resets_at // empty' 2>/dev/null)
    resets_7d=$(echo "$input" | jq -r '.rate_limits."7d".resets_at // empty' 2>/dev/null)
else
    pct_5h=$(echo "$input"  | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = d.get('rate_limits', {}).get('5h', {}).get('used_percentage')
print(v if v is not None else '')
" 2>/dev/null)
    pct_7d=$(echo "$input"  | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = d.get('rate_limits', {}).get('7d', {}).get('used_percentage')
print(v if v is not None else '')
" 2>/dev/null)
fi

# If neither window has data, output nothing (don't clutter statusline)
if [[ -z "$pct_5h" && -z "$pct_7d" ]]; then
    exit 0
fi

# Round to integers
pct_5h=${pct_5h%.*}   # strip decimal
pct_7d=${pct_7d%.*}

# Threshold indicators
indicator() {
    local pct=$1
    if   (( pct >= 95 )); then echo "🔴"
    elif (( pct >= 80 )); then echo "🟡"
    else                       echo "⚡"
    fi
}

parts=()

if [[ -n "$pct_5h" ]]; then
    icon=$(indicator "$pct_5h")
    parts+=("${icon} ${pct_5h}% (5h)")
fi

if [[ -n "$pct_7d" ]]; then
    icon=$(indicator "$pct_7d")
    parts+=("${icon} ${pct_7d}% (7d)")
fi

# Join with " | " separator
if (( ${#parts[@]} == 2 )); then
    echo "${parts[0]} | ${parts[1]}"
else
    echo "${parts[0]}"
fi
