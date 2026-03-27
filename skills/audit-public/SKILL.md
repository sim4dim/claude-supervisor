# audit-public

## Description
Audit repository for sensitive data before publishing publicly. Scans for personal info, credentials, hardcoded paths, documentation consistency, and other security/privacy issues that could cause problems when making a repository public.

## Triggers
- "audit public"
- "check for sensitive data"
- "pre-publish scan"
- "audit repo"
- "scan for secrets"
- "public repo check"

## Usage
```bash
# Basic audit of current repository
/audit-public

# With verbose output
/audit-public --verbose

# Check specific directory
/audit-public --path /path/to/repo
```

## What it checks

### BLOCKER Issues (non-zero exit code)
- Personal usernames (configure via ~/.claude/.audit-blocklist)
- Personal email domains (configure via ~/.claude/.audit-blocklist)
- Real home paths (/home/<username>)
- Internal IP addresses (192.168.x.x, 10.x.x.x)
- Credential files (.credentials.json, containing SSHPASS, API_KEY, SECRET)
- Private project names (configure via ~/.claude/.audit-blocklist)
- Custom patterns from ~/.claude/.audit-blocklist

### IMPORTANT Issues (should review)
- Undocumented environment variables
- Missing referenced files in documentation
- Git history with AI attribution or potential secrets
- Inconsistent documentation

### MINOR Issues (cleanup suggestions)
- Hardcoded localhost ports not matching docs
- Documentation formatting issues
- Broken markdown anchor links

## Output Format
Structured report with severity levels and actionable recommendations. Returns appropriate exit codes for automation.