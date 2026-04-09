# Pensive — Supervisor-Level Memory System Design

> *"One simply siphons the excess thoughts from one's mind, pours them into the basin, and examines them at one's leisure."*
> — Albus Dumbledore

## Overview

Every Claude session currently starts with amnesia. Discoveries made by subagents on Monday are
invisible to the session that resumes Thursday. Cross-project patterns — the same Postgres
connection-limit issue discovered in three different projects — live as scattered `.md` files
that nobody aggregates.

**Pensive** is a shared basin where memories from all projects are collected, examined, and
cross-referenced. Named after the magical artefact in Harry Potter: a basin where memories
are deposited with full provenance, examined later, and cross-referenced across contributors.

Unlike the existing per-project `MEMORY.md` files (flat markdown, manually maintained, no
decay, no relationships), Pensive is:

- **Persistent** — SQLite on disk, survives server restarts
- **Queryable** — FTS + tag filtering, no vector DB needed
- **Automatic** — discovery MQTT messages auto-persist; hooks feed it on session start/stop
- **Temporal** — vitality scores decay; stale memories are archived, not deleted
- **Cross-project** — memories from any project are accessible everywhere
- **Provenance-aware** — every memory records project, session, agent, and timestamp

---

## Motivation

### Current Pain Points

1. **Amnesia on wake-up**: SessionStart hook injects a progress snapshot, but it only covers
   the last session's git state. Institutional knowledge (e.g., "auth tokens expire in 1h,
   not 24h as documented") is lost across compactions and session restarts.

2. **Scattered discoveries**: `sv pub discovery` messages appear in the web UI's agent message
   feed but are not persisted beyond the in-memory `agentMessages` buffer (capped at
   `MAX_AGENT_MESSAGES`). They vanish on server restart.

3. **No cross-project pattern detection**: The same infrastructure issue — wrong port,
   flaky dependency, deprecated API — gets rediscovered independently in every project.

4. **Manual MEMORY.md maintenance**: Writing memory entries requires explicit agent effort.
   Most sessions don't do it. The rebuild-memory-index.sh script is rarely run.

5. **No vitality / decay**: Old entries in `MEMORY.md` become stale. There is no mechanism
   to mark them as superseded, to decay their relevance score, or to archive them when
   no longer applicable.

### Design Goals

| Goal | How Pensive Achieves It |
|------|------------------------|
| Zero friction for agents | Auto-capture `sv pub discovery` via MQTT listener |
| Startup context without bloat | Compact injection: top-10 memories in ~300 tokens |
| Cross-project intelligence | Global recall across all projects |
| Temporal validity | Vitality decay + archival, not deletion |
| No external dependencies | SQLite (already on system), FTS5 extension |
| Queryable from anywhere | REST API + CLI |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PENSIVE SYSTEM                               │
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                    WRITE PATH                                  │   │
│  │                                                               │   │
│  │  sv pub discovery "fact"  ─────────────────────────────────► │   │
│  │  MQTT supervisor/#        ──► MQTT Listener ──► dedup ──►    │   │
│  │                                                   │           │   │
│  │  sv remember "fact" --type decision               │           │   │
│  │  REST POST /api/pensive/memories ─────────────────┤           │   │
│  │                                                   │           │   │
│  │  PreCompact hook (session ending)                 │           │   │
│  │  Stop hook (abnormal exit)        ────────────────┤           │   │
│  │                                                   ▼           │   │
│  │                                            ┌──────────────┐  │   │
│  │                                            │ Write Guard  │  │   │
│  │                                            │ (dedup check)│  │   │
│  │                                            └──────┬───────┘  │   │
│  │                                                   │           │   │
│  └───────────────────────────────────────────────────┼───────────┘   │
│                                                       ▼               │
│                                         ┌─────────────────────────┐  │
│                                         │   SQLite (pensive.db)   │  │
│                                         │   node:sqlite (built-in)│  │
│                                         │                         │  │
│                                         │  memories (Phase 1)     │  │
│                                         │  memories_fts (FTS5)    │  │
│                                         │  [tags/relations: Ph.2] │  │
│                                         └─────────────────────────┘  │
│                                                       ▲               │
│  ┌────────────────────────────────────────────────────┼───────────┐   │
│  │                    READ PATH                        │           │   │
│  │                                                     │           │   │
│  │  SessionStart hook                                  │           │   │
│  │  sv recall --startup ──────────────────────────────►           │   │
│  │                                                     │           │   │
│  │  sv recall "postgres limits" ──────────────────────►           │   │
│  │  sv recall --global "deploy"  ─────────────────────►           │   │
│  │                                                     │           │   │
│  │  REST GET /api/pensive/recall ──────────────────────►           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │                  LIFECYCLE (background)                        │     │
│  │                                                               │     │
│  │  Vitality decay cron (hourly)                                 │     │
│  │  Cross-project pattern detector (on write)                    │     │
│  │  Archive sweep (daily)                                        │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │                  WEB UI PANEL                                  │     │
│  │                                                               │     │
│  │  Recent memories feed  │  Search  │  Project filter           │     │
│  │  Relationship graph    │  Stats   │  Decay preview            │     │
│  └───────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Memory Scopes: World vs. Project

Every memory belongs to one of two scopes. The `scope` column in the schema makes this
explicit.

### World Memories (`scope = 'world'`)

Cross-project, overarching concepts not tied to any single project. World memories are
stored with `project = '_world'`. They load on every session start regardless of the active
project.

Examples:
- **User preferences and working style** — "prefers terse responses", "always use subagents"
- **Infrastructure facts** — "postgres on 10.0.1.5 has 100 connection limit"
- **Deployment patterns** — "always deploy auth-service before web-app"
- **Tool conventions** — "use node:sqlite not better-sqlite3"
- **Architectural principles** the user follows across all projects
- **Cross-project patterns** — "three projects hit the same MQTT reconnect bug"

