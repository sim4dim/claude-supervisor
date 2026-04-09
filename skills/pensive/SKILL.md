---
name: pensive
description: Interact with Pensive memory system. Use when user says "pensive", "search memories", "remember this", "what do I remember about", "show world memories", "show project memories", or "pensive status".
context: fork
agent: Explore
effort: low
---

Parse the user's input to determine which subcommand they want, then execute it.

## Subcommand: `/pensive` or `/pensive status`

Show Pensive memory system stats.

1. Run `sv recall --startup` to show the current project's memories in startup format.
2. Fetch stats: `curl -s -H "Authorization: Bearer $(cat ~/.claude/.supervisor-hook-token)" "http://localhost:${SUPERVISOR_PORT:-3847}/api/pensive/stats"`
3. Display:
   - Total memory count by scope (world / project / session)
   - Memory count by tier (L1 / L2 / L3)
   - Memory count by type (fact, convention, discovery, infrastructure, etc.)
   - Current project memories listed compactly

Output format: bullet points, no prose.

---

## Subcommand: `/pensive search <query>`

Search Pensive memories across all projects.

Run: `sv recall "<query>" --global --limit 20`

Parse the JSON response and display each memory as:
```
[TIER] [scope/project] content
```

If no results, say "No memories found for: <query>".

---

## Subcommand: `/pensive remember <content>`

Store a new memory interactively.

1. Ask the user for missing details if not provided in the command:
   - **Type**: fact, convention, discovery, infrastructure, warning, decision (default: discovery)
   - **Scope**: project (default) or world
   - **Tags**: optional comma-separated tags (press Enter to skip)

2. Build the `sv remember` command from their answers:
   - For world scope: add `--world`
   - For type: add `--type <type>`
   - For tags: add `--tags '["tag1","tag2"]'`

3. Run the command and show the result (id of the created memory).

Example: `sv remember "Rate limiter resets every 60s" --type fact --world`

---

## Subcommand: `/pensive world`

List all world-scoped memories.

Run: `sv recall --world --global --limit 50`

Parse JSON and display each memory as:
```
[TIER] [type] content
    tags: tag1, tag2  (if any)
    id: <short-id>    (first 8 chars)
```

Group by tier (L1 first, then L2, then L3). Show total count at the end.

---

## Subcommand: `/pensive project [name]`

List memories for a specific project (or current project if no name given).

If a project name is given: `sv recall --project <name> --limit 50`
Otherwise: `sv recall --limit 50`

Parse JSON and display each memory as:
```
[TIER] [type] content
    id: <short-id>
```

Show total count at the end.

---

## Subcommand: `/pensive forget <id>`

Mark a memory as archived (deleted) by its ID.

1. If the ID looks like a prefix (< 36 chars), first run `sv recall --global --limit 100` and find the full ID matching the prefix. Show the memory content to the user and ask them to confirm before deleting.

2. Run the DELETE call:
```bash
curl -s -X DELETE "http://localhost:${SUPERVISOR_PORT:-3847}/api/pensive/memories/<id>" \
  -H "Authorization: Bearer $(cat ~/.claude/.supervisor-hook-token)"
```

3. Show the result. A successful response will have `"action":"archived"`. If the memory was not found, say "No memory found with that ID."

---

## Formatting rules

- Parse JSON output from `sv recall` using the `memories` array.
- `compact_form` is preferred for display; fall back to `content` truncated to 120 chars.
- `tier`: L1 = critical/always-loaded, L2 = important, L3 = reference
- Always show the short ID (first 8 chars of `id`) so the user can reference it later.
- If the Pensive API is unreachable, say: "Pensive is not available — is the supervisor running? Check with /project-status."
