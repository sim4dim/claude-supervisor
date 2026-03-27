---
name: centurion
description: Security monitoring agent — scans for supply chain attacks, compromised packages, credential exposure, unauthorized SSH keys, suspicious processes. Triggers: "security audit", "security check", "centurion", "check for compromises", "supply chain scan", "are we secure"
user-invocable: true
argument-hint: "[--baseline] [--quick] [--category package|system|git|cred|advisory]"
effort: max
---

The user wants to run a Centurion security audit. Arguments: $ARGUMENTS

**Step 0: Parse flags**

Parse `$ARGUMENTS` for the following flags:

- `--baseline` → first-run mode; populates baseline files instead of running comparisons.
- `--quick` → skip the advisory feed web search (subagent 5).
- `--category <name>` → run only one scan category. Valid values: `package`, `system`, `git`, `cred`, `advisory`.

Extract the flags and store them:

```bash
BASELINE_MODE=false
QUICK_MODE=false
CATEGORY=""

# Parse --baseline
echo "$ARGUMENTS" | grep -q -- "--baseline" && BASELINE_MODE=true

# Parse --quick
echo "$ARGUMENTS" | grep -q -- "--quick" && QUICK_MODE=true

# Parse --category
CATEGORY=$(echo "$ARGUMENTS" | grep -oP '(?<=--category )\S+' || true)
```

If `--baseline` is set, skip to **Baseline mode** at the bottom of this skill.

---

**Step 1: Initialize**

```bash
RUN_ID="centurion-$(date +%s)"
echo "Centurion run ID: $RUN_ID"
sv pub status started "Centurion security audit"
```

Check whether baselines have been populated. Read these two files if they exist:
- `security/baseline-ssh-keys.txt`
- `security/baseline-cron.txt`

If either file does not exist OR contains the literal string `UNPOPULATED`, and `--baseline` was NOT set, warn the user:

> **Warning:** Centurion baselines have not been populated yet. SSH key and cron comparisons will be skipped. Run `/centurion --baseline` first to capture your current known-good state, then commit the baseline files to git.

Continue with the audit anyway — just note in the output that those comparison checks were skipped.

---

**Step 2: Spawn parallel subagents**

Determine which subagents to launch. If `--category` was specified, launch only the matching subagent. Otherwise, launch all applicable subagents:

- `package` → Package Security Scanner
- `system` → System Security Scanner
- `git` → Git Security Scanner
- `cred` → Credential Hygiene Scanner
- `advisory` → Advisory Feed (skip if `--quick` is set)

Launch all applicable subagents **simultaneously** using the Agent tool. Do not wait for one before starting the others.

---

### Subagent 1: Package Security Scanner

If `--category` is set and is NOT `package`, skip this subagent.

Spawn a `researcher` subagent with this prompt (substitute `$RUN_ID`):