### Project Memories (`scope = 'project'`)

Specific to a single project. Stored with the project's basename as the `project` value.
Only loaded at startup for sessions in that project.

Examples:
- **API behaviours** — "getUserById returns null not exception"
- **Code decisions** — "chose JWT over session cookies because TTL semantics needed"
- **Bugs and fixes** — "the FD leak was caused by unclosed dtach sockets"
- **Project-specific conventions** — naming rules, directory layout expectations

### Scope Rules

- `sv remember --world` sets `scope = 'world'` and `project = '_world'`
- `sv remember` (no flag) sets `scope = 'project'` and `project = <current>`
- Recall with `--world` searches only `scope = 'world'`
- Recall without flags searches `scope = 'project'` for the current project **plus** all
  `scope = 'world'` memories

World memories replace any previous approach to cross-project memory (tags, global queries,
the `cross_project` memory type is now just a flavour of world memory).

---

## Tiered Retrieval

Rather than a flat "top N by vitality" query, Pensive uses four retrieval tiers. Each tier
has a fixed token budget and a distinct loading trigger.

### L0 — Identity Layer (~50 tokens)

Loaded on **every session start**, always. Contains who the user is, their role, and key
preferences. Stored as a single compressed `tier = 'L0'` world memory. Think of it as a
system-prompt extension: it never changes often and it orients the LLM before any
project-specific context arrives.

Example L0 content (compact form):
```
USER:simon role=eng | style=terse,delegate,kebab_task_ids | always_subagents=true
```

### L1 — World Memory Layer (~200 tokens)

Loaded on **every session start**. Contains critical cross-project facts in shorthand-compressed
format: infrastructure topology, deployment conventions, tool choices. Filtered to
`scope = 'world'` and `vitality > 0.5`, sorted by `vitality × recency`, capped at ~200
tokens worth of compact forms.

### L2 — Project Memory Layer (variable, ~500 tokens max)

Loaded on **session start, filtered by current project**. Contains top memories for the
active project by `vitality × recency`, plus any world memories whose tags overlap the
project's domain tags (e.g., a postgres infra fact tagged `database` loads for projects
tagged `database` even if it's a world memory). Cap: 500 tokens of compact forms.

### L3 — Full Search Layer (on-demand)

Triggered **only by explicit `sv recall "query"`**. No automatic loading. Searches across
all scopes and all projects. Returns ranked results with provenance. This is the "pull"
layer — it does not add to startup cost.

### Startup Budget

The SessionStart hook calls L0 + L1 + L2 in sequence. Total token budget: **~750 tokens
max**. L3 is pull-only and never fires at startup.

```
Session start injection = L0 (~50) + L1 (~200) + L2 (~500) ≤ 750 tokens
```

The `tier` column on each memory row records which tier it belongs to. The server uses this
during startup retrieval: `WHERE tier IN ('L0', 'L1')` for world memories, `WHERE tier = 'L2'`
filtered by project for project memories.

---

## Shorthand Compression

Pensive stores two forms of every memory: the full prose `content` and an shorthand
`compact_form`. The compact form is what gets injected at startup (L0, L1, and top L2
entries).

### What Is Shorthand Compression?

A structured shorthand designed for LLM consumption, not human reading. It uses a sparse
key=value notation with `|` separators and domain-prefix tokens. It is generated at
**write time by the server** (via Claude Haiku), not by agents.
Agents write prose; the server compresses.

Target compression ratio: **~30x**. A 500-token English paragraph becomes ~15–20 tokens of
structured shorthand.

### Example

```
Full:
  "The PostgreSQL database running on server 10.0.1.5 has a maximum connection limit of 100
   concurrent connections. We discovered this during the March load test when the connection
   pool was exhausted and new requests started timing out after 30 seconds."

Shorthand:
  "INFRA:pg@10.0.1.5 max_conn=100 | found:load_test_mar | fail_mode:pool_exhaust→timeout_30s"
```

### Tier Usage

| Tier | Uses `compact_form` | Uses `content` |
|------|---------------------|----------------|
| L0   | Always              | Never at startup |
| L1   | Always              | Available via L3 |
| L2   | Top entries only    | Full content via L3 |
| L3   | Shows both          | Shown in full    |

### Notation Header

A brief 30-token notation guide is injected once per session alongside L0:

```
[Shorthand notation: TYPE:key=val | pipe=separator | arrow=causes/leads-to | ?=uncertain]
```

This primes the LLM to interpret compact forms correctly before the L1 and L2 blocks arrive.

### Server-Side Generation

When `compact_form` is NULL at write time:
1. The server calls the `SUPERVISOR_FAST_MODEL` (haiku) to generate a compact form
   asynchronously after the write completes.
2. Until the async generation finishes, the server uses a 100-character truncation of
   `content` as a placeholder.
3. Agents may provide a hand-crafted compact form via `--compact` flag on `sv remember`;
   if provided, server generation is skipped.

---

## Database Schema

