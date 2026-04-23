#!/bin/bash
# Sets up a project directory to use the Claude Code Supervisor.
# Usage: ./setup-project.sh /path/to/project [port] [role]
#   port defaults to 3847
#   role is an optional description of Claude's expertise for this project
#
# Safe to re-run: updates supervisor-managed sections while preserving user edits.
#
# Examples:
#   ./setup-project.sh $HOME/projects/hvac 3847 "HVAC automation engineer. Stack: Home Assistant, pyscript, Keen vents, GW1000 weather station"
#   ./setup-project.sh $HOME/projects/av-remote 3847 "AV/home theater integration engineer. Stack: Python, Denon AVR, Sony Bravia, IR control"

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$1"
PORT="${2:-3847}"
ROLE="${3:-}"

if [ -z "$PROJECT_DIR" ]; then
  echo "Usage: $0 /path/to/project [port] [role]"
  echo "  port defaults to 3847"
  echo "  role is an optional description of Claude's expertise for this project"
  exit 1
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: $PROJECT_DIR does not exist"
  exit 1
fi

# Copy hook scripts (ensure dirs are group-writable for multi-user setups)
mkdir -p "$PROJECT_DIR/.claude/hooks"
chmod g+w "$PROJECT_DIR/.claude" "$PROJECT_DIR/.claude/hooks" 2>/dev/null || true
cp --remove-destination "$SCRIPT_DIR/hooks/"*.sh "$PROJECT_DIR/.claude/hooks/"
chmod +x "$PROJECT_DIR/.claude/hooks/"*.sh 2>/dev/null || true
echo "Updated hook scripts in $PROJECT_DIR/.claude/hooks/"

# Deploy CLAUDE.md (supervisor-managed section with markers)
CLAUDE_MD_TEMPLATE="$SCRIPT_DIR/CLAUDE.md.template"
TARGET_CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"

