# Claude Code Remote Supervisor

AI-powered supervision for Claude Code sessions. An autonomous agent evaluates tool call safety and auto-approves/denies with high confidence, escalating uncertain decisions to a human dashboard. Includes web-based terminals for launching and interacting with Claude sessions from any browser.

No API plan required. Works with Max plan using **Claude Code Hooks** + a second Claude CLI instance as the AI brain.

## Architecture

```
Claude Code (worker)
    │ tool call
    ▼
Hook script (pre-tool-use.sh)  ──POST──▶  Supervisor Server ◀── Web UI (browser)
    │                                            │                      │
    │ polls every 2s                    spawns: claude -p (sonnet)  WebSocket
    │                                            │                      │
    │                                    AI evaluates safety     ┌──────┴──────┐
    │                               ┌────────────┴──────────┐   │  Approvals  │
    │                               │                        │   │  Terminals  │
    │                         High confidence           Low      │  Activity   │
    │                         auto-resolve            escalate   └─────────────┘
    │                               │                    │
    ◀────── decision ◀──────────────┘              human reviews
                                                   and overrides
```

## Features

- **AI supervisor** evaluates every tool call against a security policy, auto-resolving high-confidence decisions
- **Web dashboard** with real-time approvals, activity log, and project filtering
- **Web terminals** to launch and interact with Claude Code sessions from any browser (phone, tablet, remote machine)
- **Multi-project** support with color-coded project labels and per-project filtering
- **Subagent enforcement** coaches the worker Claude to use Task tool for complex work
- **Graceful fallback** when server is down, hooks pass through and Claude works normally

## Quick Start

### Prerequisites

- Node.js 18+
- Claude Code CLI installed and authenticated (`claude` command available)
- `jq` and `curl` available in PATH
- `dtach` for terminal session persistence (`sudo apt install dtach`)
- Build tools for native modules (`build-essential` on Debian/Ubuntu)

### 1. Install dependencies

```bash
cd claude-supervisor
npm install
```

### 2. Start the supervisor server

```bash
node server.js
```

The server starts on port 3847 by default. Open `http://localhost:3847` in a browser (or `http://<your-ip>:3847` from your phone).

### 3. Set up a project

```bash
./setup-project.sh /path/to/your/project
```

This copies hook scripts and creates `.claude/settings.json` in the target project. Now run Claude in that project:

```bash
cd /path/to/your/project
claude
```

Tool calls will route through the supervisor.

### 4. Or launch from the web UI

Click **+ New** in the terminal panel to launch a Claude session for any project. Hooks are auto-installed if missing.

### 5. Remove supervision from a project

From the CLI:

```bash
./teardown-project.sh /path/to/your/project
```

Or click **Remove Hooks** in the terminal statusbar while viewing a project's terminal. This removes hook scripts, the hooks config from `.claude/settings.json`, and supervisor instructions from `CLAUDE.md` — while preserving any other settings or content in those files.

## How It Works

1. **Claude Code Hooks** intercept tool calls via `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, and `Stop` events
2. Hook scripts communicate with the supervisor server via HTTP
3. The server spawns `claude -p` (a second CLI instance) to evaluate tool call safety against the security policy
4. **High-confidence decisions** (above threshold) are auto-approved/denied instantly
5. **Low-confidence decisions** are escalated to the web UI for human review, with the AI's recommendation shown
6. Activity is logged in real-time so you can monitor all sessions from any browser

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
- **Turn counter** badge on each tab, color-coded by context usage:
  - Gray: <8 turns (fresh)
  - Yellow: 8-14 turns (moderate)
  - Red: 15+ turns (consider starting fresh)
- **Controller/viewer model**: first browser connection gets keyboard control, others are read-only viewers
- **Take Control** button lets viewers take over from the current controller
- **Scrollback buffer** (50KB) so late-joining browsers see recent terminal output
- **Restart** button to respawn an exited session

## Web Terminals

The supervisor can spawn and manage Claude Code sessions via PTY (pseudo-terminal). This lets you launch, view, and interact with Claude from any browser without SSH access.

### How terminals work

1. Click **+ New** in the terminal tab bar
2. Select a project from the picker (lists directories under `SUPERVISOR_PROJECT_ROOT`)
3. A Claude CLI process spawns in a PTY, and the terminal output streams to your browser via WebSocket
4. If the project doesn't have supervisor hooks, they're auto-installed before launch

### Multi-browser access

- Multiple browsers can view the same terminal simultaneously
- The first subscriber becomes the **controller** (can type)
- Others are **viewers** (read-only) until they click **Take Control**
- When the controller disconnects, the next viewer is promoted

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
- **role** is an optional description of Claude's expertise for the project. Gets inserted into the project's CLAUDE.md.

Examples:

```bash
# Basic setup
./setup-project.sh /home/user/projects/myapp

