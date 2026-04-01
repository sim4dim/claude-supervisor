# Defer + Resume Approval Integration Design

## Overview

Claude Code v2.1.85+ added a `defer` permission decision for PreToolUse hooks in headless
(`-p` / `--print`) mode. When a hook returns `{"permissionDecision": "defer"}`, the headless
session suspends. It can be resumed with `claude -p --resume <session-id>`, which re-runs the
hook — allowing the hook to return a real allow/deny on the second pass.

This document describes how `defer` integrates with the supervisor's existing MQTT-based
approval flow, why it is useful, and what the migration path looks like.

---

## Current Approval Flow

```
PreToolUse hook runs
  │
  ├─ Hard deny? → return {"permissionDecision":"deny"} immediately
  ├─ Auto-approve? → return {"permissionDecision":"allow"} immediately
  │
  └─ Needs review:
       │
       POST /api/hook/approval  (includes tool, summary, session_id, raw_input)
       │
       Server stores pending approval, triggers AI evaluation in background
       │
       Hook polls GET /api/hook/decision/:id every 2s
       │                    ↑
       │         (session is BLOCKED here — Claude pauses waiting)
       │
       AI auto-resolves OR human approves/denies in web UI / MQTT message
       │
       Poll returns {status:"approved"} or {status:"denied"}
       │
       Hook returns allow/deny JSON → session continues or stops
```

**Problem with current flow:** The session process is blocked for up to 300 seconds in a
tight poll loop. The process holds a dtach terminal slot and consumes memory while waiting.
For headless (`-p`) subagents this is especially wasteful — they have no interactive terminal
and may be running many in parallel.

---

## Proposed Flow with Defer

```
PreToolUse hook runs
  │
  ├─ Hard deny? → return {"permissionDecision":"deny"} immediately
  ├─ Auto-approve? → return {"permissionDecision":"allow"} immediately
  │
  └─ Needs review + running in headless mode:
       │
       POST /api/hook/approval  (includes tool, summary, session_id, project)
       │                        NOTE: also sends defer=true flag
       │
       Hook returns {"permissionDecision":"defer"} immediately
       │                    │
       Session SUSPENDS ────┘    (no more CPU/memory used while waiting)
       │
       Server stores deferred approval with session_id
       Server triggers AI evaluation in background
       │
       AI auto-resolves OR human decides in web UI
       │
       Server calls: claude -p --resume <session-id>
       │
       Session RESUMES, PreToolUse hook runs again
       │
       Hook detects "this is a resume" (approval already decided)
       GET /api/hook/decision/:id → immediate result
       │
       Hook returns allow/deny → session continues
```

**Benefit:** The headless session suspends cleanly instead of polling for minutes.
Multiple deferred sessions can be reviewed in parallel without holding up CPU.

---

## Detecting Headless Mode

The hook detects headless mode via:

1. `CLAUDE_IS_SUBAGENT` env var — set by Claude Code when a session is spawned via the
   Task tool (always headless)
2. Stdin is not a TTY (`[ ! -t 0 ]`) — reliable for `-p` / `--print` invocations
3. Explicit opt-in: `CLAUDE_DEFER_APPROVALS=1` env var

In interactive terminal sessions, the current polling flow is kept — `defer` is only used
when it is safe to suspend the session.

---

## Resume Flow Detail

When the supervisor resolves a deferred approval, it must call:

```bash
claude -p --resume <session-id>
```

This is done from a new `/api/hook/resume` endpoint. The endpoint:
1. Looks up the deferred approval by approval ID
2. Finds the Claude session process (via `sessions` map / project directory mapping)
3. Runs `claude -p --resume <session-id>` in the project directory
4. The resumed session re-runs the PreToolUse hook
5. The hook fetches the (now decided) approval and returns allow/deny immediately

---

## Hook State Machine

```
First call (pre-defer):
  lookup approval_id from server → none → POST new approval → return defer

Second call (post-resume):
  server has CLAUDE_DEFER_APPROVAL_ID in the resume environment, OR
  hook detects recent deferred approval for this session_id
  → GET /api/hook/decision/:id → already decided → return allow/deny
```

The hook passes the session_id in both calls. The server correlates them.

---

## Edge Cases and Mitigations

### 1. `claude --resume` not available (older Claude Code versions)
**Mitigation:** The hook checks `claude --version` or the supervisor checks at startup.
If `--resume` is not available, fall back to the polling flow for all sessions.
Flag: `CLAUDE_DEFER_AVAILABLE` (set by server, read by hook via /api/hook/capabilities).

### 2. Deferred session never resumed (server restart, crash)
**Mitigation:**
- Server restart: on startup, scan for deferred approvals and auto-deny them (session
  can't be resumed after a server restart since PIDs change)
- Server crash: the suspended session eventually times out on its own (Claude Code has
  an internal timeout for deferred sessions, exact value TBD)
- Operator action: web UI shows deferred sessions with a manual "Resume" button

### 3. Multiple tool calls deferred at once (parallel subagents)
**No issue.** Each has a distinct session_id. The server tracks each independently.
Resuming session A does not affect session B.

### 4. Approval decided while session already timed out
**Mitigation:** The `claude --resume` command will return an error if the session is gone.
The server catches this and marks the approval as `expired`.

### 5. Interactive session accidentally using defer
**Mitigation:** The hook only defers when headless mode is detected (see above).
Interactive sessions keep the current polling flow.

### 6. Approval auto-decided by AI before resume
**This is the happy path.** The AI evaluates in milliseconds, marks it approved/denied,
then the server immediately calls `--resume`. The hook's second pass returns instantly.

---

## Migration Path

### Phase 1 (implemented): Awareness
- Hook has a `defer_approval()` function and `is_headless_mode()` check
- Actual defer is gated behind `CLAUDE_DEFER_APPROVALS=1` (opt-in only)
- Server has `/api/hook/resume` endpoint ready but not called automatically

### Phase 2: Server-side resume
- Server calls `claude -p --resume` after resolving any deferred approval
- Deferred approvals shown distinctly in web UI (suspended badge)
- Defer enabled by default for headless sessions

### Phase 3: Full integration
- Remove polling path for headless sessions entirely
- Monitor `defer`-resume latency vs. old poll latency in eval-history.jsonl
- If performance is better, consider defer for interactive sessions too

---

## Implementation Notes

### Hook changes (hooks/pre-tool-use.sh)
- Add `is_headless_mode()` function
- Add `defer_approval()` function: POSTs to `/api/hook/approval` with `defer=true`,
  returns `{"permissionDecision":"defer"}` JSON
- In the "needs review" path: if headless and defer available, call `defer_approval()`
- On second pass (resume): detect via stored approval ID and return decision immediately

### Server changes (server.js)
- Track deferred approvals: `deferredApprovals` Map: `session_id → approval_id`
- Add `/api/hook/resume` endpoint: accept `{approval_id}`, run `claude -p --resume`
- Auto-call resume after AI or human decision if approval was marked `defer=true`
- Web UI: show deferred sessions with visual indicator

### Environment variables
- `CLAUDE_DEFER_APPROVALS=1` — opt in to defer mode (default: off until Phase 2)
- `CLAUDE_DEFER_APPROVAL_ID` — set by resume to tell hook which approval to check
