---
name: restart-server
description: Restart the supervisor server to pick up code changes. Use when user says "restart the server", "restart supervisor", "pick up changes", or "reload server". Shows what will change, warns about losses, confirms with user, then restarts.
disable-model-invocation: true
effort: medium
---

Restart the supervisor server safely. Follow these steps in order.

## Step 1: Check for pending changes

Fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/version/pending`.

- If there are **0 pending commits**: tell the user "Server is already up to date — no restart needed." and **stop here**.
- If there are pending commits: display:
  - How many commits are pending
  - The commit messages (brief list)
  - Which files changed

## Step 2: Show active sessions

Fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/state` and list the active terminal sessions by name. Reassure the user that dtach keeps terminal sessions alive through a server restart — Claude processes continue running.

## Step 3: Warn about losses

Tell the user clearly:
- Pending approval requests will be lost on restart
- Pending AskUserQuestion dialogs will be lost on restart
- Chat room state and agent messages in memory will be cleared

## Step 4: Ask for confirmation

Ask the user: "Ready to restart? (yes/no)"

Wait for their response. If they say no or anything other than yes/y, cancel and say "Restart cancelled."

## Step 5: Run the restart

Determine the service name:
- Use the service name configured for this installation (e.g., `supervisor-<username>` or as set in your systemd setup)

First check if systemd is managing the service: `systemctl is-enabled <service-name>`.
- If enabled: run `sudo systemctl restart <service-name>`
- If not enabled (fallback): run the start script at `$HOME/projects/claude-supervisor/start.sh` or the path configured during installation

Note: `sudo` may be blocked by hooks. If so, tell the user to run the systemctl command manually in a separate terminal.

## Step 6: Verify

Wait 2 seconds, then fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/state`. If you get a valid response, report "Server restarted successfully." If not, report "Server may still be starting — check the supervisor terminal."

**Note:** You cannot restart the server from within the supervisor web UI terminal because killing the server kills the hook evaluator that would approve the restart command. Use a separate terminal or this skill from a project session instead.