```sql
-- SQLite + FTS5 (node:sqlite — zero new npm dependencies).
-- File location: $SUPERVISOR_DATA_DIR/pensive.db
-- or alongside server.js: ./data/pensive.db

PRAGMA journal_mode = WAL;   -- allows concurrent readers during writes
PRAGMA foreign_keys = ON;

-- ─── Core memory table ───────────────────────────────────────────────────────
-- Single table for Phase 1. Relations, tags, and access-log tables are Phase 2.

CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,        -- UUID v4
    content       TEXT NOT NULL,           -- full prose content of the memory
    compact_form  TEXT,                    -- shorthand compressed form (~30x shorter)
                                           -- e.g. "INFRA:pg@10.0.1.5 max_conn=100"
    memory_type   TEXT NOT NULL,           -- see vocabulary below
    content_type  TEXT NOT NULL DEFAULT 'architectural',
                                           -- 'architectural' | 'implementation'
                                           -- used by priming-risk filter; prefer architectural
    scope         TEXT NOT NULL DEFAULT 'project'
                  CHECK(scope IN ('world', 'project')),
                                           -- 'world' = cross-project; 'project' = single project
    tier          TEXT NOT NULL DEFAULT 'L2'
                  CHECK(tier IN ('L0', 'L1', 'L2', 'L3')),
                                           -- retrieval tier (see Tiered Retrieval section)
    project       TEXT NOT NULL,           -- source project basename, or '_world' for world scope
    session_id    TEXT,                    -- CLAUDE session ID that produced this memory
    agent_id      TEXT,                    -- SV_TASK_ID of the producing agent/subagent
    source        TEXT NOT NULL DEFAULT 'manual',
                                           -- 'mqtt_discovery' | 'sv_remember' | 'hook_compact'
                                           -- | 'hook_stop' | 'manual' | 'cross_project'
    vitality      REAL NOT NULL DEFAULT 1.0,
                                           -- 0.0–1.0; decays over time; boosted on access
    status        TEXT NOT NULL DEFAULT 'active',
                                           -- 'active' | 'archived' | 'superseded' | 'contradicted'
    created_at    TEXT NOT NULL,           -- ISO 8601 UTC
    updated_at    TEXT NOT NULL,           -- ISO 8601 UTC
    last_accessed TEXT,                    -- ISO 8601 UTC (updated on every recall hit)
    access_count  INTEGER NOT NULL DEFAULT 0,
    tags          TEXT NOT NULL DEFAULT '[]',
                                           -- JSON array of strings, e.g. '["postgres","database"]'
                                           -- (denormalised for Phase 1; normalised in Phase 2)
    raw_payload   TEXT                     -- original JSON from MQTT (for mqtt_discovery source)
);

-- Memory type vocabulary:
--   discovery     — a finding an agent made that wasn't in the prompt
--   decision      — a choice made (option A over B, because reason)
--   preference    — user/project preference (style, workflow, tool choice)
--   fact          — stable factual claim (IP address, API endpoint, config value)
--   error         — a past mistake or failure mode to avoid
--   infrastructure— host, port, service, environment topology
--   convention    — tool choice, naming, deployment-order rules (often world-scoped)
--   cross_project — synthesised from multiple-project pattern detection (world-scoped)

-- ─── Full-text search virtual table ─────────────────────────────────────────
-- NOTE: FTS5 content-table shadow mode uses INTEGER rowid, not TEXT id.
-- Triggers below use new.rowid / old.rowid, NOT new.id. The dedup query must
-- join back to memories on rowid, not on id, to avoid TEXT vs INTEGER mismatch.

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    compact_form,
    project   UNINDEXED,
    content='memories',      -- shadow table; rows kept in sync by triggers below
    tokenize='unicode61 remove_diacritics 1'
);

-- Keep FTS in sync with inserts and updates
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, compact_form, project)
    VALUES (new.rowid, new.content, coalesce(new.compact_form, ''), new.project);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, compact_form, project)
    VALUES ('delete', old.rowid, old.content, coalesce(old.compact_form, ''), old.project);
    INSERT INTO memories_fts(rowid, content, compact_form, project)
    VALUES (new.rowid, new.content, coalesce(new.compact_form, ''), new.project);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, compact_form, project)
    VALUES ('delete', old.rowid, old.content, coalesce(old.compact_form, ''), old.project);
END;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS memories_scope_project  ON memories(scope, project);
CREATE INDEX IF NOT EXISTS memories_tier           ON memories(tier);
CREATE INDEX IF NOT EXISTS memories_status_vitality ON memories(status, vitality);

-- ─── Hard-delete policy ──────────────────────────────────────────────────────
-- Run weekly (not on every decay sweep). Permanently removes rows that have
-- been archived for more than 90 days.

-- DELETE FROM memories WHERE status = 'archived' AND updated_at < datetime('now', '-90 days');
```

### Correct FTS5 Dedup Query

The dedup similarity search must join via `rowid`, not `id`. TEXT id vs INTEGER rowid is
a common FTS5 footgun:

```sql
-- CORRECT: join on rowid
SELECT m.id, m.content
FROM memories m
JOIN (
    SELECT rowid FROM memories_fts
    WHERE memories_fts MATCH ?
    LIMIT 10
) fts ON m.rowid = fts.rowid
WHERE m.status = 'active';

-- WRONG (silently returns no rows if id is TEXT):
-- SELECT id FROM memories WHERE id IN (SELECT rowid FROM memories_fts WHERE ...)
```

### Vitality Decay Formula

```
vitality_new = vitality_old × e^(−λ × days_since_last_access)

λ = 0.02  (default — half-life ≈ 35 days)

On each recall hit that returns this memory:
    vitality = min(1.0, vitality + 0.15)

On explicit confirmation (sv pensive confirm <id>):
    vitality = min(1.0, vitality + 0.30)

Archive threshold: vitality < 0.10
```

Memories for `fact`, `infrastructure`, and `preference` types use a slower λ of 0.005
(half-life ≈ 139 days) because they are less likely to become stale.

---

## Write Path

### 1. Automatic — MQTT Discovery Listener

The supervisor server already subscribes to `supervisor/#`. In the existing MQTT handler
(around line 4588 in server.js), messages with `msgType === "discovery"` are captured into
`agentMessages`. Pensive extends this:

```javascript
// After pushing to agentMessages buffer (existing code):
if (msgType === "discovery") {
    pensivedWrite({
        content:     safePayload.finding,
        memoryType:  "discovery",
        scope:       "project",             // MQTT discoveries are project-scoped by default
        project,
        sessionId:   safePayload.session_id || null,
        agentId:     taskId,
        source:      "mqtt_discovery",
        tags:        safePayload.tags || [],
        rawPayload:  rawPayload,
        compactForm: null,                  // generated async by server after write
    });
}
```

