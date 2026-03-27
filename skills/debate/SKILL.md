---
name: debate
description: Start a structured debate with specialized expert personas (not just PRO/CON). Triggers: "debate this", "should we X or Y", "pros and cons of", "argue both sides", "what are the tradeoffs", "inline debate"
user-invocable: true
disable-model-invocation: false
argument-hint: "[topic or decision to debate] [--debaters \"persona-a,persona-b\"] [--project <other-project>] [--auto]"
effort: max
---

The user wants to run a structured debate on: $ARGUMENTS

**Step 0: Determine mode and parse flags**

Parse `$ARGUMENTS` for the following flags:

1. `--project <name>` flag — if present and the named project differs from the current project, skip to **Cross-project mode** (Step 8).
2. `--debaters "persona-a,persona-b"` flag — if present, extract the two comma-separated persona names. Strip this flag from the topic string before proceeding. Store them as `$USER_PERSONA_A` and `$USER_PERSONA_B`.
3. `--auto` flag — if present, set `$AUTO_MODE=true`. This skips the persona approval gate in Step 1.5 and proceeds directly to Round 1. Useful for cross-project and unattended debates. Strip this flag from the topic string.

After stripping all flags, the remaining text is the **debate topic**.

Current project: `$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")`

---

## Inline Debate (same-project, common case)

**Step 1: Create the chat room**

```bash
ROOM="debate-$(date +%s)"
sv chat init "$ROOM"
echo "Debate room: $ROOM"
```

Tell the user the debate is starting and share the room name so they can follow along with `sv chat history $ROOM`.

**Step 1.5: Assign debater personas**

Before spawning any debaters, assign the two expert personas who will argue this topic. Their analytical lens — not just their position — should shape how they argue.

**If `--debaters` was provided in Step 0:** Use `$USER_PERSONA_A` and `$USER_PERSONA_B` as the persona names. Write a 1-sentence expertise description for each based on the name. Assign Persona A to the affirmative position and Persona B to the skeptical position.

**If no `--debaters` flag:** Analyze the debate topic and choose two genuinely different expert personas — complementary but opposing analytical frameworks. Do NOT default to generic "PRO" and "CON". Think about what real-world domain experts would bring distinct and clashing lenses to this topic. Examples of how to think about this (illustrative only — derive appropriate ones from the actual topic):

- Architecture debate → "Scalability Architect" vs "Simplicity Advocate"
- Investment debate → "Fundamentals Analyst" vs "Macro/Sentiment Analyst"
- Hiring decision → "Team Lead (delivery focus)" vs "Org Strategist (long-term fit)"
- Policy debate → "Rights/Liberty Advocate" vs "Collective Safety Advocate"
- Technology choice → "Ecosystem/Community Champion" vs "Technical Purity Engineer"

Choose persona names and write a 1-sentence expertise description for each. Assign one to the affirmative side and one to the skeptical side.

Store as:
- `$PERSONA_A_NAME` — name of the affirmative persona
- `$PERSONA_A_DESC` — 1-sentence expertise description
- `$PERSONA_B_NAME` — name of the skeptical persona
- `$PERSONA_B_DESC` — 1-sentence expertise description

**If `$AUTO_MODE` is NOT true**, present the personas to the user and ask for approval before continuing:

Show the user a message in this format:

> **Proposed debate personas:**
>
> - **Persona A (Affirmative):** $PERSONA_A_NAME — $PERSONA_A_DESC
> - **Persona B (Skeptical):** $PERSONA_B_NAME — $PERSONA_B_DESC
>
> Approve these personas, or suggest changes?

Wait for the user's response. Then:

- If the user approves (e.g. "looks good", "approved", "go ahead", "yes"), proceed to posting personas and continue to Step 2.
- If the user suggests changes (e.g. requests different names, different expertise angles, swapped positions, or anything else), adjust `$PERSONA_A_NAME`, `$PERSONA_A_DESC`, `$PERSONA_B_NAME`, and/or `$PERSONA_B_DESC` accordingly. Then re-present the updated personas in the same format and wait for approval again. Repeat until the user explicitly approves.

Once approved (or if `$AUTO_MODE` is true), post the persona assignments to the chat room so all agents can see them:

```bash
sv chat post $ROOM "[PERSONAS] Debater A: $PERSONA_A_NAME — $PERSONA_A_DESC | Debater B: $PERSONA_B_NAME — $PERSONA_B_DESC"
```

**Step 2: Round 1 — Opening arguments (parallel)**

Spawn two subagents simultaneously using the Agent tool. Do not wait for one before starting the other — launch both at the same time.