> You are the Package Security Scanner for a Centurion security audit. Your run ID is `$RUN_ID`.
>
> ```bash
> export SV_TASK_ID="centurion-packages"
> sv pub status started "Package security scan"
> ```
>
> You are strictly READ-ONLY. Do NOT modify, delete, or write any files you are auditing. Read and inspect only.
>
> Run the following checks. For each one, record what you found.
>
> **Check A — Blocklist cross-reference**
>
> Read `security/package-blocklist.txt` from the project directory. This file contains one package name per line (lines starting with `#` are comments). If the file does not exist, note it as missing and skip this check.
>
> Then run:
> ```bash
> pip list --format=json 2>/dev/null
> npm list -g --json 2>/dev/null
> ```
>
> Cross-reference the installed packages against every entry in the blocklist. If any installed package name matches a blocklist entry (case-insensitive), report it as **CRITICAL** with title "Blocklisted package installed: <name>", detail showing which list it matched, and remediation "Immediately uninstall with pip uninstall <name> or npm uninstall -g <name> and investigate when it was installed".
>
> **Check B — Suspicious .pth files**
>
> Run:
> ```bash
> find $HOME -name "*.pth" -path "*/site-packages/*" 2>/dev/null
> ```
>
> For each .pth file found, read its contents and check its size. If it contains any of the strings `import`, `exec`, or `eval` AND its size is larger than 1024 bytes, report it as **CRITICAL** with title "Suspicious .pth file: <path>", detail showing the file path, size, and the suspicious content found, and remediation "Inspect the file contents immediately and remove if unauthorized. .pth files in site-packages that run code at Python startup are a common supply chain attack vector."
>
> If a .pth file contains those strings but is 1024 bytes or smaller, report as **WARNING** instead.
>
> **Check C — Requirements drift**
>
> For each `requirements.txt` found under `$HOME/projects/`, run `pip show <package>` for the first 10 packages listed. If the installed version differs from the pinned version in requirements.txt (when pinned with `==`), report as **WARNING** with title "Package version drift in <project>: <package>", detail showing expected vs installed version, and remediation "Run `pip install -r requirements.txt` to restore pinned versions."
>
> **Check D — npm audit**
>
> For each directory under `$HOME/projects/` that contains a `package-lock.json`, run:
> ```bash
> cd <dir> && npm audit --json 2>/dev/null
> ```
>
> If the output contains vulnerabilities with severity `moderate`, `high`, or `critical`, report as **WARNING** with title "npm audit findings in <project>", detail showing the count and severity breakdown, and remediation "Run `npm audit fix` or review and update dependencies manually."
>
> **When all checks are complete:**
>
> Compute:
> - `checks_run`: total number of checks attempted (A, B, C, D, counting each project separately for C and D)
> - `checks_passed`: checks with no findings
>
> Build the findings JSON and publish it:
>
> ```bash
> sv pub progress 100 "Package scan complete"
> sv retain "supervisor/claude-supervisor/centurion/$RUN_ID/packages" '{
>   "category": "packages",
>   "findings": [ ... ],
>   "checks_run": N,
>   "checks_passed": N
> }'
> sv pub status completed
> ```
>
> Replace `$RUN_ID` with the actual run ID value `$RUN_ID`. The findings array must follow this schema per entry:
> ```json
> {"severity": "CRITICAL|WARNING|INFO", "title": "...", "detail": "...", "remediation": "..."}
> ```
> If there are no findings, use an empty array `[]`.

---

### Subagent 2: System Security Scanner

If `--category` is set and is NOT `system`, skip this subagent.

Spawn a `researcher` subagent with this prompt (substitute `$RUN_ID`, `$BASELINE_CRON_EXISTS`, `$BASELINE_KEYS_EXISTS`):