if [ -f "$CLAUDE_MD_TEMPLATE" ]; then
  # Build role section
  if [ -n "$ROLE" ]; then
    ROLE_SECTION="## Role\n\n$ROLE"
  else
    ROLE_SECTION=""
  fi

  # Render template with role
  RENDERED=$(python3 -c "
import sys
with open('$CLAUDE_MD_TEMPLATE') as f:
    t = f.read()
role = '''$ROLE'''
section = '## Role\n\n' + role if role else ''
print(t.replace('{{ROLE}}', section))
")

  if [ -f "$TARGET_CLAUDE_MD" ]; then
    if grep -q "SUPERVISOR-START" "$TARGET_CLAUDE_MD"; then
      # Has markers — replace just the supervisor section, preserve everything else
      python3 - "$TARGET_CLAUDE_MD" <<PYSCRIPT
import re, sys

target = sys.argv[1]
with open(target) as f:
    content = f.read()

rendered = '''$RENDERED'''

# Replace everything between SUPERVISOR-START and SUPERVISOR-END (inclusive)
pattern = r'<!-- SUPERVISOR-START[^>]*-->.*?<!-- SUPERVISOR-END -->'
new_content = re.sub(pattern, rendered.strip(), content, count=1, flags=re.DOTALL)

with open(target, 'w') as f:
    f.write(new_content)

print("Updated supervisor section in CLAUDE.md (user edits preserved)")
PYSCRIPT
    elif grep -q "## Critical: You Are a Coordinator, Not a Worker" "$TARGET_CLAUDE_MD"; then
      # Old format without markers — migrate: replace old supervisor content with new marked version
      python3 - "$TARGET_CLAUDE_MD" <<PYSCRIPT
import re, sys

target = sys.argv[1]
with open(target) as f:
    content = f.read()

rendered = '''$RENDERED'''

# Find where old supervisor content starts (could be after --- or at start)
# Try to find the old supervisor block starting from "# Project Work Instructions"
old_start = content.find('# Project Work Instructions')
if old_start == -1:
    old_start = content.find('## Critical: You Are a Coordinator, Not a Worker')

if old_start > 0:
    # There's user content before the supervisor section — preserve it
    user_before = content[:old_start].rstrip()
    # Check if there's a --- separator
    if user_before.endswith('---'):
        user_before = user_before[:-3].rstrip()
    new_content = user_before + '\n\n---\n\n' + rendered.strip() + '\n'
else:
    # Supervisor content is at the start — just replace entirely
    new_content = rendered.strip() + '\n'

with open(target, 'w') as f:
    f.write(new_content)

print("Migrated CLAUDE.md to marker format (user edits preserved)")
PYSCRIPT
    else
      # No supervisor content at all — append after separator
      echo "Appending supervisor work instructions to existing CLAUDE.md..."
      printf '\n---\n\n' >> "$TARGET_CLAUDE_MD"
      echo "$RENDERED" >> "$TARGET_CLAUDE_MD"
    fi
  else
    echo "Creating CLAUDE.md with supervisor work instructions..."
    echo "$RENDERED" > "$TARGET_CLAUDE_MD"
  fi
fi

# Generate and merge settings.json
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"

python3 - "$SETTINGS_FILE" "$PORT" <<'PYSCRIPT'
import sys, json, os

settings_file = sys.argv[1]
port = sys.argv[2]

prefix = "" if port == "3847" else f"CLAUDE_SUPERVISOR_URL=http://localhost:{port} "
cmd = lambda script: f'{prefix}"$CLAUDE_PROJECT_DIR"/.claude/hooks/{script}'

hooks = {
    "hooks": {
        "PreToolUse": [
            {"matcher": "Bash|Task", "hooks": [{"type": "command", "command": cmd("pre-tool-use.sh")}]},
            {"matcher": "Write|Edit|NotebookEdit", "hooks": [{"type": "command", "command": cmd("pre-tool-use.sh")}]},
            {"matcher": "WebSearch|WebFetch", "hooks": [{"type": "command", "command": cmd("pre-tool-use.sh")}]},
            {"matcher": "mcp__.*", "hooks": [{"type": "command", "command": cmd("pre-tool-use.sh")}]},
        ],
        "PermissionRequest": [
            {"matcher": "*", "hooks": [{"type": "command", "command": cmd("permission-request.sh")}]},
        ],
        "PostToolUse": [
            {"matcher": "*", "hooks": [{"type": "command", "command": cmd("post-tool-use.sh")}]},
        ],
        "Notification": [
            {"matcher": "", "hooks": [{"type": "command", "command": cmd("notification.sh")}]},
        ],
        "Stop": [
            {"matcher": "", "hooks": [{"type": "command", "command": cmd("on-stop.sh")}]},
        ],
        "PreCompact": [
            {"matcher": "", "hooks": [{"type": "command", "command": cmd("pre-compact.sh")}]},
        ],
        "SessionStart": [
            {"matcher": "*", "hooks": [{"type": "command", "command": cmd("session-start.sh")}]},
        ],
        "StopFailure": [
            {"matcher": "", "hooks": [{"type": "command", "command": cmd("on-stop-failure.sh")}]},
        ],
        "PostCompact": [
            {"matcher": "", "hooks": [{"type": "command", "command": cmd("post-compact.sh")}]},
        ],
        "TaskCreated": [
            {"matcher": "*", "hooks": [{"type": "command", "command": cmd("task-created.sh")}]},
        ],
        # NOTE: statusline.sh and file-changed.sh do not correspond to standard Claude Code
        # hook events. statusline.sh renders rate-limit gauges for a custom CLI display;
        # file-changed.sh handles an editor-side file-watch event. Neither is wired here.
    }
}

# Merge into existing settings or create new
if os.path.exists(settings_file):
    with open(settings_file) as f:
        existing = json.load(f)
    existing["hooks"] = hooks["hooks"]
    result = existing
    action = "Merged hooks into existing"
else:
    result = hooks
    action = "Created"

with open(settings_file, "w") as f:
    json.dump(result, f, indent=2)
    f.write("\n")

print(f"{action} {settings_file}")
PYSCRIPT

# Optional: grant additional users read access
# for user in user1 user2; do
#   setfacl -R -m u:$user:rX "$PROJECT_DIR" || true
# done

# Optional: enable PII scrubbing via .mcp.json
if [ -t 0 ]; then
  printf "Enable PII scrubbing for this project? (y/N) "
  read -r PII_ANSWER
  if [[ "$PII_ANSWER" =~ ^[Yy]$ ]]; then
    MCP_FILE="$PROJECT_DIR/.mcp.json"
    if [ -f "$MCP_FILE" ]; then
      # Merge pii entry into existing .mcp.json
      python3 -c "
import json, sys
with open('$MCP_FILE') as f:
    mcp = json.load(f)
mcp.setdefault('mcpServers', {})['pii'] = {
    'command': 'node',
    'args': ['$SCRIPT_DIR/mcp-pii-server.js'],
    'env': {'PII_SESSION_ID': 'default'}
}
with open('$MCP_FILE', 'w') as f:
    json.dump(mcp, f, indent=2)
print('Updated $MCP_FILE with PII MCP server entry')
"
    else
      # Create fresh .mcp.json
      python3 -c "
import json
mcp = {'mcpServers': {'pii': {'command': 'node', 'args': ['$SCRIPT_DIR/mcp-pii-server.js'], 'env': {'PII_SESSION_ID': 'default'}}}}
with open('$MCP_FILE', 'w') as f:
    json.dump(mcp, f, indent=2)
print('Created $MCP_FILE with PII MCP server entry')
"
    fi
    echo "PII scrubbing enabled. Restart the Claude session to activate."
  fi
fi

echo ""
echo "Done! Project set up for supervisor on port $PORT"
echo "  Dashboard: http://localhost:$PORT"
echo ""
echo "To start the supervisor:"
echo "  SUPERVISOR_PORT=$PORT node $SCRIPT_DIR/server.js"