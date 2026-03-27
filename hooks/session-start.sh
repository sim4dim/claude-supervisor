#!/bin/bash
# SessionStart hook — injects progress snapshot into new session context
# Stdout from this hook is injected as context that Claude sees.
# Fires on: startup, resume, clear, compact

HANDOFF="$CLAUDE_PROJECT_DIR/.claude/session-handoff.md"

if [ -f "$HANDOFF" ]; then
  # Check if handoff is less than 48 hours old (2880 minutes)
  if [ "$(find "$HANDOFF" -mmin -2880 2>/dev/null)" ]; then
    echo "=== Session Handoff from Previous Session ==="
    echo ""
    cat "$HANDOFF"
    echo ""
    echo "=== End Handoff ==="
    echo ""
  fi
fi

SNAPSHOT="$CLAUDE_PROJECT_DIR/.claude/progress-snapshot.md"

if [ -f "$SNAPSHOT" ]; then
  # Check if snapshot is less than 24 hours old
  if [ "$(find "$SNAPSHOT" -mmin -1440 2>/dev/null)" ]; then
    echo "=== Previous Session Snapshot ==="
    echo ""
    cat "$SNAPSHOT"
    echo ""
    echo "=== End Snapshot ==="
    echo ""
    echo "Resume the previous work based on this snapshot. Summarize what was in progress and ask the user if they want to continue or start something new."
  fi
fi

# ─── Transcript excerpt (visible conversation before compaction) ─────────
EXCERPT="$CLAUDE_PROJECT_DIR/.claude/transcript-excerpt.md"
if [ -f "$EXCERPT" ]; then
  # Check if excerpt is less than 24 hours old
  if [ "$(find "$EXCERPT" -mmin -1440 2>/dev/null)" ]; then
    echo "=== Recent Conversation Before Compaction ==="
    echo ""
    cat "$EXCERPT"
    echo ""
    echo "=== End Conversation Excerpt ==="
    echo ""
    echo "The above is the visible conversation from before compaction. Use it to maintain continuity. Extract key decisions as a mental discussion trail (trigger → investigation → options → decision → outcome) before continuing work."
  fi
fi
