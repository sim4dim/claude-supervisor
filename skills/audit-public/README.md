# Audit Public Skill

A comprehensive security and privacy audit tool for repositories before publishing them publicly.

## Purpose

This skill scans repositories for sensitive data that could cause security or privacy issues when making repositories public, including:

- Personal information (usernames, email domains, home paths)
- Internal IP addresses and network information
- Credential indicators and API keys
- Private project references
- Hardcoded paths and configuration

## Installation

The skill is automatically available as `/audit-public` when installed in the Claude Code skills directory.

## Usage

```bash
# Basic audit of current repository
/audit-public

# With verbose output showing scan progress
/audit-public --verbose

# Audit specific directory
/audit-public --path /path/to/repo

# Get help
/audit-public --help
```

## What It Checks

### BLOCKER Issues (causes failure exit code)
- Personal usernames: configure via ~/.claude/.audit-blocklist
- Personal email domains: configure via ~/.claude/.audit-blocklist
- Real home paths: /home/<username> (excluding variables)
- Internal IP addresses: 192.168.x.x, 10.x.x.x, 172.16-31.x.x ranges
- Credential files: .credentials.json, files containing SSHPASS, API_KEY, SECRET
- Private project names: configure via ~/.claude/.audit-blocklist
- Custom patterns from ~/.claude/.audit-blocklist

### IMPORTANT Issues (should review)
- Environment variables used but not documented in README
- Missing files referenced in documentation
- Git history containing AI attribution or potential secrets
- Missing .env.example for environment variables

### MINOR Issues (cleanup suggestions)
- Hardcoded localhost ports that might not match documentation
- Missing common entries in .gitignore
- Broken markdown anchor links

## Customization

### Custom Blocklist

Add sensitive patterns to `~/.claude/.audit-blocklist`:

```bash
# Your custom patterns (one per line)
your-username
your-company-name
your-internal-domain.com
your-secret-project
```

Lines starting with `#` are comments.

## Output Format

The tool provides a structured report with:
- Color-coded severity levels
- File locations with line numbers
- Actionable recommendations
- Summary with issue counts

Exit codes:
- `0`: No blockers found (safe to publish)
- `1`: Blocker issues found (must fix before publishing)

## Integration

Can be integrated into:
- Git pre-commit hooks
- CI/CD pipelines
- Manual pre-publication checks

## Examples

### Successful Audit
```
=== AUDIT REPORT ===
Files scanned: 42
Issues found: 0

✓ No issues found! Repository appears safe for public publishing.
```

### Failed Audit
```
=== AUDIT REPORT ===
Files scanned: 75
Issues found: 15

BLOCKER ISSUES (3)
These MUST be fixed before publishing publicly!
  [PERSONAL_PATH] Hardcoded home path found: /home/jdoe
    → setup.sh:15
  [INTERNAL_IP] Internal IP address found: localhost0
    → config/servers.json:8
  [SENSITIVE_DATA] Sensitive pattern found: secret-project
    → README.md:42

❌ AUDIT FAILED: Fix blocker issues before publishing
```

## Files Excluded

The audit automatically excludes:
- node_modules/
- .git/
- dist/, build/
- Log files (*.log, *.tmp)
- The audit tool itself (audit-public directories)

## Dependencies

- Node.js
- glob package (automatically installed)