- **Persona A agent** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_A_NAME** ($PERSONA_A_DESC) in this debate: [topic]
  > Your analytical framework and expertise shapes how you argue your position — argue FROM your perspective, not just generically in favor.
  > Present 3-4 concrete arguments with evidence, grounded in your area of expertise. Research the codebase or use web search if relevant to the topic.
  > When done, post your opening to the chat room with:
  > `sv chat post $ROOM '[ROUND 1 — $PERSONA_A_NAME OPENING] <your arguments>'`
  > Replace $ROOM with the actual room name.

- **Persona B agent** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_B_NAME** ($PERSONA_B_DESC) in this debate: [topic]
  > Your analytical framework and expertise shapes how you argue your position — argue FROM your perspective, not just generically against.
  > Present 3-4 concrete arguments with evidence, grounded in your area of expertise. Research the codebase or use web search if relevant to the topic.
  > When done, post your opening to the chat room with:
  > `sv chat post $ROOM '[ROUND 1 — $PERSONA_B_NAME OPENING] <your arguments>'`
  > Replace $ROOM with the actual room name.

Wait for both subagents to complete before continuing.

**Step 3: Round 2 — Rebuttals (parallel)**

Spawn two subagents simultaneously.

- **Persona A rebuttal** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_A_NAME** ($PERSONA_A_DESC) in this debate: [topic]
  > Read the full debate history: `sv chat history $ROOM`
  > Then post a rebuttal that directly addresses $PERSONA_B_NAME's opening arguments. Engage with their specific claims through your own analytical lens — show where their framework misses what yours captures. Identify their weakest points and counter them specifically.
  > Post with: `sv chat post $ROOM '[ROUND 2 — $PERSONA_A_NAME REBUTTAL] <your rebuttal>'`

- **Persona B rebuttal** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_B_NAME** ($PERSONA_B_DESC) in this debate: [topic]
  > Read the full debate history: `sv chat history $ROOM`
  > Then post a rebuttal that directly addresses $PERSONA_A_NAME's opening arguments. Engage with their specific claims through your own analytical lens — show where their framework misses what yours captures. Identify their weakest points and counter them specifically.
  > Post with: `sv chat post $ROOM '[ROUND 2 — $PERSONA_B_NAME REBUTTAL] <your rebuttal>'`

Wait for both to complete.

**Step 4: Round 3 — Moderator challenge, then responses**

This round has two phases. Run them sequentially.

Phase A — spawn **MODERATOR** (`subagent_type: moltke`): Prompt:
> You are the debate moderator for: [topic]
> The two debaters are **$PERSONA_A_NAME** ($PERSONA_A_DESC) and **$PERSONA_B_NAME** ($PERSONA_B_DESC).
> Read the full debate history: `sv chat history $ROOM`
> Identify: the weakest arguments on each side, perspectives neither persona's framework has addressed, any false binaries or unsupported assumptions, and any places where the two analytical lenses are actually talking past each other rather than engaging.
> Post a challenge that forces both sides to defend their weakest points and address the gaps.
> Post with: `sv chat post $ROOM '[ROUND 3 — MODERATOR CHALLENGE] <your challenge>'`

Wait for the moderator to complete.

Phase B — spawn Persona A and Persona B defense in parallel:

- **Persona A defense** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_A_NAME** ($PERSONA_A_DESC) in this debate: [topic]
  > Read the full debate history including the moderator challenge: `sv chat history $ROOM`
  > Respond directly to the moderator's challenge from the perspective of your expertise. Defend your weakest points and address any gaps the moderator identified. Where the moderator says your framework is missing something, either explain why your lens handles it or concede and adjust.
  > Post with: `sv chat post $ROOM '[ROUND 3 — $PERSONA_A_NAME DEFENSE] <your defense>'`

- **Persona B defense** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_B_NAME** ($PERSONA_B_DESC) in this debate: [topic]
  > Read the full debate history including the moderator challenge: `sv chat history $ROOM`
  > Respond directly to the moderator's challenge from the perspective of your expertise. Defend your weakest points and address any gaps the moderator identified. Where the moderator says your framework is missing something, either explain why your lens handles it or concede and adjust.
  > Post with: `sv chat post $ROOM '[ROUND 3 — $PERSONA_B_NAME DEFENSE] <your defense>'`

Wait for both to complete.

**Step 5: Gap Finder / Blind Spot Detection (MANDATORY)**