`pensivedWrite()` is async, non-blocking. It runs the dedup check and inserts (or boosts)
in the background without blocking the MQTT handler.

### 2. Explicit — sv remember

```bash
sv remember "postgres on 10.0.1.5 has 100 connection limit" \
    --type infrastructure \
    --tags "database,postgres" \
    --project auth-service    # optional, defaults to current project
```

The `sv` CLI sends a `POST /api/pensive/memories` request. Tags are comma-separated or
can be repeated (`--tags foo --tags bar`). The server validates `memory_type` against the
allowed vocabulary.

### 3. Hook-Driven — PreCompact and Stop Hooks

**PreCompact hook** (fires before context compaction): After writing the progress snapshot,
the hook additionally POSTs any pending discoveries collected during the session. Since hooks
can't query Claude during compaction, the hook instead forwards the raw `agentMessages` for
the current project that arrived during this session window. The server's Pensive writer
processes them idempotently (dedup by content hash).

```bash
# Added to pre-compact.sh, after existing snapshot code:
curl -s --max-time 5 \
    -X POST "${SUPERVISOR_URL}/api/pensive/flush-session" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "{\"session_id\": \"$SESSION_ID\", \"project\": \"$PROJECT\"}" \
    >/dev/null 2>&1 || true
```

**Stop hook** (fires on abnormal session end, not on every end_turn): Same flush call, with
`stop_reason` included so the memory type can be tagged appropriately.

### Write Guard — Dedup Check

Before inserting, the server checks for near-duplicates:

```sql
-- Step 1: exact content hash match (fastest)
SELECT id FROM memories
WHERE project = ? AND status = 'active'
  AND lower(hex(sha256(content))) = lower(hex(sha256(?)));

-- Step 2: FTS similarity (if no exact match)
SELECT id, content FROM memories
WHERE status = 'active'
  AND id IN (
      SELECT rowid FROM memories_fts
      WHERE memories_fts MATCH ?   -- tokenised query from new content
      LIMIT 10
  );
```

SQLite does not have a built-in SHA-256 function, so the server computes the hash in
JavaScript before the query. For FTS similarity, the server tokenises the incoming content
into keywords (splitting on whitespace and punctuation, removing stopwords) and runs an FTS
match. If a result returns with Jaccard similarity > 0.7 against the incoming content, it is
treated as a duplicate and the existing record's vitality is boosted instead of inserting.

The similarity threshold is intentionally conservative: it is better to store a near-duplicate
than to discard a genuinely new finding.

---

## Read Path

### 1. Startup Injection — SessionStart Hook

```bash
# Added to session-start.sh, after existing handoff/snapshot code:
PENSIVE_CONTEXT=$(curl -s --max-time 5 \
    "${SUPERVISOR_URL}/api/pensive/recall" \
    -G \
    --data-urlencode "project=${PROJECT}" \
    --data-urlencode "startup=true" \
    -H "$(_sv_auth_header)" 2>/dev/null || echo "")

if [ -n "$PENSIVE_CONTEXT" ] && [ "$PENSIVE_CONTEXT" != "null" ] && [ "$PENSIVE_CONTEXT" != "[]" ]; then
    echo "=== Pensive Memory (L0+L1+L2 for project: $PROJECT) ==="
    echo ""
    echo "$PENSIVE_CONTEXT"
    echo ""
    echo "=== End Pensive Memory ==="
    echo ""
fi
```

The `startup=true` parameter triggers tiered retrieval: the server returns L0 + L1 + L2
blocks in order. Each block uses `compact_form` exclusively. The response also includes a
one-line Shorthand notation header (~30 tokens) before the L0 content. Total budget: ~750 tokens
max. If `compact_form` is NULL for any entry, the server falls back to a 100-char truncation
of `content`.

Example compact injection:

```
=== Pensive Memory (L0+L1+L2 for project: claude-supervisor) ===

[Shorthand notation: TYPE:key=val | pipe=separator | arrow=causes/leads-to | ?=uncertain]

--- L0: Identity ---
USER:simon role=eng | style=terse,delegate,kebab_task_ids | always_subagents=true

--- L1: World ---
INFRA:pg@10.0.1.5 max_conn=100 | found:load_test_mar | fail_mode:pool_exhaust→timeout_30s
CONV:deploy_order=auth-service→web-app
CONV:sqlite_pkg=node:sqlite (not better-sqlite3)
PREF:task_ids=kebab-case | PREF:responses=terse
CROSS:mqtt_reconnect_bug hit 3 projects | fix:reconnect_delay+backoff

--- L2: Project (claude-supervisor) ---
[discovery/2026-03-25] auth_token TTL=1h (not 24h docs wrong) (auth.js:88)
[decision/2026-03-19] defer/resume only for headless sessions — polling kept for TTY
[infra/2026-03-10] INFRA:elena_account symlinks→$HOME/.claude
[error/2026-03-18] npm run build fails if NODE_ENV not set — add to .env.example
[discovery/2026-03-20] getUserById returns null not exception (users.js:45)

=== End Pensive Memory ===
```

### 2. On-Demand — sv recall

```bash
sv recall "postgres connection limits"           # search current project + world
sv recall --world "deployment order"             # search world memories only
sv recall --global "deployment"                  # L3 search: all projects, all scopes
sv recall --project auth-service "user lookup"   # specific project
sv recall --startup                              # get L0+L1+L2 compact injection
sv recall --type infrastructure "postgres"       # filter by type
sv recall --tags "postgres,database"             # filter by tags
```

The `sv recall` command calls `GET /api/pensive/recall` and prints results to stdout. In a
subagent context this is typically piped into the agent's context or written to a temp file.

Relevance ranking:

```
score = vitality × recency_factor × fts_rank × type_weight

recency_factor = 1 / (1 + days_since_created / 30)
type_weight    = 1.2 for fact/infrastructure/preference (higher stability)
               = 1.0 for discovery/decision/error
               = 1.3 for cross_project (rare, high value)
```

