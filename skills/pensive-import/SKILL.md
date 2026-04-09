---
name: pensive-import
description: Extract operational knowledge from the current project and write it to Pensive. Use when user says "pensive-import", "extract knowledge", "import to pensive", "seed pensive", or "teach pensive about this project".
context: fork
agent: general-purpose
---

Extract operational knowledge from this project and write it to Pensive so future sessions start with context about how systems work, how to connect to them, and what tools to use.

## Step 1: Check existing memories

Run: `sv recall --project $(basename "$CLAUDE_PROJECT_DIR") --limit 50 2>/dev/null`

Note what's already in Pensive to avoid duplicates.

## Step 2: Identify knowledge sources

Scan the current project for these files (skip any that don't exist):

1. `CLAUDE.md` — skip content between `<!-- SUPERVISOR-START -->` and `<!-- SUPERVISOR-END -->` (supervisor boilerplate)
2. `.claude/rules/*.md` — project rules
3. `README.md` — project overview
4. `docs/**/*.md` — documentation (limit to 20 files, skip files > 50KB)
5. `tools/**/README.md`, `tools/**/USAGE.txt`, `tools/**/USAGE.md` — tool documentation
6. `.claude/settings.local.json` — extract allowed command patterns as operational knowledge
7. `.claude/transcript-excerpt.md` — past session workflows

Read each file and extract **operational knowledge only**:

- How to connect to remote systems (SSH commands, ports, credentials, API endpoints)
- Command recipes that work and gotchas about what doesn't work
- Tool usage patterns and deployment instructions
- File locations and data layouts on remote systems
- Critical rules and constraints
- Default credentials and access patterns

**Skip**: code structure, architecture descriptions, generic documentation, import statements, function signatures.

## Step 3: Write to Pensive

For each piece of operational knowledge, write it as a Pensive memory:

```bash
sv remember --project "$(basename "$CLAUDE_PROJECT_DIR")" --tier L2 --type infrastructure "<knowledge item>"
```

Rules for each memory:
- Keep under 300 characters
- Make it self-contained (understandable without context)
- One topic per memory (don't combine SSH access with tool usage)
- Skip if a similar memory already exists (from Step 1)
- Use `--tier L2` (auto-extracted, below manually curated L1)
- Use `--type infrastructure` for system access, `--type convention` for rules/gotchas, `--type fact` for discovered behaviors

## Step 4: Report

Print a summary:
- Files scanned and which had useful knowledge
- Number of memories written (new) vs skipped (duplicate)
- List each memory written with its source file

## Important

- Do NOT write memories about code structure or file organization — that's derivable from the repo
- Do NOT write memories that duplicate what's in CLAUDE.md supervisor boilerplate
- DO write memories about any non-obvious system access patterns, credentials, port numbers, tool deployment steps
- Focus on knowledge that would prevent a fresh session from "flailing" when trying to interact with external systems
