---
name: subagent-communication
description: Use when an agent needs to publish status via sv pub, use chat rooms for multi-agent coordination, exchange retained data between agents, or make cross-project coordinator requests via the sv helper. Reference for all sv MQTT commands.
user-invocable: false
effort: high
---

# Subagent Communication via sv

The `sv` helper is on PATH. All `sv` commands are auto-approved — no supervisor delay.

## Environment Variables

Set at the start of your task:

```bash
export SV_TASK_ID="fix-auth-bug"      # kebab-case identifier; used by sv pub
export SV_AGENT_NAME="architect"       # your name in chat messages (defaults to SV_TASK_ID)
export SV_PROJECT="my-project"         # override project name (defaults to basename of CLAUDE_PROJECT_DIR)
export SV_CHAT_ROOM="design-review"   # set only if your task prompt mentions a chat room
```

## Status Reporting (sv pub)

Report at start, during, and end of every task:

```bash
sv pub status started "Patching authentication middleware"
sv pub progress 50 "Found 3 affected files, patching now"
sv pub discovery "Auth tokens expire after 1h, not 24h as documented"
sv pub status completed
```

- Progress is 0-100.
- Use `discovery` for facts other agents or the supervisor should know.

## Chat Rooms (sv chat)

Use when your task prompt mentions a room, or when multiple agents need to coordinate.

### Joining a room from your task prompt

```bash
export SV_CHAT_ROOM="design-review"
sv chat history "$SV_CHAT_ROOM"   # read everything posted so far
sv chat post "$SV_CHAT_ROOM" "[$SV_TASK_ID] Recommending approach A — fewer DB queries"
```

### Back-and-forth debate between agents

```bash
sv chat init review                 # moderator initializes the room
sv chat post review "PROPOSAL: Eliminate dual control path"   # agent 1 posts (returns seq)
sv chat wait review 0               # agent 2 blocks until seq >= 0, then reads
sv chat post review "COUNTER: Need backward compat for 2 weeks"
sv chat read review                 # read latest message at any time
sv chat clear review                # clean up when done
```

`sv chat wait <room> N` blocks until a message with seq >= N exists, then prints it.

## Retained Data Exchange (sv retain / sv read / sv clear)

Hand structured findings from one agent to another asynchronously:

```bash
# Agent A: publish findings
sv retain "supervisor/myproject/agent-a/findings" '{"files":["auth.js","db.js"],"issue":"token expiry mismatch"}'

# Agent B: read them (blocks up to 30s)
sv read "supervisor/myproject/agent-a/findings"

# Clean up after both agents are done
sv clear "supervisor/myproject/agent-a/findings"
```

Use consistent topic naming: `supervisor/<project>/<agent>/<key>`.

## Cross-Project Coordinator (sv request / sv respond)

Ask another project's running session for information or action:

```bash
sv request "Check if getUserById returns null or throws on missing user" \
  --project auth-service \
  --type research
# Prints a request-id

result=$(sv request wait <request-id> 120)
echo "$result"   # JSON with findings
```

### Request types
- `research` — investigate and report back (read-only)
- `action` — make changes in the target project
- `review` — review code or approach and give feedback

### Flags
- `--project <name>` — target project
- `--type <type>` — request type (default: research)
- `--context <text>` — additional context for the handler
- `--timeout <secs>` — timeout before cancellation (default: 300)

### Responding to a coordinator request

If a COORDINATOR REQUEST prompt appears in your session:

```bash
sv respond <request-id> "getUserById returns null on missing user (line 45 of src/users.js)"
```