### 3. Cross-Project — Global Search

When `--global` is passed, the query removes the `project =` filter and searches across all
projects. Results include the source project in the compact form prefix (e.g.
`[auth-service/infra/2026-03-10]`).

---

## Supervisor Server Integration

### New Module: pensive.js

The Pensive logic lives in a dedicated module imported by server.js:

```
$HOME/projects/claude-supervisor/
└── pensive.js        ← new module: DB init, pensivedWrite(), recall(), decay()
```

Initialised at startup:

```javascript
import { initPensive, pensivedWrite, pensiveRecall, runDecay } from "./pensive.js";

// In main startup sequence:
await initPensive(resolve(__dirname, "data/pensive.db"));
```

### REST API: /api/pensive/*

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/pensive/memories` | Create a memory (explicit `sv remember`) |
| `GET`  | `/api/pensive/recall` | Search/retrieve memories |
| `GET`  | `/api/pensive/memories/:id` | Get a single memory with relationships |
| `PATCH`| `/api/pensive/memories/:id` | Update status, compact form, or tags |
| `POST` | `/api/pensive/memories/:id/relate` | Link two memories |
| `POST` | `/api/pensive/memories/:id/supersede` | Mark as superseded + create replacement |
| `POST` | `/api/pensive/flush-session` | Flush session discoveries (called by hooks) |
| `GET`  | `/api/pensive/stats` | DB stats for web UI panel |
| `POST` | `/api/pensive/decay` | Trigger manual decay sweep (also runs on cron) |
| `GET`  | `/api/pensive/decay` | Preview decay (dry run) |
| `GET`  | `/api/pensive/patterns` | Cross-project pattern detection results |

#### GET /api/pensive/recall — Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | — | Full-text search query |
| `project` | string | current | Filter by project (`*` or omit for global) |
| `scope` | string | — | `world` to restrict to world memories only |
| `global` | boolean | false | L3 search: all projects, all scopes |
| `type` | string | — | Filter by memory_type |
| `tags` | string | — | Comma-separated tag filter |
| `status` | string | `active` | `active`, `archived`, `all` |
| `limit` | integer | 10 | Max results (cap: 50) |
| `format` | string | `full` | `full` or `compact` (returns compact_form field) |
| `startup` | boolean | false | Returns tiered L0+L1+L2 startup injection block |

#### POST /api/pensive/memories — Request Body

```json
{
    "content":      "postgres on 10.0.1.5 has a 100-connection limit",
    "compact_form": "INFRA:pg@10.0.1.5 max_conn=100",
    "memory_type":  "infrastructure",
    "scope":        "world",
    "project":      "_world",
    "agent_id":     "fix-auth-bug",
    "tags":         ["database", "postgres", "infrastructure"],
    "source":       "sv_remember"
}
```

`compact_form` is optional at write time. If omitted, the server generates it
asynchronously via `SUPERVISOR_FAST_MODEL`. Until then a 100-char truncation of `content`
serves as a placeholder. Agents may provide a hand-crafted compact form via `--compact`.

`scope` defaults to `'project'`. When `--world` is passed via `sv remember`, scope is
set to `'world'` and project is set to `'_world'`.

### Web UI — Pensive Panel

The web UI gains a new tab/panel. It is a read-heavy view. Key elements:

```
┌─────────────────────────── PENSIVE ─────────────────────────────────┐
│  Search: [________________]  Project: [all ▼]  Type: [all ▼]  [Go]  │
│  Stats: 142 active  |  28 archived  |  5 cross-project patterns      │
├──────────────────────────────────────────────────────────────────────┤
│ [auth/discovery/2026-03-25] ●●●●○ (v:0.85)                          │
│ getUserById returns null not exception (users.js:45)                 │
│ Project: auth-service  Agent: fix-auth-bug  Tags: auth,users         │
│ [superseded by ↗] [relate to ↗] [confirm ✓] [archive ✗]            │
├──────────────────────────────────────────────────────────────────────┤
│ [claude-supervisor/infra/2026-03-15] ●●●●● (v:0.97)                 │
│ postgres on 10.0.1.5 — 100 connection limit; route through pgBouncer │
│ Project: claude-supervisor  Agent: db-audit  Tags: postgres,database  │
│ [relate: auth-service/infra/2026-03-10] [confirm ✓]                  │
├──────────────────────────────────────────────────────────────────────┤
│  ⚠ Cross-project pattern: "postgres connection limit" detected in    │
│    3 projects. Related memories: [3 links]                            │
└──────────────────────────────────────────────────────────────────────┘
```

Vitality is shown as a 5-dot indicator. Clicking a memory expands the full `content`,
shows all tags, related memories, and access history. The "confirm" button boosts vitality
by 0.30. The "archive" button sets status to `archived`.

### Cross-Project Pattern Detection

After each write, the server runs a lightweight pattern check:

1. Tokenise the new memory's content into keywords.
2. Query FTS across all projects for the same keyword cluster.
3. If 3+ memories from different projects match the same cluster within 30 days, create or
   update a `cross_project` memory that summarises the pattern.
4. Link all source memories to the cross-project memory via `relates_to`.
5. Broadcast the cross-project pattern to the web UI as an agent message.

The cross-project memory is the only memory type that can be created by the system
(source = `cross_project`). It inherits the highest vitality among its related memories.

### Vitality Decay — JavaScript, Not SQL Triggers

Vitality decay is computed in JavaScript at read time and written back, not via SQL
triggers. This was a debate outcome: SQL triggers for time-based decay are fragile and
hard to test. The decay runs in `runDecay()` which is called by a `setInterval`.

A `setInterval` in pensive.js runs the decay sweep every hour:

```javascript
setInterval(runDecay, 60 * 60 * 1000);
```

`runDecay()` in JavaScript:

```javascript
function runDecay() {
    const rows = db.prepare(
        `SELECT rowid, vitality, last_accessed, created_at, memory_type
         FROM memories WHERE status = 'active'`
    ).all();

    const now = Date.now();
    const update = db.prepare(
        `UPDATE memories SET vitality = ?, updated_at = ? WHERE rowid = ?`
    );
    const archive = db.prepare(
        `UPDATE memories SET status = 'archived', updated_at = ? WHERE rowid = ?`
    );

    const transaction = db.transaction(() => {
        for (const row of rows) {
            const ref = row.last_accessed ?? row.created_at;
            const days = (now - Date.parse(ref)) / 86_400_000;
            // Slower decay for stable types
            const lambda = ['fact','infrastructure','preference','convention'].includes(row.memory_type)
                ? 0.005 : 0.02;
            const newVitality = row.vitality * Math.exp(-lambda * days);
            if (newVitality < 0.10) {
                archive.run(new Date().toISOString(), row.rowid);
            } else {
                update.run(newVitality, new Date().toISOString(), row.rowid);
            }
        }
    });
    transaction();
}
```

Note: `node:sqlite` does not need a custom `exp()` function registration — `Math.exp` is
called in JavaScript before the SQL write, not inside SQL.

### Weekly Hard-Delete

A separate weekly sweep permanently removes rows archived for more than 90 days:

```javascript
setInterval(hardDelete, 7 * 24 * 60 * 60 * 1000);  // every 7 days

