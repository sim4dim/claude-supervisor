---
name: review-changes
description: Review all code changes since the supervisor server was last restarted. Shows commit list with diffs and recommends whether a restart is worthwhile. Use when user says "what changed", "should I restart", "pending changes", "is a restart worth it", or "what's new in the code". Use before deciding to restart the supervisor.
context: fork
agent: researcher
effort: max
---

Review code changes since the supervisor server was last restarted and give a restart recommendation.

## Steps

1. Fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/version/pending` to get the startup commit hash and pending commit list.

2. If no pending commits: report "Server is up to date — no restart needed." and stop.

3. Extract `startupCommit` from the response, then run:
   - `git log --oneline <startupCommit>..HEAD` — list all commits since startup
   - `git diff <startupCommit>..HEAD --stat` — see which files changed

4. Categorize changed files:
   - `server.js` — backend logic (affects running behavior; sessions survive via dtach)
   - `web-ui.html` — UI (cached at startup; **must restart** to pick up changes)
   - `bin/sv` — sv helper (takes effect immediately; no restart needed)
   - `start-*.sh` — startup config (takes effect on next restart)
   - other files — note what they are

5. Assess impact:
   - UI-only (`web-ui.html`): restart required
   - `server.js`: restart replaces running server logic; dtach sessions survive
   - `bin/sv` only: no restart needed
   - Mixed: describe which components are affected

6. Give one clear recommendation:
   - "Restart now — UI changes are cached and won't appear until restart"
   - "Restart recommended — server.js changes affect running behavior"
   - "Can wait — only bin/sv or config changes, no user-facing impact yet"
   - "Restart at next convenient time — mixed changes, not urgent"

Show commit list and file stats, then categorization, then recommendation. No lengthy prose.
