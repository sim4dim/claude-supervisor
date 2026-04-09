---
name: feasibility
description: Run a Moltke adversarial feasibility check on a plan or hardware/software decision. Use when user says "is this feasible", "will this work", "check compatibility", "before we buy/order", "evaluate this plan", or "can we use X with Y". Runs inline (planner + adversarial reviewer subagents) unless --project <other-project> is given, in which case it routes through the coordinator.
argument-hint: "[proposal or plan to evaluate]"
effort: max
---

The user wants to run a feasibility check on: $ARGUMENTS

**Step 1: Determine mode**

Parse `$ARGUMENTS` for a `--project <name>` flag.

- Extract the project flag if present: `TARGET_PROJECT=$(echo "$ARGUMENTS" | grep -oP '(?<=--project )\S+')`
- Determine current project: `CURRENT_PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")`
- If `--project` was given and differs from the current project, use **cross-project mode** (Step 5).
- Otherwise, use **inline mode** (Steps 2–4).

Strip `--project <name>` from the proposal text before passing it to agents:
`PROPOSAL=$(echo "$ARGUMENTS" | sed 's/--project [^ ]*//' | xargs)`

---

**Inline Mode (same project)**

**Step 2: Set up a chat room**

```bash
ROOM="feasibility-$(date +%s)"
sv chat init "$ROOM"
```

Tell the user: "Running inline feasibility check. Spawning planner and adversarial reviewer..."

**Step 3: Spawn the Planner subagent**

Spawn a `planner` subagent with this prompt (substitute `$ROOM` and `$PROPOSAL`):

> Research the following proposal thoroughly. Read relevant code, check dependencies, consider architecture implications. Then write a detailed implementation plan covering: scope, approach, files to modify, risks, effort estimate, and dependencies.
>
> Proposal: `$PROPOSAL`
>
> When done, post your full plan to the chat room:
> `sv chat post $ROOM '[PLAN] <your full plan here>'`

Wait for the planner subagent to complete before proceeding.

**Step 4: Spawn the Moltke (adversarial reviewer) subagent**

Spawn a `moltke` subagent with this prompt (substitute `$ROOM`):

> Read the plan that was posted to the chat room:
> `sv chat history $ROOM`
>
> You are an adversarial reviewer. Your job is to war-game this plan and find blockers, incompatibilities, and incorrect assumptions BEFORE resources are committed.
>
> Your review MUST include these sections:
>
> ### BLOCKERS
> Showstoppers that must be resolved before proceeding.
>
> ### RISKS
> Things that could go wrong during or after implementation.
>
> ### UNVERIFIED ASSUMPTIONS
> Claims in the plan you cannot verify from code or docs. Mark each UNVERIFIED.
>
> ### VALIDATED
> Parts of the plan that check out — cite evidence.
>
> ### VERDICT: GO / NO-GO / CONDITIONAL
> One of these three, with a one-sentence justification.
>
> Cite specific evidence for every claim. Do not guess. Do not soften bad news.
>
> When done, post your review:
> `sv chat post $ROOM '[MOLTKE REVIEW] <your full review here>'`

Wait for the moltke subagent to complete.

**After both subagents complete:**

1. Read the full chat history: `sv chat history $ROOM`
2. Present the plan and review to the user in full.
3. Highlight the **VERDICT** (GO / NO-GO / CONDITIONAL) prominently.
4. If there are BLOCKERS, list them clearly at the top of your summary.
5. Publish the verdict as a one-line discovery so it is captured in Pensive memory:
   ```bash
   sv pub discovery "VERDICT [proposal-topic]: GO|NO-GO|CONDITIONAL — <one-sentence justification>"
   ```
   Use the actual proposal topic in place of "proposal-topic" and the Moltke verdict in place of the placeholder.
6. Clean up: `sv chat clear $ROOM`

---

**Step 5: Cross-project mode**

If `--project <other>` was specified and differs from the current project:

```bash
sv request "$PROPOSAL" --project "$TARGET_PROJECT" --type feasibility --timeout 600
```

After running that command, tell the user:

- The feasibility request has been submitted and will appear in the **Coordinator panel** in the supervisor UI.
- They must go to the Coordinator panel and click **Dispatch** to route it to the planner and adversarial reviewer agents in that project.
- The result will appear in the coordinator panel when the agents complete their analysis.