# With custom port
./setup-project.sh /home/user/projects/myapp 3848

# With role context
./setup-project.sh /home/user/projects/hvac 3847 "HVAC automation engineer"
```

The script:
1. Copies hook scripts to `.claude/hooks/`
2. Deploys `CLAUDE.md` with subagent work instructions (from `CLAUDE.md.template`)
3. Creates or merges `.claude/settings.json` with hook configuration

If CLAUDE.md already exists with supervisor instructions, it's preserved (only the role is updated if provided).

## Hook Behavior

| Hook | Script | What it does |
|------|--------|--------------|
| **PreToolUse** | `pre-tool-use.sh` | Auto-approves safe tools (Read, Glob, Grep, Task) and normal file edits. Auto-blocks destructive commands. Everything else goes to remote approval. |
| **PermissionRequest** | `permission-request.sh` | Intercepts Claude Code's built-in permission dialogs and routes them through the supervisor instead. |
| **PostToolUse** | `post-tool-use.sh` | Logs every completed tool call to the dashboard (fire-and-forget). |
| **Notification** | `notification.sh` | Forwards notifications to the dashboard and triggers `notify-send` on Linux. |
| **Stop** | `on-stop.sh` | Logs when Claude finishes a response turn. Used for turn counting. |
| **PreCompact** | `pre-compact.sh` | Auto-commits work and notifies dashboard before context compaction. |

### Auto-approve rules (in hooks, never hit the server)

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
| **`auto`** (default) | AI evaluates every tool call. High confidence (above threshold) auto-resolves. Low confidence escalates to human with recommendation. |
| **`assisted`** | AI evaluates and shows recommendation, but human must always confirm. |
| **`manual`** | No AI evaluation. Human approves everything. |

### Security Policy

The AI evaluates tool calls against `supervisor-policy.md`:

- **Always approve**: Read-only operations, standard dev commands, git read operations
- **Always deny**: System file modifications, destructive commands, secrets access, `sudo`, pipe-to-shell
- **Allowed patterns**: SSH deployment to known hosts, local network API calls (except HA — must use MCP tools)
- **Evaluate carefully**: Piped commands, docker, downloads, operations outside project directory

### Subagent Enforcement

The supervisor coaches the worker Claude to use subagents:

- **Long chained commands** (3+ `&&` operators): "Break into separate subagents"
- **Large file writes** (>150 lines): "Use a subagent for this file"
- **Sequential multi-file edits** (5+ calls across different files without Task): "Parallelize with subagents"

The deny reason is visible to the worker, which adjusts its behavior. Single-file edits, test runs, and API calls are not enforced.

### Human Override

When the AI auto-decides, the dashboard shows override buttons. Humans can reverse any AI decision.

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERVISOR_PORT` | `3847` | Server listen port |
| `SUPERVISOR_MODE` | `auto` | AI mode: `auto`, `assisted`, `manual` |
| `SUPERVISOR_MODEL` | `claude-sonnet-4-20250514` | Claude model for AI evaluations |
| `SUPERVISOR_CONFIDENCE_THRESHOLD` | `0.8` | Auto-resolve confidence threshold (0.0-1.0) |
| `SUPERVISOR_EVAL_TIMEOUT` | `60000` | Max ms for AI evaluation before timeout |
| `SUPERVISOR_MAX_CONCURRENT` | `3` | Max parallel AI evaluations |
| `SUPERVISOR_POLICY_PATH` | `./supervisor-policy.md` | Path to security policy file |
| `SUPERVISOR_PROJECT_ROOT` | `~/projects` | Parent directory for project discovery |
| `SUPERVISOR_MAX_TERMINALS` | `5` | Max concurrent web terminals |
| `SUPERVISOR_QUESTION_MODEL` | `claude-sonnet-4-20250514` | Model for AI question answering |
| `SUPERVISOR_AUTO_ANSWER_QUESTIONS` | _(unset)_ | Set to `ai` for fully unattended mode |
| `SUPERVISOR_DTACH_DIR` | `/tmp` | Directory for dtach sockets |
| `SUPERVISOR_COORDINATOR` | _(unset)_ | Set to `false` to disable coordinator |
| `SV_INSTANCE` | hostname | Coordinator instance name |
| `CLAUDE_BINARY` | `~/.local/bin/claude` | Path to claude CLI |