Before final statements, spawn a **Gap Finder** agent (`subagent_type: researcher`): Prompt:
> You are a Blind Spot Detector for this debate: [topic]
> The two debaters are **$PERSONA_A_NAME** ($PERSONA_A_DESC) and **$PERSONA_B_NAME** ($PERSONA_B_DESC).
> Read the full debate history: `sv chat history $ROOM`
> Your job is to find what BOTH personas are missing — including blind spots that arise specifically from the limitations of their respective analytical frameworks. First, identify the domain of this debate (technical, financial, strategic, ethical, etc.) and derive the relevant blind-spot dimensions from the topic itself. Then systematically search for:
> - Perspectives, stakeholders, or affected parties neither persona considered
> - Assumptions both sides share that might be wrong (including assumptions baked into both frameworks)
> - Timeline mismatches — are the sides arguing about different time horizons?
> - Second-order effects and non-obvious consequences
> - Data or facts that would invalidate either side's strongest argument
> - Domain-specific risks appropriate to this topic (e.g., regulatory for policy debates, scalability for architecture debates, market dynamics for business debates — adapt to what the debate is actually about)
> Use web search to verify key claims and find contradicting evidence.
> Post with: `sv chat post $ROOM '[ROUND 4 — GAP FINDER] <your blind spot analysis>'`

Wait for the Gap Finder to complete. Both sides and the moderator will see these blind spots before final statements.

**Step 6: Round 5 — Final statements and verdict**

This round has two phases. Run them sequentially.

Phase A — spawn Persona A and Persona B final statements in parallel:

- **Persona A final** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_A_NAME** ($PERSONA_A_DESC) in this debate: [topic]
  > Read the full debate history INCLUDING the Gap Finder's blind spot analysis: `sv chat history $ROOM`
  > Address any blind spots the Gap Finder identified that affect your position or your analytical framework. Then post your 2-3 strongest surviving arguments. Be concise — this is your closing statement. Speak as the expert you are.
  > Post with: `sv chat post $ROOM '[ROUND 5 — $PERSONA_A_NAME FINAL] <your final statement>'`

- **Persona B final** (`subagent_type: researcher`): Prompt:
  > You are the **$PERSONA_B_NAME** ($PERSONA_B_DESC) in this debate: [topic]
  > Read the full debate history INCLUDING the Gap Finder's blind spot analysis: `sv chat history $ROOM`
  > Address any blind spots the Gap Finder identified that affect your position or your analytical framework. Then post your 2-3 strongest surviving arguments. Be concise — this is your closing statement. Speak as the expert you are.
  > Post with: `sv chat post $ROOM '[ROUND 5 — $PERSONA_B_NAME FINAL] <your final statement>'`

Wait for both to complete.

Phase B — spawn **MODERATOR VERDICT** (`subagent_type: moltke`): Prompt:
> You are the debate moderator issuing a final verdict on: [topic]
> The two debaters were **$PERSONA_A_NAME** ($PERSONA_A_DESC) and **$PERSONA_B_NAME** ($PERSONA_B_DESC).
> Read the complete debate transcript: `sv chat history $ROOM`
> Evaluate both personas across all five rounds, paying special attention to the Gap Finder's blind spot analysis and how each side addressed those gaps. Determine a winner based on argument quality, evidence, effective rebuttals, handling of blind spots, and how well each debater leveraged their specific expertise — not personal preference.
> Your verdict must include:
> 1. The winner ($PERSONA_A_NAME or $PERSONA_B_NAME), with clear reasoning
> 2. The 2-3 decisive arguments that carried the debate
> 3. Which blind spots (if any) materially changed the debate
> 4. An actionable recommendation the user can act on
> Post with: `sv chat post $ROOM '[ROUND 5 — VERDICT] <your verdict>'`

Wait for the verdict to complete.

**Step 7: Present results**

Read the full transcript:

```bash
sv chat history $ROOM
```

Present a structured summary to the user:
- The debate topic
- The two personas who debated: **$PERSONA_A_NAME** vs **$PERSONA_B_NAME**
- Winner and decisive arguments (from the verdict)
- Actionable recommendation
- Note that the full transcript is available with `sv chat history $ROOM`

Then clean up:

```bash
sv chat clear $ROOM
```

---

## Cross-project mode

**Step 8: Submit to coordinator**

If `--project <other>` was specified, extract the topic (everything before `--project`, with any `--debaters` flag preserved if present) and the project name, then run:

```bash
TOPIC="<topic without --project flag>"
PROJECT="<project name from --project>"
sv request "$TOPIC" --project "$PROJECT" --type debate --timeout 600
```

After running, report the request ID from the output, then tell the user:

- The debate request is in the **Coordinator panel** in the supervisor UI.
- **They must click Dispatch** to start the debate in the target project's session.
- To read the full debate transcript once it runs: `sv chat history debate-<first-8-chars-of-request-id>`
