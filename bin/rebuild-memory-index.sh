#!/usr/bin/env bash
set -euo pipefail

MEMORY_DIR="${1:-$HOME/.claude/projects/memory}"
INDEX="$MEMORY_DIR/MEMORY.md"

# Type to section name mapping
declare -A SECTIONS=(
  [architecture]="Architecture"
  [feature]="Features"
  [config]="Configuration"
  [bugfix]="Bug Fixes & Lessons"
  [lesson]="Bug Fixes & Lessons"
  [cross-project]="Cross-Project"
)

# Collect entries grouped by section
declare -A ENTRIES

for file in "$MEMORY_DIR"/*.md; do
  [ "$(basename "$file")" = "MEMORY.md" ] && continue

  fname=$(basename "$file")
  # Extract frontmatter fields
  name=$(sed -n '/^---$/,/^---$/{ /^name:/s/^name: *//p }' "$file")
  desc=$(sed -n '/^---$/,/^---$/{ /^description:/s/^description: *//p }' "$file")
  type=$(sed -n '/^---$/,/^---$/{ /^type:/s/^type: *//p }' "$file")

  section="${SECTIONS[$type]:-Other}"
  ENTRIES[$section]+="- [$fname]($fname) — $desc
"
done

# Write index
cat > "$INDEX" << 'HEADER'
# Claude Supervisor Project Memory

Each entry below links to a detail file. Read the linked file when you need specifics — do not rely on the summary alone.
HEADER

for section in "Architecture" "Features" "Configuration" "Bug Fixes & Lessons" "Cross-Project" "Other"; do
  if [ -n "${ENTRIES[$section]:-}" ]; then
    echo "" >> "$INDEX"
    echo "## $section" >> "$INDEX"
    echo "${ENTRIES[$section]}" >> "$INDEX"
  fi
done

echo "Index rebuilt: $(grep -c '^\- \[' "$INDEX") entries"