> You are the System Security Scanner for a Centurion security audit. Your run ID is `$RUN_ID`.
>
> ```bash
> export SV_TASK_ID="centurion-system"
> sv pub status started "System security scan"
> ```
>
> You are strictly READ-ONLY. Do NOT modify, delete, or write any files you are auditing. Read and inspect only.
>
> Run the following checks. For each one, record what you found.
>
> **Check A — Cron job comparison**
>
> Run:
> ```bash
> crontab -l 2>/dev/null
> ```
>
> Read `security/baseline-cron.txt` from the project directory. If it exists and does NOT contain `UNPOPULATED`, compare the current crontab output against the baseline line by line. For any cron entry present in the current crontab but absent from the baseline, report as **WARNING** with title "Unrecognized cron entry: <entry>", detail showing the full cron line, and remediation "Verify whether this cron job is expected. If not, remove it with `crontab -e`."
>
> If `security/baseline-cron.txt` does not exist or contains `UNPOPULATED`, skip comparison and report as **INFO** with title "Cron baseline not populated" and detail "Run `/centurion --baseline` to capture the baseline."
>
> For other users: cross-user crontab access via sudo may be denied; skip and report as **INFO** with title "Other user crontabs not checked" and detail "Access denied — sudo is not available for non-SSH contexts."
>
> **Check B — Authorized SSH keys**
>
> For `$HOME/.ssh/authorized_keys`:
>
> If the file exists, run:
> ```bash
> ssh-keygen -lf $HOME/.ssh/authorized_keys 2>/dev/null
> ```
>
> Read `security/baseline-ssh-keys.txt` from the project directory. If it exists and does NOT contain `UNPOPULATED`, compare the fingerprints in the output against the baseline. For any fingerprint present in the live output but absent from the baseline, report as **CRITICAL** with title "Unrecognized SSH authorized key for <user>: <fingerprint>", detail showing the full fingerprint line, and remediation "Immediately remove the unrecognized key from ~/.ssh/authorized_keys and investigate how it got there. Check auth logs with `grep Accepted /var/log/auth.log`."
>
> If `security/baseline-ssh-keys.txt` does not exist or contains `UNPOPULATED`, skip comparison and report as **INFO** with title "SSH key baseline not populated" and detail "Run `/centurion --baseline` to capture the baseline."
>
> **Check C — File permissions**
>
> Check the following files and directories for dangerous permissions. IMPORTANT: Use `stat -L` (dereference symlinks) so that symlinks (which always show 777 on Linux) report the TARGET file's actual permissions instead of false positives:
>
> ```bash
> stat -Lc "%a %n" $HOME/.claude/.credentials.json 2>/dev/null
> stat -Lc "%a %n" $HOME/.ssh 2>/dev/null
> find $HOME -name ".env" -exec stat -Lc "%a %n" {} \; 2>/dev/null
> find $HOME -name "*.key" -exec stat -Lc "%a %n" {} \; 2>/dev/null
> find $HOME -name "*.pem" -exec stat -Lc "%a %n" {} \; 2>/dev/null
> find $HOME -path "*/.ssh/id_*" -not -name "*.pub" -exec stat -Lc "%a %n" {} \; 2>/dev/null
> ```
>
> For `.credentials.json` files: if permissions are not 600 or 640, report as **CRITICAL** with title "Credentials file world-readable: <path>" and remediation "Run `chmod 600 <path>` immediately."
>
> For `.ssh` directories: if permissions are not exactly 700, report as **CRITICAL** with title ".ssh directory has wrong permissions: <path>" and remediation "Run `chmod 700 <path>`."
>
> For `.env` files: if permissions include world-read (last octet is not 0), report as **CRITICAL** with title ".env file world-readable: <path>" and remediation "Run `chmod 600 <path>`."
>
> For private key files (`*.key`, `*.pem`, SSH private keys): if permissions are not 600, report as **CRITICAL** with title "Private key world-readable: <path>" and remediation "Run `chmod 600 <path>` immediately."
>
> **Check D — Unexpected network listeners**
>
> Run:
> ```bash
> ss -tlnp 2>/dev/null
> ```
>
> For any listening service bound to `0.0.0.0` on a port other than well-known dev server ports (3000, 3001, 3847, 4000, 5000, 8000, 8080, 8443, 9000), report as **WARNING** with title "Unexpected listener on 0.0.0.0: port <N>" and detail showing the full ss output line, and remediation "Identify the process with `ss -tlnp` and verify it is expected. If not, kill it and investigate."
>
> **Check E — Suspicious processes**
>
> Run:
> ```bash
> ps aux
> ```
>
> Scan the output for:
>
> - Crypto miners: process names or command lines containing `xmrig`, `minerd`, `cryptonight`, or `stratum`. Report as **CRITICAL** with title "Crypto miner process detected: <process>" and remediation "Kill the process immediately with `kill -9 <PID>` and investigate how it started. Check crontab and startup scripts."
>
> - Reverse shells: command lines containing `/dev/tcp`, `bash -i`, `nc -e`, `ncat -e`, or `bash -c 'exec`. Report as **CRITICAL** with title "Possible reverse shell process: <cmdline>" and remediation "Kill the process immediately with `kill -9 <PID>`. Check for persistence mechanisms in crontab, .bashrc, and systemd."
>
> - Processes running from suspicious paths: command lines where the executable path starts with `/tmp/`, `/dev/shm/`, or `/var/tmp/`. Report as **CRITICAL** with title "Process running from suspicious path: <path>" and remediation "Kill the process with `kill -9 <PID>` and delete the binary. Investigate how it was placed there."
>
> **When all checks are complete:**
>
> Compute:
> - `checks_run`: total checks attempted (A, B, C per file, D, E)
> - `checks_passed`: checks with no findings
>
> Build the findings JSON and publish it:
>
> ```bash
> sv pub progress 100 "System scan complete"
> sv retain "supervisor/claude-supervisor/centurion/$RUN_ID/system" '{
>   "category": "system",
>   "findings": [ ... ],
>   "checks_run": N,
>   "checks_passed": N
> }'
> sv pub status completed
> ```
>
> Replace `$RUN_ID` with the actual run ID value `$RUN_ID`.

