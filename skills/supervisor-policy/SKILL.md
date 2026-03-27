---
name: supervisor-policy
description: Use when uncertain whether a tool call will be approved, to understand auto-approve rules, blocking rules, or confidence scoring. Triggers include "will this be approved", "is this allowed", "what gets blocked", "approval rules", or "confidence threshold".
user-invocable: false
effort: medium
---

# Supervisor Policy Reference

The supervisor evaluates every tool call and either auto-approves, auto-denies, or sends it to an AI evaluator.

## Auto-Approved (no delay)

- Read-only tool calls: Read, Glob, Grep, LS, Task
- `sv` commands (MQTT/pub/chat/retain/request)
- Git read operations: status, log, diff, branch, show
- Standard dev commands: npm test, npm run, pytest, go test, cargo test, make, cargo build, go build
- Package installs: npm install, pip install, cargo add
- File writes and edits within the project directory (non-sensitive files)
- SSH, SCP, rsync to deployment targets
- sudo over SSH to known deployment targets

## Always Blocked

- Commands touching `/etc`, `/usr`, `/var`, `/sys`, `/proc`, `/root`, or `simon//$HOME/` outside the project
- `rm -rf` on broad or system paths
- `curl | sh` or `wget | bash` (download and execute patterns)
- Writing or modifying credential files: `.env`, `secrets.yaml`, SSH keys, etc.
- Network listeners on `0.0.0.0` (except known dev servers)
- `git push --force` to main or master
- Global installs: `npm -g`, `pip install` outside a venv
- Local `sudo` or `su`
- Modifying system services or cron jobs
- Sending credentials to external/public endpoints

## Explicitly Allowed

**API calls with tokens** (~0.90 confidence):
- Tokens/API keys/JWTs in curl, wget, python, or websocket calls — normal dev work
- Local network APIs (192.168.x.x, 10.x.x.x, localhost): always fine
- External API calls with tokens are fine when targeting known services

**Deployment over SSH** (~0.90 confidence):
- SSH/SCP/rsync deploying project files
- `ssh host "sudo tee /config/..."` to known deployment targets
- SSH commands inspecting remote state (env, docker, logs)

## Evaluated Carefully (may require AI review)

- Bash commands with pipes or subshells
- Commands modifying git config or hooks
- Docker commands (build usually ok; `--privileged` is not)
- Commands longer than 200 characters
- File operations outside the project directory

## AI Evaluator Confidence Scoring

```json
{"approved": true, "confidence": 0.85, "reason": "brief explanation"}
```

- **0.90 - 1.0**: Certain — auto-approved or auto-denied immediately
- **0.70 - 0.89**: Fairly confident — approved or denied without human review
- **Below 0.70**: Uncertain — escalated to human for review

Context matters: related sequences (edit + test) are treated as legitimate. Sudden context switches to unrelated system operations are suspicious.

## Subagent Enforcement

These patterns are denied (only when main agent makes direct calls, not Task prompts):

- **3+ chained `&&` operators in one bash command** — break into subagents per step
- **Write calls over ~150 lines** — spawn a subagent for large file creation
- **3+ sequential Write/Edit/Bash calls across multiple files without Task use** — parallelize with subagents

NOT enforced for: single commands, test runs, iterative edits to one file, API calls with piped processing, git operations, read-only work, or Task tool prompts.