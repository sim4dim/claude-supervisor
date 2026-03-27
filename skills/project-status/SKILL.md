---
name: project-status
description: Quick health check showing git status, running sessions, pending changes, and recent agent activity. Use when user says "what's going on", "project status", "where are we", "show me what's running", "orientation", or "what's the state of". Also useful at the start of a session before making decisions.
context: fork
agent: Explore
effort: low
---

Run a quick project health check and report the results concisely.

## Steps

1. Run `git status` to see uncommitted changes.
2. Run `git log --oneline -5` to see recent commits.
3. Fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/state` to get: running terminal sessions, pending approvals, and recent agent messages.
4. Fetch `http://localhost:${SUPERVISOR_PORT:-3847}/api/version/pending` to see commits made since the server last started.

## Output format

Bullet points only — no prose:

- **Uncommitted changes**: list modified/untracked files, or "none"
- **Recent commits**: last 5 commit messages
- **Active sessions**: list running terminal sessions by name
- **Pending approvals**: count and brief description of what is waiting
- **Pending restart changes**: count of commits since server start, brief description
- **Recent agent activity**: last 3-5 agent messages if any

If nothing notable in a category, say "none" and move on.