---

### Subagent 3: Git Security Scanner

If `--category` is set and is NOT `git`, skip this subagent.

Spawn a `researcher` subagent with this prompt (substitute `$RUN_ID`):

> You are the Git Security Scanner for a Centurion security audit. Your run ID is `$RUN_ID`.
>
> ```bash
> export SV_TASK_ID="centurion-git"
> sv pub status started "Git security scan"
> ```
>
> You are strictly READ-ONLY. Do NOT modify, delete, or write any files you are auditing. Read and inspect only.
>
> Run the following checks. For each one, record what you found.
>
> **Check A — GitHub Actions pinning**
>
> Find all GitHub Actions workflow files:
> ```bash
> find $HOME/projects -path "*/.github/workflows/*.yml" 2>/dev/null
> find $HOME/projects -path "*/.github/workflows/*.yaml" 2>/dev/null
> ```
>
> For each workflow file found, read it and extract all `uses:` lines. For any `uses:` line that references an action with a tag (e.g., `@v3`, `@v2`, `@main`, `@master`) instead of a full commit SHA (40 hex characters), report as **WARNING** with title "GitHub Action uses mutable ref: <action>@<ref> in <file>", detail showing the full uses line and workflow file path, and remediation "Pin this action to a specific commit SHA for supply chain security. Find the SHA at https://github.com/<org>/<repo>/releases."
>
> **Check B — Secrets in git history**
>
> For each git repository found under `$HOME/projects/` (directories containing a `.git` folder), run:
>
> ```bash
> cd <repo> && git grep -l "AKIA[A-Z0-9]\{16\}" HEAD 2>/dev/null
> cd <repo> && git grep -l "ghp_[a-zA-Z0-9]\{36\}" HEAD 2>/dev/null
> cd <repo> && git grep -l "sk-ant-" HEAD 2>/dev/null
> ```
>
> For each match, report as **WARNING** (not CRITICAL, as these may be false positives or test fixtures) with title "Possible secret pattern in repo: <pattern> in <repo>", detail showing the matching file paths, and remediation "Inspect the matched files. If real credentials, rotate them immediately and consider running `git filter-repo` to scrub history. If test fixtures, add them to .gitignore or use placeholder values."
>
> **Check C — .gitignore coverage**
>
> For each git repository found under `$HOME/projects/`, read its `.gitignore` file (if it exists at the repo root). Check whether it includes entries covering: `.env`, `*.key`, `*.pem`, and `credentials.json`.
>
> A `.gitignore` "covers" a pattern if it contains that pattern literally, or a glob that would match it (e.g., `*.env` covers `.env`, `secrets/` covers `credentials.json` if credentials are stored there).
>
> For each missing pattern, report as **WARNING** with title ".gitignore missing pattern in <repo>: <pattern>", detail explaining which pattern is absent, and remediation "Add `<pattern>` to .gitignore to prevent accidentally committing sensitive files."
>
> **When all checks are complete:**
>
> Compute:
> - `checks_run`: total checks attempted (A per workflow file, B per repo, C per repo)
> - `checks_passed`: checks with no findings
>
> Build the findings JSON and publish it:
>
> ```bash
> sv pub progress 100 "Git scan complete"
> sv retain "supervisor/claude-supervisor/centurion/$RUN_ID/git" '{
>   "category": "git",
>   "findings": [ ... ],
>   "checks_run": N,
>   "checks_passed": N
> }'
> sv pub status completed
> ```
>
> Replace `$RUN_ID` with the actual run ID value `$RUN_ID`.

---

### Subagent 4: Credential Hygiene Scanner

If `--category` is set and is NOT `cred`, skip this subagent.

Spawn a `researcher` subagent with this prompt (substitute `$RUN_ID`):

