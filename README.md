# Claude Code Remote Supervisor

AI-powered supervision for Claude Code sessions. Evaluates tool call safety using a local LLM (Ollama) by default — works offline, no API costs. Can escalate to Claude CLI for difficult decisions. A web dashboard shows real-time approvals, activity, and browser-based terminals for launching and interacting with Claude sessions from any device.

## Architecture

```
Claude Code (worker)
    │ tool call
    ▼
Hook script ──POST──▶  Supervisor Server ◀── Web UI (browser)
    │                        │                      │
    │ polls every 2s    Tier 1: Ollama         WebSocket
    │                   (local LLM, default)        │
    │                        │ if unavailable   ┌───┴────────┐
    │                   Tier 2: claude -p       │ Approvals  │
    │                   (Claude CLI fallback)   │ Terminals  │
    │                        │                 │ Activity   │
    │                  High confidence         └────────────┘
    │                  auto-resolve
    │                        │ low confidence
    ◀── decision ◀──────────┘              human reviews + overrides
```

**Multi-tier evaluation**: Tier 1 is Ollama (fast, free, works offline). Tier 2 is `claude -p` (used when Ollama is down or for a second opinion on hard cases). An optional `ollama-proxy` addon can sit in front and route between local models and the Claude API dynamically.

## Features

- **Local-first AI evaluation** via Ollama — no API costs, works offline, sub-second decisions
- **Claude CLI fallback** when Ollama is unavailable or confidence is borderline
- **Web dashboard** with real-time approvals, activity log, and project filtering
- **Browser-based terminals** to launch and interact with Claude sessions from any device (phone, tablet, remote machine)
- **Multi-project** support with color-coded project labels and per-project filtering
- **Subagent enforcement** coaches the worker Claude to use Task tool for complex work
- **MQTT integration** for agent status, cross-project chat, and coordinator requests
- **Graceful fallback** when server is down — hooks pass through and Claude works normally
- **Password auth** to protect the dashboard on shared or remote hosts

## Quick Start

### Prerequisites