function hardDelete() {
    db.prepare(
        `DELETE FROM memories WHERE status = 'archived'
         AND updated_at < datetime('now', '-90 days')`
    ).run();
}
```

---

## sv CLI Extensions

All new `sv` commands call the supervisor REST API at `$SUPERVISOR_URL`.

### Write Commands

```bash
# World memories (cross-project, always loaded)
sv remember --world "postgres on 10.0.1.5 has 100 connection limit" --type infrastructure
sv remember --world "always deploy auth-service before web-app" --type convention
sv remember --world "use node:sqlite not better-sqlite3" --type convention

# Project memories (default scope — tied to current project)
sv remember "getUserById returns null not exception" --type discovery
sv remember "chose JWT over session cookies because TTL expiry semantics needed" \
    --type decision \
    --tags "auth,tokens"

# With hand-crafted compact form (skips server-side Shorthand generation)
sv remember "Auth tokens expire after 1h, not 24h as documented in api-docs.md" \
    --type discovery \
    --compact "auth_token TTL=1h (not 24h docs wrong)" \
    --tags "auth,tokens"

# With project override (for cross-project writes)
sv remember "getUserById returns null not exception" \
    --type discovery \
    --project auth-service
```

### Read Commands

```bash
# Search current project + world memories (default)
sv recall "connection limits"

# Search world memories only
sv recall --world "deployment order"

# Search all projects (L3 full search)
sv recall --global "deployment"

# Search specific project
sv recall --project auth-service "user lookup"

# Filter by type
sv recall --type infrastructure "postgres"

# Filter by tags
sv recall --tags "postgres,database"

# Get startup injection block L0+L1+L2 (compact form, used by session-start hook)
sv recall --startup

# Return raw JSON (for piping)
sv recall --json "connection limits"
```

### Management Commands

```bash
# Show memory statistics
sv pensive status

# Mark a memory as superseded and create a replacement
sv pensive supersede <id> "new corrected fact about postgres max_conn being 200 after upgrade"

# Link two memories as related
sv pensive relate <id1> <id2>

# Manually confirm a memory (boost vitality)
sv pensive confirm <id>

# Preview what decay would archive (dry run)
sv pensive decay --dry-run

# Trigger a decay sweep immediately
sv pensive decay

# Show cross-project patterns
sv pensive patterns
```

### sv remember Implementation Sketch

```bash
cmd_remember() {
    local content="${1:?Usage: sv remember <content> [--world] [--type TYPE] [--tags TAGS] [--compact COMPACT]}"
    shift
    local mtype="discovery" tags="" compact="" project="$PROJECT" scope="project" agent_id="${SV_TASK_ID:-manual}"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --world)   scope="world"; project="_world"; shift ;;
            --type)    mtype="$2";    shift 2 ;;
            --tags)    tags="$2";     shift 2 ;;
            --compact) compact="$2";  shift 2 ;;
            --project) project="$2";  shift 2 ;;
            *)         shift ;;
        esac
    done
    local body
    body=$(python3 -c "
import json, sys
obj = {'content': sys.argv[1], 'memory_type': sys.argv[2],
       'project': sys.argv[3], 'scope': sys.argv[4],
       'agent_id': sys.argv[5], 'source': 'sv_remember'}
if sys.argv[6]: obj['tags'] = [t.strip() for t in sys.argv[6].split(',')]
if sys.argv[7]: obj['compact_form'] = sys.argv[7]
print(json.dumps(obj))
" "$content" "$mtype" "$project" "$scope" "$agent_id" "$tags" "$compact")
    local resp
    resp=$(curl -s --max-time 10 \
        -X POST "${SUPERVISOR_URL}/api/pensive/memories" \
        -H "Content-Type: application/json" \
        -H "$(sv_auth_header)" \
        -d "$body")
    echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Stored: {d[\"id\"][:8]}… ({d[\"memory_type\"]})')" 2>/dev/null \
        || echo "Error: $resp" >&2
}
```

---

## Integration with Existing Hooks

### session-start.sh Changes

After the existing handoff and snapshot injection, add:

```bash
# ─── Pensive memory injection ─────────────────────────────────────────────
PENSIVE_CONTEXT=$(curl -s --max-time 5 \
    "${SUPERVISOR_URL}/api/pensive/recall" \
    -G \
    --data-urlencode "project=${PROJECT}" \
    --data-urlencode "limit=10" \
    --data-urlencode "format=compact" \
    --data-urlencode "startup=true" \
    -H "$(_sv_auth_header)" 2>/dev/null || echo "")

if [ -n "$PENSIVE_CONTEXT" ] && [ "$PENSIVE_CONTEXT" != "null" ] && [ "$PENSIVE_CONTEXT" != "[]" ]; then
    echo "=== Pensive Memory (project: $PROJECT) ==="
    echo ""
    echo "$PENSIVE_CONTEXT"
    echo ""
    echo "=== End Pensive Memory ==="
    echo ""
fi
```

Token budget: top 10 compact memories ≈ 300 tokens. The `startup=true` parameter sorts by
`vitality × recency` with no FTS query, returning the most currently-relevant memories.

### pre-compact.sh Changes

After the existing auto-commit block, add a session flush:

```bash
# ─── Flush session discoveries to Pensive ────────────────────────────────
curl -s --max-time 5 \
    -X POST "${SUPERVISOR_URL}/api/pensive/flush-session" \
    -H "Content-Type: application/json" \
    -H "$(_sv_auth_header)" \
    -d "$(jq -n \
        --arg session "$SESSION_ID" \
        --arg project "$PROJECT" \
        --arg trigger "$TRIGGER" \
        '{session_id: $session, project: $project, trigger: $trigger}'
    )" >/dev/null 2>&1 || true
```

`flush-session` is idempotent (dedup guard). It tells the server to persist all
`agentMessages` for `$SESSION_ID` that have `msgType === "discovery"` and have not yet been
written to Pensive (checked by `raw_payload` hash).

### on-stop.sh Changes

Only for non-`end_turn` stop reasons (already gated in the existing hook):

```bash
# ─── Flush to Pensive on session end ─────────────────────────────────────
if [ "$STOP_REASON" != "end_turn" ]; then
    curl -s --max-time 5 \
        -X POST "${SUPERVISOR_URL}/api/pensive/flush-session" \
        -H "Content-Type: application/json" \
        -H "$(_sv_auth_header)" \
        -d "$(jq -n \
            --arg session "$SESSION_ID" \
            --arg project "$PROJECT" \
            --arg reason "$STOP_REASON" \
            '{session_id: $session, project: $project, stop_reason: $reason}'
        )" >/dev/null 2>&1 || true
