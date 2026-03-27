---
name: post-compaction-recovery
description: Use when context has been auto-compacted, conversation was compressed, or agent reports lost memory of previous work. Guides recovery: read progress snapshot, check task list and git state, then resume delegation mode.
user-invocable: false
effort: low
---

# Post-Compaction Recovery

Your detailed memory of previous work is unreliable after compaction. Follow this checklist before doing anything else.

## Recovery Checklist

**1. Read the progress snapshot first.**

Use the Read tool on `.claude/progress-snapshot.md`. This file is auto-generated before compaction and contains git state, recent commits, uncommitted changes, and agent activity. It is your primary recovery tool.

**2. Check the task list.**

Use `TaskList` to see pending, in-progress, and completed tasks.

**3. Check git state.**

```bash
git status
git diff
git log --oneline -10
```

`git log` is the authoritative record of what was completed. Do not repeat work that already has a commit.

**4. Re-read files before editing.**

If you were working on specific files, read them fresh before touching them. Do not edit based on what you "remember" the content was.

**5. Ask the user if still unsure.**

Say: "I just went through context compaction — what should I focus on?"

## What NOT to Do

- Do NOT trust compressed memory — verify everything against actual files.
- Do NOT repeat work that git log shows is already committed.
- Do NOT continue a multi-step plan from memory without re-reading relevant files.
- Do NOT make changes based on file contents you remember.

## After Recovery: Resume Delegation

Once you understand the current state, return immediately to delegation mode. Spawn subagents for all remaining work — do not do file reads, edits, or commands in the main context.

## Preventing Future Compaction Loss

- Commit working changes frequently.
- Use subagents for heavy implementation work to keep the main context lean.
- Keep the main context for coordination only.
