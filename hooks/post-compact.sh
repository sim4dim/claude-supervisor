#!/usr/bin/env bash
# PostCompact Hook — fires after context window compaction completes
# Signals that recovery is needed so the session can re-orient itself
set -euo pipefail

PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
export SV_PROJECT="${SV_PROJECT:-$PROJECT}"

# ─── Log to compaction log ─────────────────────────────────────────────────

if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    LOG_DIR="$CLAUDE_PROJECT_DIR/logs"
    mkdir -p "$LOG_DIR"
    echo "POST-COMPACT: $(date -u +%Y-%m-%dT%H:%M:%SZ) project=$PROJECT" >> "$LOG_DIR/compaction.log"
fi

# ─── Publish MQTT alert ────────────────────────────────────────────────────

sv pub alert compaction-complete "Context was compacted, session recovering" 2>/dev/null || true

exit 0