- Node.js 18+
- [Ollama](https://ollama.com) installed and running (`ollama serve`)
- Claude Code CLI installed and authenticated (`claude` command available)
- `jq` and `curl` available in PATH
- `dtach` for terminal session persistence (`sudo apt install dtach`)
- Build tools for native modules (`build-essential` on Debian/Ubuntu)

### 1. Pull an evaluation model

```bash
ollama pull mistral-nemo
```

Any model in the trusted list works. See `SUPERVISOR_OLLAMA_TRUSTED_MODELS` below.

### 2. Install dependencies

```bash
cd claude-supervisor
npm install
```

### 3. Start the supervisor server

```bash
node server.js
```

Opens on port 3847. Visit `http://localhost:3847` in a browser (or `http://<your-ip>:3847` from your phone).

### 4. Set up a project

```bash
./setup-project.sh /path/to/your/project
```

This copies hook scripts and creates `.claude/settings.json` in the target project. Then run Claude:

```bash
cd /path/to/your/project
claude
```

Tool calls will route through the supervisor for evaluation.

### 5. Or launch from the web UI

Click **+ New** in the terminal panel to launch a Claude session for any project. Hooks are auto-installed if missing.

### 6. Remove supervision from a project

```bash
./teardown-project.sh /path/to/your/project
```

Or click **Remove Hooks** in the terminal statusbar. This removes hook scripts and the hooks config from `.claude/settings.json` while preserving any other settings.

## How It Works

1. **Claude Code Hooks** intercept tool calls via `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, and other events
2. Hook scripts POST to the supervisor server via HTTP
3. The server evaluates the tool call against the security policy using **Ollama** (Tier 1)
4. If Ollama is unavailable, it falls back to **`claude -p`** (Tier 2)
5. **High-confidence decisions** (above threshold) are auto-approved or auto-denied instantly
6. **Low-confidence decisions** are escalated to the web UI for human review, with the AI's recommendation shown
7. Activity is logged in real-time so you can monitor all sessions from any browser

## Web Dashboard

### Layout

- **Desktop** (>900px): split pane with terminals on the left (60%) and approvals on the right (40%)
- **Mobile**: tab toggle between Terminals and Approvals views

### Approval Panel

- Pending approvals with approve/deny buttons
- AI evaluation status and reasoning shown on each card
- Override buttons when AI has auto-decided
- Project filter bar (color-coded)
- Activity log with real-time updates

### Terminal Panel

- **Tab bar** with one tab per active Claude session
- **Project picker** dialog to launch new sessions (lists directories under project root)
- **Turn counter** badge on each tab, color-coded by context usage
- **Controller/viewer model**: first browser connection gets keyboard control, others are read-only viewers
- **Take Control** button lets viewers take over from the current controller
- **Scrollback buffer** (2MB) so late-joining browsers see recent terminal output
- **Restart** button to respawn an exited session

## Web Terminals

The supervisor spawns and manages Claude Code sessions via PTY. Launch, view, and interact with Claude from any browser — no SSH required.

### Terminal API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List available projects |
| `/api/terminals` | GET | List active terminal sessions |
| `/api/terminals` | POST | Create a new terminal (`{"project": "name"}`) |
| `/api/terminals/:id/restart` | POST | Restart an exited terminal |
| `/api/terminals/:id` | DELETE | Kill and remove a terminal |
| `/api/projects/:name/teardown` | POST | Remove supervisor hooks from a project |

## Setup Script

```bash
./setup-project.sh /path/to/project [port] [role]
```

- **port** defaults to 3847. Use a different port if running multiple supervisor instances.
- **role** is an optional description of Claude's expertise for the project (inserted into the project's CLAUDE.md).

```bash
# Basic setup
./setup-project.sh /home/user/projects/myapp

# With role context
./setup-project.sh /home/user/projects/hvac 3847 "HVAC automation engineer"
```

## Hook Behavior

| Hook | Event | What it does |
|------|-------|--------------|
| `pre-tool-use.sh` | PreToolUse | Auto-approves safe tools (Read, Glob, Grep, Task) and normal file edits. Auto-blocks destructive commands. Everything else goes to remote approval. |
| `permission-request.sh` | PermissionRequest | Intercepts Claude Code's built-in permission dialogs and routes them through the supervisor. |
| `post-tool-use.sh` | PostToolUse | Logs every completed tool call to the dashboard (fire-and-forget). |
| `notification.sh` | Notification | Forwards notifications to the dashboard and triggers `notify-send` on Linux. |
| `on-stop.sh` | Stop | Logs when Claude finishes a response turn. Used for turn counting. |
| `on-stop-failure.sh` | Stop | Handles stop events with non-zero exit codes. |
| `pre-compact.sh` | PreCompact | Auto-commits work and notifies dashboard before context compaction. |
| `post-compact.sh` | PostCompact | Runs post-compaction recovery steps. |
| `session-start.sh` | SessionStart | Initializes session tracking and publishes MQTT status. |
| `task-created.sh` | TaskCreated | Tracks subagent delegation for enforcement. |
| `statusline.sh` | — | Reports context usage percentage and token counts. |
| `dynamic-approvals.sh` | — | Dynamic rule evaluation for approval decisions. |
| `file-changed.sh` | — | Triggers on file changes for live reload or logging. |

### Auto-approve rules (never hit the server)

- **Read-only tools**: `Read`, `Glob`, `Grep`, `LS`, `Task`
- **File edits**: Approved unless targeting `.env`, `secrets`, `.git/`, `/etc/`, `node_modules/`
- **Safe bash**: `ls`, `cat`, `git status`, `npm test`, `node`, `python`, etc.

### Auto-deny rules (in hooks)

- `rm -rf /`, `dd if=`, `mkfs.` and similar destructive commands

### Graceful fallback

If the supervisor server is not running, all hooks fall through silently. Claude Code works normally without blocking.

## AI Supervisor Modes

| Mode | Behavior |
|------|----------|
| **`auto`** (default) | AI evaluates every tool call. High confidence auto-resolves. Low confidence escalates to human with recommendation. |
| **`assisted`** | AI evaluates and shows recommendation, but human must always confirm. |
| **`manual`** | No AI evaluation. Human approves everything. |

### Evaluation Backend (Multi-tier)

The evaluation backend is configured via `SUPERVISOR_EVAL_BACKEND`:

- **`ollama`** (default): Uses a local Ollama model (fast, free, works offline). Falls back to `claude -p` if Ollama is unavailable.
- **`claude`**: Uses `claude -p` directly (requires Claude CLI auth).

The trusted model list (`SUPERVISOR_OLLAMA_TRUSTED_MODELS`) controls which Ollama models are accepted. Models not on the list are rejected to prevent using a weak model for security decisions.

### Subagent Enforcement

The supervisor coaches the worker Claude to use subagents based on context window usage:

- **< 50% context used**: No enforcement
- **50–70% context used**: Warn mode — hint in eval prompt, never deny
- **> 70% context used**: Strict mode — deny implementation calls that should be delegated

The deny reason is visible to the worker, which adjusts its behavior.

### Security Policy

The AI evaluates tool calls against `supervisor-policy.md`:

- **Always approve**: Read-only operations, standard dev commands, git read operations
- **Always deny**: System file modifications, destructive commands, secrets access, `sudo`, pipe-to-shell
- **Allowed**: SSH deployment to known hosts, local network API calls with tokens
- **Evaluate carefully**: Piped commands, docker, downloads, operations outside project directory

## Password Authentication

Set `SUPERVISOR_PASSWORD` to protect the dashboard:

```bash
SUPERVISOR_PASSWORD=yourpassword node server.js
```

When enabled:
- Dashboard shows a login page. Enter the password to access.
- Hooks authenticate via bearer token stored in `$HOME/.claude/.supervisor-hook-token` (written automatically on startup).
- Use `SUPERVISOR_HOOK_TOKEN` to set a fixed token (useful for multi-user setups where hooks are configured before server restarts).

## Skills

Skills are slash commands available inside Claude sessions supervised by this server. They're stored in `skills/` and loaded into Claude via `CLAUDE.md`.

| Skill | Description |
|-------|-------------|
| `/debate` | Structured multi-agent debate with expert personas — use for tradeoff analysis or architecture decisions |
| `/collab` | Start a cross-project collaboration using a shared MQTT chat room |
| `/feasibility` | Adversarial plan review (Moltke method) — planner + skeptical reviewer |
| `/centurion` | Security monitoring — scans for supply chain attacks, credential exposure, suspicious processes |
| `/ask-project` | Ask another project's running Claude session a question |
| `/audit-public` | Audit a repo for sensitive data before making it public |
| `/review-changes` | Review code changes since last server restart; recommend whether to restart |
| `/restart-server` | Restart the supervisor server to pick up code changes |
| `/release-monitor` | Check for new Claude Code releases and evaluate features for adoption |
| `/project-status` | Quick health check: git status, running sessions, pending changes, recent activity |
| `/supervisor-policy` | Reference for what gets auto-approved, auto-denied, or escalated |
| `/subagent-communication` | Reference for `sv` MQTT commands: pub, chat, retain, request |
| `/post-compaction-recovery` | Guides recovery after context compaction |

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERVISOR_PORT` | `3847` | Server listen port |
| `SUPERVISOR_MODE` | `auto` | AI mode: `auto`, `assisted`, `manual` |
| `SUPERVISOR_PROJECT_ROOT` | `~/projects` | Parent directory for project discovery |
| `SUPERVISOR_MAX_TERMINALS` | `5` | Max concurrent web terminals |
| `SUPERVISOR_DTACH_DIR` | `/tmp` | Directory for dtach sockets |
| `SUPERVISOR_COORDINATOR` | _(unset)_ | Set to `false` to disable coordinator |
| `SUPERVISOR_PEERS` | _(unset)_ | Peer supervisor instances: `name=url,name=url` |
| `SV_INSTANCE` | hostname | Coordinator instance name |
| `CLAUDE_BINARY` | `~/.local/bin/claude` | Path to claude CLI |

### Eval Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERVISOR_EVAL_BACKEND` | `ollama` | Eval backend: `ollama` or `claude` |
| `SUPERVISOR_OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `SUPERVISOR_OLLAMA_MODEL` | `mistral-nemo` | Ollama model for evaluations |
| `SUPERVISOR_OLLAMA_TRUSTED_MODELS` | _(see code)_ | Comma-separated list of accepted Ollama models |
| `SUPERVISOR_MODEL` | `claude-sonnet-4-20250514` | Claude CLI model for Tier 2 fallback evaluations |
| `SUPERVISOR_FAST_MODEL` | `claude-haiku-4-5-20251001` | Fast Claude model for quick decisions |
| `SUPERVISOR_CONFIDENCE_THRESHOLD` | `0.8` | Auto-resolve confidence threshold (0.0–1.0) |
| `SUPERVISOR_EVAL_TIMEOUT` | `60000` | Max ms for AI evaluation before timeout |
| `SUPERVISOR_EVAL_ESCALATION_THRESHOLD` | `70` | Context % above which strict enforcement activates |
| `SUPERVISOR_MAX_CONCURRENT` | `3` | Max parallel AI evaluations |
| `SUPERVISOR_POLICY_PATH` | `./supervisor-policy.md` | Path to security policy file |
| `SUPERVISOR_QUESTION_MODEL` | `claude-sonnet-4-20250514` | Model for AI question answering |
| `SUPERVISOR_AUTO_ANSWER_QUESTIONS` | _(unset)_ | Set to `ai` for fully unattended mode |
| `SUPERVISOR_QUESTION_DELAY` | `30` | Seconds before auto-answering questions |
| `SUPERVISOR_DELEGATION_ENFORCEMENT` | `true` | Set to `false` to disable subagent enforcement |
| `SUPERVISOR_COORDINATOR_MODEL` | _(uses SUPERVISOR_MODEL)_ | Model for coordinator agent responses |
| `SUPERVISOR_COORDINATOR_FAST_MODEL` | `claude-haiku-4-5-20251001` | Fast model for coordinator routing |

### Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERVISOR_PASSWORD` | _(unset)_ | Dashboard password. Enables login page when set. |
| `SUPERVISOR_HOOK_TOKEN` | _(random)_ | Bearer token for hook authentication. Auto-generated if unset. |

### MQTT

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERVISOR_MQTT_HOST` | `localhost` | Primary MQTT broker host |
| `SUPERVISOR_MQTT_BACKUP_HOST` | _(unset)_ | Backup MQTT broker host |
| `SUPERVISOR_MQTT_BACKUP_USER` | _(unset)_ | Backup broker username |
| `SUPERVISOR_MQTT_BACKUP_PASS` | _(unset)_ | Backup broker password |

### Hooks (set per-project in `.env` or hook scripts)

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_SUPERVISOR_URL` | `http://localhost:3847` | Supervisor server URL |
| `CLAUDE_SUPERVISOR_TIMEOUT` | `300` | Max seconds to wait for approval decision |

## Multi-User / systemd Deployment

### Quick Start (ad-hoc)

```bash
SUPERVISOR_PORT=3847 node server.js
```

### systemd (Recommended)

The service runs directly from this git repo — no copy to `/opt`. Code changes take effect on restart.

```bash
# 1. Install systemd template (run once as admin)
sudo ./install.sh

# 2. Add users (one instance per user, each on a unique port)
sudo ./add-user.sh alice 3847 /home/alice/projects
sudo ./add-user.sh bob 3848 /home/bob/projects
```

Each user gets their own dashboard, terminals, and approvals. Logs via `journalctl -u claude-supervisor@<port> -f`.

```bash
# Restart after code changes
sudo systemctl restart claude-supervisor@3847
sudo systemctl restart 'claude-supervisor@*'
```

Per-instance config: `/etc/claude-supervisor/<port>.env`

## Files

```
claude-supervisor/
├── server.js                    # Express + WebSocket server, AI supervisor, terminal management
├── web-ui.html                  # Dashboard frontend (xterm.js, approvals, activity log)
├── supervisor-policy.md         # Security policy evaluated by the AI
├── CLAUDE.md.template           # Work instructions deployed to projects (auto-synced on startup)
├── install.sh                   # Admin: install systemd template
├── add-user.sh                  # Admin: configure a per-user instance
├── setup-project.sh             # Set up any project for supervision (hooks + CLAUDE.md)
├── teardown-project.sh          # Remove supervisor hooks from a project
├── package.json                 # Dependencies: express, ws, node-pty
├── hooks/                       # Hook scripts (copied to projects by setup-project.sh)
│   ├── pre-tool-use.sh          # Intercepts tool calls, routes to approval
│   ├── permission-request.sh    # Intercepts Claude's permission dialogs
│   ├── post-tool-use.sh         # Logs completed tool calls
│   ├── notification.sh          # Forwards notifications
│   ├── on-stop.sh               # Logs response turns
│   ├── on-stop-failure.sh       # Handles stop failures
│   ├── pre-compact.sh           # Auto-commits and notifies before compaction
│   ├── post-compact.sh          # Post-compaction recovery steps
│   ├── session-start.sh         # Session initialization
│   ├── task-created.sh          # Subagent delegation tracking
│   ├── statusline.sh            # Context usage reporting
│   ├── dynamic-approvals.sh     # Dynamic approval rule evaluation
│   └── file-changed.sh          # File change events
├── skills/                      # Slash commands available inside Claude sessions
│   ├── debate/
│   ├── collab/
│   ├── feasibility/
│   ├── centurion/
│   └── ...                      # 13 skills total
├── bin/                         # CLI utilities (sv helper, token refresh, etc.)
├── docs/                        # Documentation and usage guides
├── scripts/                     # Maintenance scripts (eval housekeeping, release checks)
├── security/                    # Baselines for centurion security monitoring
└── systemd/                     # Per-user systemd service files
```