> You are the Credential Hygiene Scanner for a Centurion security audit. Your run ID is `$RUN_ID`.
>
> ```bash
> export SV_TASK_ID="centurion-credentials"
> sv pub status started "Credential hygiene scan"
> ```
>
> You are strictly READ-ONLY. Do NOT modify, delete, or write any files you are auditing. Read and inspect only.
>
> Run the following checks. For each one, record what you found.
>
> **Check A — Claude credentials freshness**
>
> Check the modification time of `$HOME/.claude/.credentials.json`:
> ```bash
> stat -c "%Y %n" $HOME/.claude/.credentials.json 2>/dev/null
> ```
>
> Compare the mtime (Unix timestamp) to the current time (`date +%s`). If the file is older than 7200 seconds (2 hours), report as **WARNING** with title "Claude credentials may be stale", detail showing the age in minutes, and remediation "The token refresh cron job may not be running. Check with: `crontab -l | grep refresh-token`."
>
> Then verify the refresh cron is present:
> ```bash
> crontab -l 2>/dev/null | grep refresh-token
> ```
>
> If no line containing `refresh-token` is found, report as **WARNING** with title "Claude token refresh cron not found", detail "No cron entry for refresh-token was found in the current user's crontab", and remediation "Check the token-refresh setup — without it, sessions will encounter 401 errors after token expiry."
>
> **Check B — Credential file permissions**
>
> Find credential files:
> ```bash
> find simon//$HOME/ -name ".env" 2>/dev/null
> find simon//$HOME/ -name "credentials.json" 2>/dev/null
> find simon//$HOME/ -name "*.key" 2>/dev/null
> find simon//$HOME/ -name "*.pem" 2>/dev/null
> ```
>
> For each file found, check its permissions:
> ```bash
> stat -Lc "%a %n" <file>
> ```
>
> If the permissions octet indicates the file is world-readable (i.e., the last digit of the octet is non-zero, meaning others have read access), report as **CRITICAL** with title "Credential file is world-readable: <path>", detail showing the current permissions and file path, and remediation "Run `chmod 600 <path>` immediately to restrict access."
>
> If the file is group-readable but not world-readable (middle digit non-zero), and it is a sensitive file like an API key or private key, report as **WARNING** with title "Credential file is group-readable: <path>" and remediation "Consider `chmod 600 <path>` unless group access is intentional."
>
> **Check C — Docker credential mounts**
>
> Run:
> ```bash
> docker ps --format json 2>/dev/null
> ```
>
> For each running container, inspect its mounts:
> ```bash
> docker inspect <container_id> --format '{{json .Mounts}}' 2>/dev/null
> ```
>
> If any mount's `Source` path contains `/.ssh`, `/.aws`, `.credentials.json`, `.env`, or `private_key`, report as **WARNING** with title "Docker container mounts sensitive path: <container_name> → <mount_source>", detail showing the container name, image, and mount source path, and remediation "Review whether this credential mount is necessary. Consider using Docker secrets or environment variables instead of bind-mounting credential files."
>
> **When all checks are complete:**
>
> Compute:
> - `checks_run`: total checks attempted (A×2, B per file found, C per container)
> - `checks_passed`: checks with no findings
>
> Build the findings JSON and publish it:
>
> ```bash
> sv pub progress 100 "Credential hygiene scan complete"
> sv retain "supervisor/claude-supervisor/centurion/$RUN_ID/credentials" '{
>   "category": "credentials",
>   "findings": [ ... ],
>   "checks_run": N,
>   "checks_passed": N
> }'
> sv pub status completed
> ```
>
> Replace `$RUN_ID` with the actual run ID value `$RUN_ID`.

---

### Subagent 5: Advisory Feed Scanner

Skip this subagent entirely if `--quick` is set OR if `--category` is set and is NOT `advisory`.

Spawn a `researcher` subagent with this prompt (substitute `$RUN_ID`):