fi
```

### CLAUDE.md Guidance Addition

Add to the subagent discovery-publishing section:

```markdown
**Pensive persistence**: All `sv pub discovery` messages are automatically persisted to
the Pensive memory system. For longer-lived facts (infrastructure configs, stable
preferences, architectural decisions), use `sv remember` with an explicit type:
  - `sv remember "..." --type fact` — stable truths unlikely to change
  - `sv remember "..." --type infrastructure` — host/port/config facts
  - `sv remember "..." --type decision` — choices made with rationale
```

---

## Migration / Rollout Plan

### Phase 1 — Auto-capture Only (Low Risk, ~1 day)

1. Create `pensive.js` module with SQLite init, `pensivedWrite()`, and `pensiveRecall()`.
2. Add Pensive init to server.js startup.
3. Extend MQTT handler to call `pensivedWrite()` for `msgType === "discovery"` messages.
4. Add `GET /api/pensive/recall` and `GET /api/pensive/stats` endpoints.
5. Add `sv recall` to the `sv` CLI.

**Result**: Discoveries start accumulating silently. No impact on existing behaviour.
The web UI does not yet show the Pensive panel. Recall works from CLI but is not injected
into sessions.

### Phase 2 — Startup Injection (Medium Impact, ~1 day)

1. Add the Pensive injection block to `session-start.sh`.
2. Add `POST /api/pensive/memories` (`sv remember`).
3. Add compact-form generation to `pensivedWrite()`.
4. Add `sv remember` to the `sv` CLI.

**Risk**: Startup injection adds ~300 tokens to every session start. If this causes
unexpected behaviour (session confused by memories from old context), it can be disabled by
setting `PENSIVE_STARTUP_INJECT=0` env var which the hook checks before the curl call.

### Phase 3 — Hook Flush Integration (~half day)

1. Add flush calls to `pre-compact.sh` and `on-stop.sh`.
2. Add `POST /api/pensive/flush-session` endpoint.

### Phase 4 — Vitality Decay and Web UI (~1 day)

1. Add `runDecay()` and the hourly `setInterval`.
2. Register `exp()` as a custom SQLite function.
3. Add the Pensive panel to `web-ui.html`.
4. Add `GET /api/pensive/patterns` and cross-project pattern detector.

### Phase 5 — Full sv pensive Management (~half day)

1. Add `sv pensive supersede`, `sv pensive relate`, `sv pensive confirm`,
   `sv pensive decay`, `sv pensive patterns`, `sv pensive status`.
2. Add corresponding server endpoints.
3. Update CLAUDE.md with Pensive guidance.

### Rollback

Pensive is additive. The DB is a separate file (`data/pensive.db`). If Pensive causes
problems, delete the DB file and remove the three hook additions (three `curl` lines).
The rest of the system is unaffected.

---

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `node:sqlite` | **Built-in** — Node.js 22.5+ | Zero new npm dependencies; synchronous API; WAL support |
| `sqlite3` CLI | Available on system | For manual DB inspection only; not a runtime dep |
| SQLite FTS5 | Included in Node.js built-in SQLite | Available on all supported platforms |

`node:sqlite` (the built-in Node.js SQLite module, available since Node 22.5) is used
instead of any npm SQLite package. This was a debate outcome: zero new npm dependencies.

Usage:
```javascript
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./data/pensive.db');
db.exec('PRAGMA journal_mode = WAL');
```

The synchronous API is well-suited to the supervisor server which already uses synchronous
patterns (`execFileSync`, etc.). WAL mode with synchronous writes is safe for a
single-process server.

---

## Open Questions

### Q1. Compact form generation

Currently the design proposes hand-authored compact forms or 100-char truncation. A future
option is to run a fast local model (e.g., the existing `SUPERVISOR_FAST_MODEL` haiku
instance) to generate compact forms automatically. This would require an async write path.
Not needed for Phase 1–3; revisit in Phase 4.

### Q2. Memory ownership and cross-user isolation

The current design assumes a single user (simon) with multiple projects. If the supervisor
is shared (e.g., elena account), should memories be user-scoped? The `project` field already
provides some isolation, but a `user` or `account` column could be added. Decision: add
`account TEXT DEFAULT 'default'` to the schema for future use; not surfaced in Phase 1 UI.

### Q3. FTS similarity threshold for dedup

The 0.70 Jaccard threshold is a guess. It should be tuned empirically once real discoveries
accumulate. A too-high threshold creates duplicates; too-low merges distinct facts. The
threshold should be configurable: `PENSIVE_DEDUP_THRESHOLD` env var, default 0.70.

### Q4. Discovery vs. fact lifetime

Discoveries from subagent investigations (e.g., "function returns null") may become stale
quickly when code is refactored. Facts about infrastructure (IP addresses, ports) are
longer-lived. The dual-λ approach (0.02 vs. 0.005) addresses this but the boundary between
types is agent-determined. Consider adding a `confidence` field (0.0–1.0) that agents can
set to express how stable they believe the memory is; confidence could modulate λ directly.

### Q5. Memory conflicts across sessions

Two sessions may write contradictory discoveries: session A says "function returns null",
session B (after a refactor) says "function throws NotFoundException". Currently the dedup
guard only checks similarity, not contradiction. Detecting contradictions requires semantic
understanding beyond keyword overlap. For now: tag both, surface both in the web UI with
different session/date provenance, and let a human or future agent call
`sv pensive supersede` to resolve. A future enhancement could have the write guard call
the evaluator model (already present in the supervisor) to check for contradictions.

### Q6. Export / import for backup

`pensive.db` is a standard SQLite file — `sqlite3 pensive.db .dump` produces a portable
SQL dump. No special export tooling is needed. A `GET /api/pensive/export` endpoint could
return a JSONL dump for integration with external tools; not planned for initial phases.

### Q7. The Pensieve Panel vs. existing MEMORY.md

Pensive and the existing per-project `MEMORY.md` files serve overlapping purposes. The
migration path: Pensive gradually replaces manual `MEMORY.md` maintenance. A one-time
import script (`pensive-import-memory-md.sh`) can seed the DB from existing `.md` files
using the frontmatter fields already present (name, description, type). After Phase 3,
direct agents to prefer `sv remember` over writing to `MEMORY.md` for new facts.

---

## Debate Outcomes

The design was shaped by a structured debate between a Systems Architect persona (favouring
a full multi-table relational design) and a Minimalist Engineer persona (favouring the
simplest viable approach). Key outcomes:

### Verdict: Systems Architect won with major concessions

The core insight of the Systems Architect — that cross-project memory and tiered retrieval
are worth the design investment — was accepted. However, the Minimalist Engineer's
constraints on complexity and dependencies were also accepted.

### Specific Decisions

| Decision | Outcome | Rationale |
|----------|---------|-----------|
| Table count | **Single table (Phase 1)** | Relations and tags tables are Phase 2; denormalised JSON `tags` column is sufficient for initial use |
| SQLite driver | **`node:sqlite` (built-in)** | Zero new npm dependencies; available in Node 22.5+; no `better-sqlite3` |
| MEMORY.md authority | **MEMORY.md authoritative on conflict** | Pensive is additive; existing per-project MEMORY.md entries win if they contradict Pensive |
| Vitality decay | **Read-time computation in JavaScript** | SQL triggers for time decay are fragile; JavaScript `Math.exp` in `runDecay()` is testable |
| Write-path quality | **Hash dedup + negative-finding classifier + `content_type` tagger** | Prevent noise from non-finding discoveries; tag architectural vs implementation-specific |
| Hard-delete | **Weekly sweep, 90-day retention** | Archived rows removed after 90 days; prevents unbounded DB growth |
| Phase gate | **Measure recall usage after 30 days before Phase 2** | Do not build relations/access-log tables until there is evidence agents actually use recall |
| Priming risk | **`content_type = 'architectural'` preferred** | Implementation-specific memories (e.g., line numbers, variable names) are more likely to become stale and cause priming errors; architectural memories are more stable |

### Write-Path Quality Filters

Three filters run before any memory is written:

1. **Hash dedup**: SHA-256 of `content` checked against existing rows. Exact match → boost
   vitality, skip insert.
2. **FTS similarity dedup**: Jaccard similarity threshold (default 0.70) against FTS results.
   Near-duplicate → boost vitality, skip insert.
3. **Negative-finding classifier**: Discoveries that are purely negative ("no issues found",
   "nothing unexpected") are stored with `content_type = 'negative_finding'` and `tier = 'L3'`
   only — they do not appear in L0/L1/L2 startup injection.

### MEMORY.md Relationship

Pensive is additive. MEMORY.md files remain authoritative for their project. When a conflict
exists between a Pensive memory and a MEMORY.md entry, the MEMORY.md entry wins. A future
import script (`pensive-import-memory-md.sh`) can seed Pensive from existing MEMORY.md files.
After Phase 3, agents should prefer `sv remember` for new facts, but are not required to
migrate existing MEMORY.md entries.

---

## Summary

Pensive solves the supervisor's amnesia problem by turning the existing `sv pub discovery`
firehose into a persistent, queryable, vitality-weighted knowledge base. The write path is
zero-friction (auto-capture from MQTT). The read path is low-token (compact injection at
startup). The lifecycle is self-maintaining (hourly decay, automatic archival). The metaphor
holds: like Dumbledore's Pensieve, any session can deposit a memory, any session can examine
it, and old memories fade gracefully rather than cluttering the basin forever.

Implementation is additive with a safe rollback. Phase 1 can ship in a day and immediately
starts accumulating discoveries. Full integration across all five phases is roughly four days
of implementation work.