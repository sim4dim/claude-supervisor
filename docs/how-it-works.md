# How Claude Supervisor Works

## TL;DR

| What | One-liner | Section |
|------|-----------|---------|
| **Remote Access** | Self-hosted dashboard — manage agents from any browser on your LAN or VPN. No SSH, no third-party relay. Optional password auth via `SUPERVISOR_PASSWORD`. | [Control Room](#the-web-dashboard-your-control-room) |
| **Security Policy** | AI evaluates every tool call, returns confidence score, auto-resolves or escalates | [Guardrails](#the-approval-system-guardrails-for-ai) |
| **Self-Learning Loop** | Eval history → learned approvals → pattern suggestions → policy edits → repeat | [Feedback Loop](#the-self-learning-feedback-loop) |
| **Agent Coordination** | MQTT pub/sub via `sv` CLI — status, discoveries, chat rooms, retained data | [Communication](#agent-communication-how-agents-talk-to-each-other) |
| **Cross-Project** | Coordinator dispatches ephemeral agents to answer questions across projects | [Coordinator](#the-coordinator-cross-project-help-desk) |
| **Skills** | `/debate`, `/centurion`, `/feasibility`, `/collab`, `/ask-project` | [Skills](#skills-slash-commands-for-complex-workflows) |
| **Session Continuity** | Auto-commit, progress snapshot, transcript extraction, session handoff | [Safety Net](#the-safety-net-session-continuity) |
| **Delegation** | Context-% enforcement keeps main window lean, reduces compaction | [Delegation](#delegation-enforcement) |

## What Is It?

Claude Supervisor is a self-hosted control plane for Claude Code sessions. Run your agents on a workstation or server, manage them from any browser on your local network or over VPN — your phone on the couch, a tablet in another room, a laptop on a different floor. Your code stays on your hardware, your network, no third-party relay. The dashboard gives you real-time terminals, an AI-evaluated approval system, agent activity feeds, and cross-project coordination — all in one browser tab.

Anthropic ships Claude Code with remote access via claude.ai/code, and the CLI has built-in permission controls. Claude Supervisor is not a replacement for those — it layers on top of them. The difference is the AI-evaluated security policy with confidence scoring, the cross-project agent coordination via MQTT, the structured debate and adversarial review skills, the learned approval patterns, and the compaction recovery system. These are the pieces that make multi-agent workflows manageable when you're running 3-5 sessions on real projects simultaneously.

## The Web Dashboard: Your Control Room

The web interface is a single-page dashboard split into two main areas.

On the left is the **terminal panel**. Each tab represents a separate AI agent working on a different project. You see exactly what the agent sees — the same terminal output, scrolling in real time. You can open new sessions, restart them, and type into them directly if you need to nudge an agent in a different direction.

On the right is the **control panel**, organized into collapsible sections:

- **Pending Approvals** — actions waiting for human review. Each card shows the tool, command, AI confidence score, and reasoning. Approve or deny with one click, or override an AI auto-decision.
- **Operations** — a task-oriented view showing subagent work: what was dispatched, what's running, what completed. Each entry shows the subagent type, task description, and project. This is how you track the actual work being done across your sessions.
- **Eval History** — a filterable log of every AI evaluation: what was approved, denied, or escalated, with confidence scores. Filter by project, by outcome, or search for specific commands. This is the audit trail.
- **Activity Log** — real-time stream of all hook events: files read, commands run, tools called, agent status updates, MQTT messages. Everything that happens across all sessions appears here chronologically.
- **Team Chat** — two modes: human-to-human messaging across supervisor instances, and a live viewer for agent-to-agent chat rooms. When agents run a debate, collab, or coordinator exchange, their `sv chat` messages appear in the panel in real time — you can watch agents argue and negotiate as it happens.

The dashboard header shows the current supervisor mode (Auto/Assisted/Manual), Claude API status (polled from status.claude.com), and rate limit usage.

## How AI Agents Run: Terminals and dtach

Each AI agent runs inside a persistent terminal session on the server. The system uses dtach to keep these sessions alive even if you close your browser or the server restarts. The agent keeps working whether you are watching or not.

When you connect to the dashboard, the system replays recent terminal output (2MB scrollback buffer per session) so you can catch up on what happened while you were away.

Multiple browsers can connect simultaneously with a **controller / view-only** model. The first connection becomes the controller — they can type into the terminal. Everyone else is a read-only viewer: they see the full terminal output streaming in real time but cannot send input. This is useful for monitoring from a second device (your phone while you're on the couch) without accidentally interfering with a running agent. Any viewer can click **Take Control** to take over. When the controller disconnects, the next viewer is promoted automatically.

The dashboard also includes an **LCARS theme** — click the theme toggle in the header to switch to a Star Trek TNG-inspired interface. Because if you're running a bridge full of AI agents, you might as well look the part.

### Authentication

Set `SUPERVISOR_PASSWORD` to require login before accessing the dashboard. When enabled, all browser routes, API endpoints, and WebSocket connections require authentication. Hook scripts authenticate automatically using a bearer token written to `~/.claude/.supervisor-hook-token` on startup — no manual hook configuration needed. When `SUPERVISOR_PASSWORD` is not set, the dashboard is open to anyone on the network.

Context usage is tracked per session — the dashboard parses PTY output for context percentage and shows color-coded badges on each tab. Predictive warnings fire at 50%, 65%, and 80% used, giving the agent (and you) time to respond before the context window fills.

## The Approval System: Guardrails for AI

Every action an AI agent wants to take passes through hooks — checkpoints that fire before, during, and after each operation.

### Three-tier fast path (in the hooks, before anything hits the server)

**Before a tool runs** (the pre-tool-use hook), the system makes a quick local decision:

- **Auto-approve safe actions.** Reading files (`Read`, `Glob`, `Grep`), the Task tool, and safe bash commands (`git status`, `npm test`, `ls`, `cat`) go through instantly with zero delay. File edits are approved unless they target `.env`, secrets files, `.git/`, `/etc/`, or `node_modules/`.
- **Auto-deny dangerous actions.** `rm -rf /`, `dd if=`, `mkfs.`, `curl | sh`, `wget | bash`, local `sudo`/`su`, `git push --force` to main/master, network listeners on `0.0.0.0`, global installs (`npm -g`, `pip` outside venv). These are blocked outright — they never reach the server.
- **Learned patterns.** Commands that have been consistently approved by the AI evaluator (95%+ confidence, 100% approval rate, 3+ occurrences) get promoted to auto-approve rules in `dynamic-approvals.sh`. This file is regenerated periodically by `eval-housekeeping.js`. The system builds a project-specific fast path from its own evaluation history — your policy evolves from usage.
- **Everything else goes to the supervisor server.** This is where the AI evaluator comes in.

### The AI evaluator

For actions that are not in the auto-approve or auto-deny lists, the hook POSTs the tool call to the supervisor server and polls for a decision (every 2 seconds, up to a 5-minute timeout).

The server spawns a second AI instance to evaluate the request. The evaluator reads `supervisor-policy.md` — a plain markdown file that defines your security rules. It contains three sections:

- **Always approve** (high confidence): read-only operations, standard dev commands, git reads, package installs, SSH/SCP to known deployment targets, API calls with tokens to known services
- **Always deny** (high confidence): system file modifications, destructive commands, credential file writes, pipe-to-shell patterns, privilege escalation
- **Evaluate carefully** (may be low confidence): piped commands, docker operations, downloads, commands longer than 200 characters, file operations outside the project directory

The evaluator returns a JSON response: `{"approved": true, "confidence": 0.85, "reason": "brief explanation"}`. If the confidence is above your threshold (default 0.8), the decision auto-resolves — the hook gets its answer and Claude continues. If confidence is below the threshold, the request appears on the dashboard for human review, with the AI's reasoning and recommendation visible on the approval card.

**The policy file is yours to edit.** Add rules, remove defaults, adjust what counts as "safe" for your workflow. The evaluator reads it on every call — changes take effect immediately, no restart needed.

### The evaluator also considers context

The evaluator doesn't just match rules — it considers what the agent has been doing recently. A sequence of related operations (editing files, then running tests) is treated as legitimate workflow. A sudden context switch to unrelated system operations is flagged as suspicious. This means the same command can score differently depending on what came before it.

### Evaluator backends

The evaluator runs on whatever backend you configure:

- **Claude CLI** (`claude -p`) — works with any Claude plan (Free, Pro, Max), no API key needed. This is the default.
- **Anthropic API** — set `ANTHROPIC_API_KEY`. Recommended for teams.
- **Ollama** — local models, zero external API calls. Set `OLLAMA_HOST`. The supervisor picks whichever model is already loaded in VRAM.
- **Any OpenAI-compatible endpoint** — set `OLLAMA_HOST` to your endpoint URL.

### Eval Fallback Proxy

The `addons/ollama-proxy` provides a safety net. When the local Ollama model fails (out of memory, model not loaded, service down), the supervisor falls back to this proxy, which routes the eval call to Claude Haiku via the `claude -p` CLI. This gives you a second independent evaluator without needing an Anthropic API key — it uses your existing Claude authentication.

Without the proxy, a failed Ollama evaluation falls through to auto-approve with confidence 0.5, effectively disabling the safety layer. We recommend always running the proxy alongside the supervisor.

The full evaluation fallback chain:

1. **Ollama** (local model, e.g. mistral-nemo) — zero cost, independent trust boundary
2. **Claude Haiku via proxy** (`addons/ollama-proxy` on port 11436) — fast, cheap, different model
3. **Auto-approve with confidence 0.5** — last resort, logged for review. Effectively disables the safety layer.

### Three modes

- **Auto** (default): The AI evaluator handles most decisions. You only see the ones it's uncertain about.
- **Assisted**: The AI evaluates and recommends, but you must confirm every decision.
- **Manual**: No AI evaluation. Every tool call goes to the dashboard for human review.

### Pattern analysis

Every 20 evaluations, the supervisor analyzes `eval-history.jsonl` looking for patterns: commands that keep getting denied, delegation violations, keyword clusters in denied calls. When it spots something, it broadcasts a `memory_suggestion` event to the dashboard — a specific recommendation like "consider adding `docker compose` to auto-approve" or "this project frequently runs `nmap`, add it to the policy." The policy evolves from what actually happens, not from what you guessed would happen upfront.

### AskUserQuestion auto-answer

When a worker Claude asks a clarifying question (via the `AskUserQuestion` tool), the supervisor can answer it automatically using Claude Sonnet. The answer is injected into the PTY after a configurable delay, giving you a window to override it. Set `SUPERVISOR_AUTO_ANSWER_QUESTIONS=ai` for fully unattended sessions — the agent won't stall waiting for a human if it has a question at 2am.

### Audit trail

After every tool call completes, the post-tool-use hook logs what happened to the dashboard. The Eval History panel shows every evaluation with its confidence score, outcome, and reasoning. The Activity Log shows the raw stream of all hook events. Together, they give you a complete record of everything that happened and why.

## Delegation Enforcement

The supervisor coaches the worker Claude to use subagents for heavy implementation work, keeping the main context window lean for coordination. This is enforced based on context usage:

- Above 50% remaining: no enforcement.
- 30–50% remaining: warnings.
- Below 30%: implementation tool calls are denied and corrective instructions are injected into the PTY.

This directly reduces how often compaction happens, which reduces work loss.

## Agent Communication: How Agents Talk to Each Other

Claude Code sessions are isolated processes — no shared memory, no shared filesystem. The system uses MQTT as a coordination layer. MQTT is a lightweight pub/sub messaging protocol (the same one used in industrial IoT), running locally via Mosquitto in ~2MB of RAM.

Each agent gets access to the `sv` CLI, which wraps MQTT into simple commands:

- **Status publishing**: `sv pub status started "investigating auth bug"` — appears in the Operations panel.
- **Discoveries**: `sv pub discovery "tokens expire after 1h, not 24h"` — visible to the dashboard and other agents.
- **Chat rooms**: `sv chat init design-review` / `sv chat post design-review "my recommendation: ..."` — structured back-and-forth between agents, used by the debate and collab skills.
- **Retained data**: `sv retain "topic" "payload"` — persistent key-value exchange between agents that survives disconnects.

All `sv` commands are auto-approved by the supervisor — no evaluation delay.

## The Coordinator: Cross-Project Help Desk

Sometimes an agent working on one project needs information from a completely different project. The coordinator acts as a dispatcher.

An agent sends a help request like "check if getUserById returns null or throws on a missing user" targeted at a specific project. The coordinator dispatches an ephemeral Claude CLI agent in that project's directory to investigate. Research requests get a read-only Haiku agent. Action requests get a Sonnet agent with full tools. When it finishes, it publishes a response via MQTT that the original requester picks up.

The coordinator also supports structured multi-agent patterns:

- **Feasibility (Moltke pattern)**: named after the Prussian field marshal who insisted every plan be stress-tested before commitment. A planner agent produces a report, then a Moltke (adversarial reviewer) agent critiques it — looking for assumptions, failure modes, hidden costs, and overlooked constraints.
- **Debate**: 5-round structured adversarial debate between expert personas, including a gap finder agent that catches blind spots both sides missed.
- **Collab**: two project agents negotiate toward consensus in a 3-round protocol.

All coordinator activity is tracked in the Operations panel.

## Skills: Slash Commands for Complex Workflows

The supervisor includes slash command skills that orchestrate multi-agent workflows:

- `/debate "topic"` — structured 5-round debate between expert personas. Persona setup, opening arguments, rebuttals, moderator challenge, gap analysis, verdict. All rounds run agents in parallel where possible.
- `/centurion` — parallel security scan (see below).
- `/feasibility` — adversarial feasibility review of a proposed plan.
- `/collab` — consensus negotiation between two projects.
- `/ask-project` — send a question to another project's running session and get an answer back.

### /centurion — Security Scanning

`/centurion` runs 5 scan categories in parallel, each as a separate agent:

1. **Packages** — checks pip and npm dependencies against a blocklist of known malicious packages, scans for `.pth` file injection (a Python supply chain vector), runs `npm audit`, and detects requirements drift.
2. **System** — compares current cron jobs against a saved baseline, reviews SSH authorized keys, checks file permissions on sensitive directories, scans for unexpected network listeners, and flags suspicious running processes.
3. **Git** — checks GitHub Actions for unpinned versions, scans commit history for accidentally committed secrets, and reviews `.gitignore` coverage.
4. **Credentials** — verifies Claude token freshness, checks file permissions on credential files, reviews Docker volume mounts for exposed secrets.
5. **Advisory feed** — checks for recently disclosed CVEs affecting your installed packages, cross-references against a maintained blocklist.

Each scan produces findings. The results are combined into a **health score from 0 to 100** with a rating: SECURE (90-100), ATTENTION (70-89), DEGRADED (40-69), or CRITICAL (0-39).

Run `/centurion --baseline` first to record your system's clean state. Subsequent runs compare against the baseline and flag drift — new cron jobs, new SSH keys, new network listeners that weren't there before.

## The Self-Learning Feedback Loop

The supervisor is not a static set of rules — it's a closed-loop system that evolves from its own operational data.

Here's the loop:

1. **Tool calls flow through the evaluator.** Every decision (approve, deny, escalate) is logged to `eval-history.jsonl` with the command, confidence score, outcome, and reasoning.

2. **Learned approvals promote trusted patterns.** `eval-housekeeping.js` periodically scans the eval history. Commands that were approved 3+ times with 95%+ confidence and a 100% approval rate get written to `dynamic-approvals.sh` as fast-path auto-approve rules. Next time that command runs, it skips the evaluator entirely. The system gets faster as it learns your workflow.

3. **Pattern analysis suggests policy changes.** Every 20 evaluations, the supervisor looks for repeated denials, delegation violations, and keyword clusters. It broadcasts `memory_suggestion` events to the dashboard: "this project frequently runs `openscad` — consider adding it to auto-approve" or "3 denials for `docker compose up` this session — add to policy?" You review and decide.

4. **You edit the policy.** `supervisor-policy.md` is a plain markdown file. Add rules, remove defaults, adjust what counts as safe. Changes take effect on the next evaluation — no restart.

5. **The cycle repeats.** New rules produce new eval history, which produces new learned approvals, which produce new pattern suggestions. The system converges toward a policy that matches how you actually work, not how you guessed you would work on day one.

The result: day one, you're reviewing a lot of approval cards. Day five, most of your common operations skip the evaluator. Day thirty, the policy is tight enough that the cards that do appear are genuinely worth your attention.

## The Safety Net: Session Continuity

AI agents have a limited context window — their working memory. When a conversation gets too long, older content gets compressed to make room and the agent loses detailed memory of earlier work. This is called compaction.

The supervisor handles this with multiple layers:

**Before compaction** (`pre-compact.sh`):
1. Auto-commits all uncommitted work to git with a timestamped message
2. Writes a progress snapshot with git state, recent agent activity, and pending approvals
3. Extracts a transcript decision trail — the reasoning behind recent work, not just the state
4. Publishes an MQTT event so the dashboard shows the compaction

**After compaction** or **on session start** (`session-start.sh`):
- Re-injects up to three context files: session handoff (48h window), progress snapshot (24h), transcript excerpt (24h)
- Claude reads its own recovery checklist (deployed via CLAUDE.md.template) and verifies state against git before continuing

**On session end** (`on-stop.sh`):
- Writes a session handoff file with git state, uncommitted changes, and a checklist for the next session

The result: an agent that compacts or restarts recovers in seconds, verifies what was already done, and picks up where it left off without asking "what was I doing?"

## A Day in the Life

You open the dashboard on your phone and tap "+ New" to start an agent on your web app project. The agent launches in a terminal tab. You type: "Fix the login bug where users get logged out after 5 minutes."

The agent reads several files to understand the codebase (auto-approved instantly — green checkmarks stream through the Activity Log). It spawns two subagents — one to investigate the session configuration, another to check the token refresh logic. Their progress appears in the Operations panel as separate task entries.

The investigating subagent publishes a discovery: "Session timeout is hardcoded to 300 seconds in config.js." You see it appear in the activity feed. The main agent decides to edit that file. The edit goes through auto-approval since it is a normal project file.

Then it wants to run a deployment script. This is not on the auto-approve list, so the request lands in your Pending Approvals panel with the AI's assessment: "Bash: ./deploy.sh --staging — confidence 0.65, escalating to human review." You tap Approve.

The fix goes out. The agent runs the test suite (auto-approved), confirms all tests pass, and commits the change. The whole interaction took a few minutes, and you made one decision. The Eval History shows 23 auto-approved calls, 1 human-approved, 0 denied.

Meanwhile, the pre-compaction hook has been quietly saving progress at every memory boundary, and the post-tool-use hooks have been logging every action. If the agent's context fills up tomorrow, it will recover from exactly this point.
