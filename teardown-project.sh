#!/bin/bash
# Removes Claude Code Supervisor hooks from a project directory.
# Usage: ./teardown-project.sh /path/to/project
#
# This reverses what setup-project.sh does:
#   - Removes hook scripts from .claude/hooks/
#   - Removes the hooks section from .claude/settings.json (preserves other settings)
#   - Removes supervisor work instructions from CLAUDE.md (preserves other content)

set -e

PROJECT_DIR="$1"

if [ -z "$PROJECT_DIR" ]; then
  echo "Usage: $0 /path/to/project"
  exit 1
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: $PROJECT_DIR does not exist"
  exit 1
fi

PROJECT_NAME=$(basename "$PROJECT_DIR")

# ─── Remove hook scripts ────────────────────────────────────────────────────

HOOKS_DIR="$PROJECT_DIR/.claude/hooks"
if [ -d "$HOOKS_DIR" ]; then
  for f in pre-tool-use.sh permission-request.sh post-tool-use.sh notification.sh on-stop.sh pre-compact.sh session-start.sh on-stop-failure.sh post-compact.sh task-created.sh statusline.sh dynamic-approvals.sh file-changed.sh; do
    if [ -f "$HOOKS_DIR/$f" ]; then
      rm "$HOOKS_DIR/$f"
    fi
  done

  # Remove hooks dir if empty
  rmdir "$HOOKS_DIR" 2>/dev/null || true
  echo "[$PROJECT_NAME] Removed hook scripts"
else
  echo "[$PROJECT_NAME] No hooks directory found, skipping"
fi

# ─── Remove hooks from settings.json ────────────────────────────────────────

SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  python3 -c "
import json, sys

with open('$SETTINGS_FILE') as f:
    settings = json.load(f)

if 'hooks' in settings:
    del settings['hooks']

    if settings:
        # Other settings remain — write back without hooks
        with open('$SETTINGS_FILE', 'w') as f:
            json.dump(settings, f, indent=2)
            f.write('\n')
        print('[$PROJECT_NAME] Removed hooks from settings.json (other settings preserved)')
    else:
        # Nothing left — remove the file
        import os
        os.remove('$SETTINGS_FILE')
        print('[$PROJECT_NAME] Removed empty settings.json')
else:
    print('[$PROJECT_NAME] No hooks in settings.json, skipping')
"

  # Remove .claude dir if empty
  rmdir "$PROJECT_DIR/.claude" 2>/dev/null || true
else
  echo "[$PROJECT_NAME] No settings.json found, skipping"
fi

# ─── Remove supervisor instructions from CLAUDE.md ──────────────────────────

CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "SUPERVISOR-START" "$CLAUDE_MD"; then
    # New format: remove content between <!-- SUPERVISOR-START --> and <!-- SUPERVISOR-END -->
    python3 -c "
import re, os

with open('$CLAUDE_MD') as f:
    content = f.read()

# Remove everything between SUPERVISOR-START and SUPERVISOR-END markers (inclusive)
pattern = r'\n?---\n+<!-- SUPERVISOR-START[^>]*-->.*?<!-- SUPERVISOR-END -->\n?'
cleaned = re.sub(pattern, '', content, count=1, flags=re.DOTALL)

# Also handle case where there's no leading --- (supervisor content at start of file)
if cleaned == content:
    pattern = r'<!-- SUPERVISOR-START[^>]*-->.*?<!-- SUPERVISOR-END -->\n?'
    cleaned = re.sub(pattern, '', content, count=1, flags=re.DOTALL)

if cleaned != content:
    cleaned = cleaned.rstrip()
    if cleaned:
        cleaned += '\n'
        with open('$CLAUDE_MD', 'w') as f:
            f.write(cleaned)
        print('[$PROJECT_NAME] Removed supervisor section from CLAUDE.md (preserved existing content)')
    else:
        os.remove('$CLAUDE_MD')
        print('[$PROJECT_NAME] Removed CLAUDE.md (was entirely supervisor template)')
else:
    print('[$PROJECT_NAME] Could not isolate supervisor section in CLAUDE.md, leaving as-is')
"
  elif grep -q "## Critical: You Are a Coordinator, Not a Worker" "$CLAUDE_MD"; then
    # Old format without markers
    python3 -c "
import re, os

with open('$CLAUDE_MD') as f:
    content = f.read()

# The supervisor template starts with '# Project Work Instructions' or the
# separator '---' followed by the template. Try both patterns.

# Pattern 1: Entire file is the supervisor template (starts with # Project Work Instructions)
if content.strip().startswith('# Project Work Instructions'):
    os.remove('$CLAUDE_MD')
    print('[$PROJECT_NAME] Removed CLAUDE.md (was entirely supervisor template)')
else:
    # Pattern 2: Supervisor template was appended after a --- separator
    # Remove from the --- line before the template to end of file
    pattern = r'\n---\n+# Project Work Instructions.*'
    cleaned = re.sub(pattern, '', content, flags=re.DOTALL)

    if cleaned != content:
        cleaned = cleaned.rstrip() + '\n'
        with open('$CLAUDE_MD', 'w') as f:
            f.write(cleaned)
        print('[$PROJECT_NAME] Removed supervisor section from CLAUDE.md (preserved existing content)')
    else:
        print('[$PROJECT_NAME] Could not isolate supervisor section in CLAUDE.md, leaving as-is')
"
  else
    echo "[$PROJECT_NAME] CLAUDE.md has no supervisor instructions, skipping"
  fi
else
  echo "[$PROJECT_NAME] No CLAUDE.md found, skipping"
fi

echo ""
echo "Done! Supervisor removed from $PROJECT_NAME"
echo "Claude Code will use its normal permission flow for this project."