### Hooks (set per-project)

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_SUPERVISOR_URL` | `http://localhost:3847` | Supervisor server URL |
| `CLAUDE_SUPERVISOR_TIMEOUT` | `300` | Max seconds to wait for approval decision |

## Multi-User / Multi-Project

### Quick Start (ad-hoc)

```bash
SUPERVISOR_PORT=3847 node server.js
```

### systemd Deployment (Recommended)

The service runs directly from this git repo — no copy to `/opt`. Code changes take effect on restart.

```bash
# 1. Install systemd template + symlink node/claude (run once)
sudo ./install.sh

# 2. Add users (one instance per user, each on a unique port)
sudo ./add-user.sh simon 3847 simon//$HOME//simon/projects
sudo ./add-user.sh elena 3848 simon//$HOME//elena/projects
```

Each user gets:
- Their own dashboard at `http://localhost:<port>`
- Their own terminals, approvals, and activity log
- Automatic restart on failure
- Logs via `journalctl -u claude-supervisor@<port> -f`

### After Code Changes

```bash
sudo systemctl restart claude-supervisor@3847   # restart one
sudo systemctl restart 'claude-supervisor@*'    # restart all
```

### Management

```bash
systemctl status claude-supervisor@3847        # check status
systemctl restart claude-supervisor@3847       # restart
journalctl -u claude-supervisor@3847 -f        # follow logs
```

Per-instance config: `/etc/claude-supervisor/<port>.env`
Per-instance user override: `/etc/systemd/system/claude-supervisor@<port>.service.d/override.conf`

### Shared Server with Project Filtering

Multiple projects can share one server. Each session is labeled with its project name (from `$CLAUDE_PROJECT_DIR`). The dashboard shows project badges and a filter bar.

## Files

```
claude-supervisor/
├── server.js                 # Express + WebSocket server, AI supervisor, terminal management
├── web-ui.html               # Dashboard frontend (xterm.js, approvals, activity log)
├── supervisor-policy.md      # Security policy + subagent enforcement rules
├── CLAUDE.md.template        # Work instructions deployed to projects (auto-synced on startup)
├── claude-supervisor@.service # systemd template for multi-user deployment
├── install.sh                # Admin: install to /opt and set up systemd
├── add-user.sh               # Admin: configure a per-user instance
├── setup-project.sh          # Set up any project for supervisor (hooks + CLAUDE.md)
├── teardown-project.sh       # Remove supervisor hooks from a project
├── package.json              # Dependencies: express, ws, node-pty
└── hooks/                    # Source hook scripts (copied to projects by setup-project.sh)
    ├── pre-tool-use.sh       # Intercepts tool calls, routes to approval
    ├── permission-request.sh # Intercepts Claude's permission dialogs
    ├── post-tool-use.sh      # Logs completed tool calls
    ├── notification.sh       # Forwards notifications
    ├── on-stop.sh            # Logs response turns
    └── pre-compact.sh       # Auto-commits and notifies before compaction
```