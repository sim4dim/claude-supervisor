---
name: release-monitor
description: Check for new Claude Code releases and evaluate features for adoption. Triggers: "release monitor", "check for claude updates", "new claude version", "release check", "release-monitor"
user-invocable: true
argument-hint: ""
model: sonnet
effort: low
---

Check for new Claude Code releases and evaluate any new features for adoption in this supervisor project.

## Step 1: Initialize

```bash
export SV_TASK_ID="release-monitor"
sv pub status started "Checking for new Claude Code releases"
```

Get the current installed version:

```bash
CURRENT_VERSION=$(claude --version 2>/dev/null | grep -oP '[\d]+\.[\d]+\.[\d]+' | head -1)
echo "Current version: $CURRENT_VERSION"
```

Get the latest published version from npm:

```bash
LATEST_VERSION=$(npm view @anthropic-ai/claude-code version 2>/dev/null)
echo "Latest version: $LATEST_VERSION"
```

## Step 2: Compare versions

If `CURRENT_VERSION` equals `LATEST_VERSION` (or `LATEST_VERSION` is empty), publish:

```bash
sv pub status completed "No new release (current: $CURRENT_VERSION)"
```

Then tell the user: "No new Claude Code release — currently on $CURRENT_VERSION (latest)."

Stop here.

If `LATEST_VERSION` is newer than `CURRENT_VERSION`, continue to Step 3.

## Step 3: Fetch changelog

Spawn two parallel researcher subagents to gather release information.

### Subagent A: Fetch GitHub CHANGELOG

Spawn a researcher subagent with this prompt (substitute $CURRENT_VERSION, $LATEST_VERSION):

> Fetch the Claude Code changelog from GitHub and extract all entries newer than version $CURRENT_VERSION up to version $LATEST_VERSION.
>
> ```bash
> export SV_TASK_ID="release-monitor-changelog"
> sv pub status started "Fetching Claude Code changelog"
> ```
>
> Use WebFetch to retrieve: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
>
> Parse the changelog and extract all sections for versions newer than $CURRENT_VERSION. Include:
> - The version number and release date
> - All features listed under "Features" or "New"
> - All breaking changes listed under "Breaking Changes"
> - All bug fixes listed under "Bug Fixes" or "Fixes"
> - Any deprecations or removals
>
> If that URL fails, try: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
>
> Retain the results:
> ```bash
> sv retain "supervisor/claude-supervisor/release-monitor/changelog" '<JSON with versions array>'
> sv pub status completed
> ```
>
> JSON format:
> ```json
> {
>   "versions": [
>     {
>       "version": "x.y.z",
>       "date": "YYYY-MM-DD or empty",
>       "features": ["..."],
>       "breaking": ["..."],
>       "fixes": ["..."],
>       "other": ["..."]
>     }
>   ]
> }
> ```

### Subagent B: WebSearch for release notes

Spawn a researcher subagent with this prompt (substitute $LATEST_VERSION):

> Search for release notes and community coverage of Claude Code $LATEST_VERSION.
>
> ```bash
> export SV_TASK_ID="release-monitor-web-search"
> sv pub status started "Searching for Claude Code $LATEST_VERSION release notes"
> ```
>
> Use WebSearch with query: "Claude Code $LATEST_VERSION release notes"
>
> Also check https://www.claudeupdates.dev/ via WebFetch for any additional version info.
>
> Extract any features, changes, or community notes not already covered by the official changelog.
>
> Retain the results:
> ```bash
> sv retain "supervisor/claude-supervisor/release-monitor/updates-site" '<JSON>'
> sv pub status completed
> ```
>
> JSON format:
> ```json
> {
>   "versions": [
>     {
>       "version": "x.y.z",
>       "notes": ["additional notes not in official changelog"]
>     }
>   ],
>   "source_available": true
> }
> ```

Check `drops/` for any `.marker` files that the cron job has written:

```bash
ls $HOME/projects/claude-supervisor/drops/new-release-*.marker 2>/dev/null || true
```

Note any detected versions from the marker files. The skill works whether or not a marker file is present — if running manually, just compare $CURRENT_VERSION vs $LATEST_VERSION directly.

## Step 4: Collect results

Wait for both subagents to complete, then read their findings:

```bash
sv read "supervisor/claude-supervisor/release-monitor/changelog"
sv read "supervisor/claude-supervisor/release-monitor/updates-site"
```

Parse the JSON from each. Merge the version entries: for each version, combine the changelog data with any additional notes from claudeupdates.dev.

## Step 5: Evaluate features for adoption

For each feature, breaking change, or notable item found, evaluate its adoption potential for this supervisor project. The supervisor project is a Node.js server that manages Claude Code terminal sessions, routes tool-call approvals via MQTT, and provides a web dashboard for monitoring agents. It uses hooks, skills, and subagents extensively.

Consider these adoption angles:

- **Hooks** — new lifecycle events, new hook data fields, new hook types
- **Skills / slash commands** — new skill frontmatter options, new invocation patterns
- **Subagent / Task tool** — changes to agent spawning, turn budgets, subagent types
- **Approval / permission system** — changes to how tool calls are approved or denied
- **Model options** — new models, cost changes, capability improvements
- **MCP** — new MCP server capabilities or protocol changes
- **Session management** — changes to session lifecycle, compaction, memory
- **API / environment** — new env vars, config options, API changes

Rate each item:
- **HIGH** — directly applicable, should adopt soon
- **MEDIUM** — potentially useful, evaluate further
- **LOW** — not relevant to this project's use cases
- **BREAKING** — requires action before upgrading

## Step 6: Write evaluation report

Determine the output filename: `drops/release-eval-$LATEST_VERSION.md`

Write a markdown report to that file. The report should contain:

```markdown
# Claude Code Release Evaluation: v$LATEST_VERSION

**Date evaluated:** <today>
**Current version:** $CURRENT_VERSION
**New version:** $LATEST_VERSION

## Summary

<2-3 sentence executive summary: how significant is this release?>

## Breaking Changes

<list any breaking changes, or "None">

## Features — Adoption Evaluation

### HIGH priority

<for each HIGH item: feature name, what it does, why it matters for this project, how to adopt it>

### MEDIUM priority

<for each MEDIUM item: feature name, brief note on potential use>

### LOW priority (skippable)

<brief list of items not relevant>

## Bug Fixes Relevant to This Project

<list fixes that affect functionality this project uses, or "None notable">

## Upgrade Recommendation

<UPGRADE NOW / UPGRADE SOON / HOLD — with reasoning>

## Raw Changelog

<paste the extracted changelog entries verbatim>
```

## Step 7: Publish and clean up

```bash
sv pub discovery "New Claude Code $LATEST_VERSION available — eval written to drops/release-eval-$LATEST_VERSION.md"
sv clear "supervisor/claude-supervisor/release-monitor/changelog"
sv clear "supervisor/claude-supervisor/release-monitor/updates-site"
```

Remove the marker file if it exists (clean up after evaluation):

```bash
MARKER_FILE="$HOME/projects/claude-supervisor/drops/new-release-${LATEST_VERSION}.marker"
if [[ -f "$MARKER_FILE" ]]; then
    rm "$MARKER_FILE"
    echo "Cleaned up marker file: $MARKER_FILE"
fi
```

```bash
sv pub status completed
```

Tell the user: "New Claude Code release found: $LATEST_VERSION (was $CURRENT_VERSION). Evaluation written to drops/release-eval-$LATEST_VERSION.md"
