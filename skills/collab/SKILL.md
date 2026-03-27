---
name: collab
description: Start a multi-agent collaboration between projects using a shared chat room. Use when user says "collab", "collaborate with", "negotiate with", "work with X project on", or needs multiple project agents to discuss and align.
argument-hint: "<project1> <project2> \"<topic or goal>\""
effort: high
---

# Multi-Agent Cross-Project Collaboration

Initiate a structured 3-round discussion between two project agents on a shared topic.

**Arguments:** `$ARGUMENTS` — two project names and a quoted topic/goal.
Example: `auth-service api-gateway "align on JWT token expiry handling"`

---

## Steps

### 1. Parse arguments

Extract the two project names and topic from `$ARGUMENTS`. The topic is typically the last argument and may be quoted. If the arguments are ambiguous, ask the user to clarify before proceeding.

### 2. Generate a room name

Create a short slug from the first word(s) of the topic (lowercase, hyphens, max 20 chars), then append a Unix timestamp:

```bash
TOPIC="<extracted topic>"
PROJECT1="<first project name>"
PROJECT2="<second project name>"
SLUG=$(echo "$TOPIC" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-20 | sed 's/-$//')
ROOM="collab-${SLUG}-$(date +%s)"
echo "Room: $ROOM"
```

### 3. Initialize the chat room

```bash
sv chat init "$ROOM" --project shared
```

### 4. Dispatch coordinator requests to both projects

Send a request to each project with identical context. Both requests run concurrently — capture their request IDs:

INSTRUCTIONS1=$(cat <<EOF
Collaborate on: $TOPIC. Chat room: $ROOM. You are Agent 1 of 2. Follow this 3-round protocol exactly:

Round 1 — Post your current approach or state regarding the topic:
  sv chat post "$ROOM" "[Round 1] <your current approach>"

Round 2 — Read the full history, then respond with agreements or disagreements:
  sv chat history "$ROOM"
  sv chat post "$ROOM" "[Round 2] <your response to the other agent>"

Round 3 — Propose a final aligned solution. If you agree with the other agent, prefix your message with CONSENSUS::
  sv chat post "$ROOM" "[Round 3] CONSENSUS: <agreed solution>"
  # or if disagreeing:
  sv chat post "$ROOM" "[Round 3] POSITION: <your final position>"

Wait ~10 seconds between rounds to allow the other agent to post.
EOF
)
REQ1=$(sv request "$INSTRUCTIONS1" --project "$PROJECT1" --type research --timeout 300 --env SV_PROJECT=shared)

INSTRUCTIONS2=$(cat <<EOF
Collaborate on: $TOPIC. Chat room: $ROOM. You are Agent 2 of 2. Follow this 3-round protocol exactly:

Round 1 — Post your current approach or state regarding the topic:
  sv chat post "$ROOM" "[Round 1] <your current approach>"

Round 2 — Read the full history, then respond with agreements or disagreements:
  sv chat history "$ROOM"
  sv chat post "$ROOM" "[Round 2] <your response to the other agent>"

Round 3 — Propose a final aligned solution. If you agree with the other agent, prefix your message with CONSENSUS::
  sv chat post "$ROOM" "[Round 3] CONSENSUS: <agreed solution>"
  # or if disagreeing:
  sv chat post "$ROOM" "[Round 3] POSITION: <your final position>"

Wait ~10 seconds between rounds to allow the other agent to post.
EOF
)
REQ2=$(sv request "$INSTRUCTIONS2" --project "$PROJECT2" --type research --timeout 300 --env SV_PROJECT=shared)

echo "Request to $PROJECT1: $REQ1"
echo "Request to $PROJECT2: $REQ2"
```

Tell the user: "Coordinator requests sent to both projects. Each needs to be dispatched from the Supervisor web UI (or by the target project's owner)."

This is a request, not a command — the target project owners decide when and whether to participate. If a session is not running or the owner hasn't dispatched the request, the agent will not respond.

### 5. Monitor the chat room

Tell the user: "Waiting for both projects to be dispatched and respond... check the Supervisor UI to approve pending requests."

Poll every 15 seconds for up to 5 minutes. Stop early when both agents have posted a Round 3 message:

```bash
DEADLINE=$(($(date +%s) + 300))
DONE=false

while [ $(date +%s) -lt $DEADLINE ]; do
  sleep 15
  HISTORY=$(sv chat history --project shared "$ROOM" 2>/dev/null)
  echo "--- Chat snapshot $(date '+%H:%M:%S') ---"
  echo "$HISTORY"

  R3_COUNT=$(echo "$HISTORY" | grep -c '\[Round 3\]' || true)
  if [ "$R3_COUNT" -ge 2 ]; then
    DONE=true
    break
  fi
done
```

The web UI shows chat messages live via MQTT — the user can spectate the discussion in real time without waiting.

### 6. Summarize the outcome

After the loop, read the final history and report:

```bash
FINAL=$(sv chat history --project shared "$ROOM" 2>/dev/null)
CONSENSUS_COUNT=$(echo "$FINAL" | grep -c 'CONSENSUS:' || true)
```

- If `CONSENSUS_COUNT >= 2`: both agents agreed — extract and present the consensus solution.
- If `CONSENSUS_COUNT == 1`: partial agreement — present both Round 3 positions and note the gap.
- If `CONSENSUS_COUNT == 0` but both posted: no agreement — present both positions and escalate to the user for a decision.
- If `$DONE` is still `false` after the loop: check which projects posted Round 3 and which didn't. Report specifically — e.g. "$PROJECT1 did not respond — check the Supervisor UI to see if its request was dispatched." Suggest the user verify that the target session is running and the request appears in the coordinator panel.

### 7. Clean up

```bash
sv chat clear --project shared "$ROOM"
```

---

## Important notes

- Both target project sessions must be running before invoking this skill, and their owners must dispatch the coordinator requests via the Supervisor web UI. If a request is never dispatched, it will time out silently.
- The initiating agent (you) monitors and summarizes but does not participate in the chat rounds.
- Room names are unique per invocation via the timestamp suffix — parallel collabs on the same topic are safe.