> You are the Advisory Feed Scanner for a Centurion security audit. Your run ID is `$RUN_ID`.
>
> ```bash
> export SV_TASK_ID="centurion-advisory"
> sv pub status started "Advisory feed scan"
> ```
>
> You are strictly READ-ONLY. Do NOT modify, delete, or write any files you are auditing. Read and inspect only.
>
> Run the following checks using web search. For each check, record what you found and whether it is relevant to installed packages.
>
> **Check A — Supply chain news**
>
> Web search for recent supply chain attack news. Run these searches:
> - "python supply chain attack march 2026"
> - "npm supply chain compromise 2026"
> - "pypi malicious package 2026"
>
> For each article or advisory found, note the package names mentioned. Then cross-reference against installed packages:
> ```bash
> pip list --format=json 2>/dev/null
> npm list -g --json 2>/dev/null
> ```
>
> If any mentioned package is currently installed, report as **CRITICAL** with title "Installed package linked to supply chain attack: <name>", detail summarizing the advisory and linking to the source URL, and remediation "Remove the package immediately and investigate when it was installed. See: <URL>."
>
> If the advisories mention packages not installed, report as **INFO** with title "Supply chain advisories found (not installed): <count> packages", detail listing the package names from advisories, and no remediation needed.
>
> **Check B — CVE exposure**
>
> Get system and runtime versions:
> ```bash
> uname -r
> docker --version 2>/dev/null
> node --version 2>/dev/null
> python3 --version 2>/dev/null
> ```
>
> Web search for CVEs affecting:
> - The kernel version returned by `uname -r` (search: "CVE linux kernel <version> 2025 2026")
> - The Docker version installed (search: "CVE docker <version> 2026")
> - The Node.js version installed (search: "CVE nodejs <version> 2026")
>
> For any CVE with CVSS score 7.0 or higher found to affect the exact version installed, report as **WARNING** with title "CVE <ID> affects installed <software> <version>", detail including the CVE description and CVSS score, and remediation "Update <software> to the latest patched version."
>
> **Check C — Blocklist suggestions**
>
> Based on findings from checks A and B, compile a list of package names that should be added to `security/package-blocklist.txt`. Include:
> - Any packages mentioned in supply chain attack advisories from check A (whether installed or not)
> - Any packages that were identified as malicious in the web search results
>
> Do NOT modify `security/package-blocklist.txt` yourself. Instead, include the suggestions in the `blocklist_suggestions` field of your output JSON (see below).
>
> **When all checks are complete:**
>
> Compute:
> - `checks_run`: total checks attempted
> - `checks_passed`: checks with no findings
>
> Build the findings JSON with an additional `blocklist_suggestions` field and publish it:
>
> ```bash
> sv pub progress 100 "Advisory feed scan complete"
> sv retain "supervisor/claude-supervisor/centurion/$RUN_ID/advisory" '{
>   "category": "advisory",
>   "findings": [ ... ],
>   "checks_run": N,
>   "checks_passed": N,
>   "blocklist_suggestions": ["pkg1", "pkg2"]
> }'
> sv pub status completed
> ```
>
> Replace `$RUN_ID` with the actual run ID value `$RUN_ID`. If there are no blocklist suggestions, use an empty array `[]`.

---

**Step 3: Collect results**

Wait for all spawned subagents to complete before continuing.

Then read each retained result topic. Read only the topics for subagents that were actually launched:

```bash
sv read "supervisor/claude-supervisor/centurion/$RUN_ID/packages"
sv read "supervisor/claude-supervisor/centurion/$RUN_ID/system"
sv read "supervisor/claude-supervisor/centurion/$RUN_ID/git"
sv read "supervisor/claude-supervisor/centurion/$RUN_ID/credentials"
sv read "supervisor/claude-supervisor/centurion/$RUN_ID/advisory"
```

Skip the `advisory` read if `--quick` was set or if it was excluded by `--category`.

Parse the JSON from each topic. Collect all `findings` arrays into a single combined list. Also collect `checks_run` and `checks_passed` totals.

---

**Step 4: Compute health score**

Start with a score of 100. Apply the following deductions based on severity across ALL findings:

- Each **CRITICAL** finding: -20 points
- Each **WARNING** finding: -5 points
- Each **INFO** finding: -1 point

Clamp the score to a minimum of 0.

Assign a rating based on the final score:
- 90–100: **SECURE**
- 70–89: **ATTENTION**
- 50–69: **DEGRADED**
- 0–49: **CRITICAL**

Count totals:
- `critical_count`: number of CRITICAL findings
- `warning_count`: number of WARNING findings
- `info_count`: number of INFO findings
- `total_checks_run`: sum of `checks_run` across all subagents
- `total_checks_passed`: sum of `checks_passed` across all subagents

---

**Step 5: Publish results**

**a. Write journal entry**

Append one JSON line to `logs/centurion-journal.jsonl`:

```json
{
  "run_id": "<RUN_ID>",
  "timestamp": "<ISO-8601 UTC>",
  "score": <N>,
  "rating": "<SECURE|ATTENTION|DEGRADED|CRITICAL>",
  "critical_count": <N>,
  "warning_count": <N>,
  "info_count": <N>,
  "total_checks_run": <N>,
  "total_checks_passed": <N>,
  "findings": [ <all findings from all categories> ],
  "blocklist_suggestions": [ <suggestions from advisory subagent if any> ],
  "flags": {
    "quick": <true|false>,
    "baseline": false,
    "category": "<value or null>"
  }
}
```

Use `python3 -c` or a heredoc to append the JSON line without overwriting the file.

**b. Publish MQTT summary**

```bash
sv pub alert centurion "Score: $SCORE/100 ($RATING) — $CRITICAL_COUNT critical, $WARNING_COUNT warnings"
```

**c. Publish each CRITICAL finding**

For each CRITICAL finding in the combined list:

```bash
sv pub alert centurion-critical "<finding title>"
```

**d. Retain latest result**

```bash
sv retain "supervisor/claude-supervisor/centurion/latest" '<full journal JSON>'
```

---

**Step 6: Clean up retained run topics**

Clear all run-specific retained topics to avoid stale data accumulation:

```bash
sv clear "supervisor/claude-supervisor/centurion/$RUN_ID/packages"
sv clear "supervisor/claude-supervisor/centurion/$RUN_ID/system"
sv clear "supervisor/claude-supervisor/centurion/$RUN_ID/git"
sv clear "supervisor/claude-supervisor/centurion/$RUN_ID/credentials"
sv clear "supervisor/claude-supervisor/centurion/$RUN_ID/advisory"
```

---

**Step 7: Present results to the user**

Show the user a structured report:

```
Centurion Security Audit — Run $RUN_ID
========================================
Health Score: $SCORE/100 — $RATING

Checks run: $TOTAL_CHECKS_RUN | Passed: $TOTAL_CHECKS_PASSED
```

If there are CRITICAL findings, list them prominently at the top:

```
CRITICAL FINDINGS ($CRITICAL_COUNT):
  - <title>
    Detail: <detail>
    Remediation: <remediation>
  ...
```

Then show WARNING count and a brief list of warning titles (no full detail — keep it scannable):

```
Warnings ($WARNING_COUNT):
  - <title>
  ...
```

If there are blocklist suggestions from the advisory subagent, show them:

```
Blocklist Suggestions (do not install):
  - <pkg1>
  - <pkg2>
  To add: echo "<pkg>" >> security/package-blocklist.txt
```

Finally, tell the user:

```
Full report: tail -1 logs/centurion-journal.jsonl | python3 -m json.tool
```

Then publish final status:

```bash
sv pub status completed
```

---

## Baseline mode (`--baseline`)

If the `--baseline` flag was set in Step 0, run this procedure instead of the normal audit flow.

Tell the user: "Running Centurion baseline capture. This records the current known-good state for SSH keys and cron jobs."

**1. Capture SSH key fingerprints**

```bash
ssh-keygen -lf $HOME/.ssh/authorized_keys 2>/dev/null
```

Combine the output from both commands into a single baseline. Prepend a header comment indicating when the baseline was captured:

```
# Centurion SSH key baseline — captured <date>
# Format: <bits> <fingerprint> <comment> (<algorithm>)
# One line per authorized key across all users (user noted in comment if needed)
```

Write this to `security/baseline-ssh-keys.txt`, creating the `security/` directory if needed.

**2. Capture cron jobs**

```bash
crontab -l 2>/dev/null
```

Prepend a header comment:

```
# Centurion cron baseline — captured <date>
# current user's crontab
```

Write this to `security/baseline-cron.txt`. If `crontab -l` returns nothing (empty crontab), write just the header comment.

**3. Report to user**

Tell the user:

> Baselines captured:
> - `security/baseline-ssh-keys.txt` — SSH authorized key fingerprints for the current user
> - `security/baseline-cron.txt` — current user's crontab
>
> Please review these files and commit them to git:
> ```bash
> git diff security/
> git add security/baseline-ssh-keys.txt security/baseline-cron.txt
> git commit -m "security: update Centurion baselines"
> ```
>
> Future Centurion runs will compare live state against these baselines and alert on any differences.

```bash
sv pub status completed
```