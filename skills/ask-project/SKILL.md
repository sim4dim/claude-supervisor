---
name: ask-project
description: Ask another project's running Claude session a question. Use when user says "ask project X", "check with X project", "ask-project", or needs info from another running session.
argument-hint: "<project-name> \"<your question>\""
effort: medium
---

Parse `$ARGUMENTS` to extract the project name (first word) and the question (remaining text, stripping any surrounding quotes).

Spawn a subagent to send the request and wait for the response:

```bash
export SV_TASK_ID="ask-project"
PROJECT="<first word from $ARGUMENTS>"
QUESTION="<rest of $ARGUMENTS>"

sv pub status started "Asking $PROJECT: $QUESTION"

REQUEST_ID=$(sv request "$QUESTION" --project "$PROJECT" --type research --timeout 300)
echo "Request ID: $REQUEST_ID"
```

Tell the user: "Coordinator request sent to project $PROJECT. It needs to be dispatched from the Supervisor web UI (or by the target project's owner)."

Then wait for the response:

```bash
echo "Waiting for response from $PROJECT... dispatch it from the Supervisor UI if you haven't already."
RESULT=$(sv request wait "$REQUEST_ID" 300)
echo "Response: $RESULT"

sv pub status completed
```

Present the response to the user in plain text.

If the result indicates a timeout, tell the user: "The request wasn't dispatched or $PROJECT didn't respond in time. Check the Supervisor UI to see if the request is still pending."

If the result indicates no session found, tell the user: "The $PROJECT session does not appear to be running. Start it and try again."
