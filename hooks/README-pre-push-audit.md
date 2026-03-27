# Pre-Push Audit Hook

A git pre-push hook that automatically runs the `audit-public` skill when pushing to public repositories, preventing accidental exposure of sensitive data.

## Overview

This hook provides an automated security layer for git repositories by:

- **Detecting public repositories**: Automatically identifies when you're pushing to GitHub, GitLab, Bitbucket, or other public git hosting services
- **Running security audits**: Executes the `/audit-public` skill to scan for sensitive data before the push
- **Blocking dangerous pushes**: Prevents the push if BLOCKER level issues are found (personal info, credentials, internal IPs, etc.)
- **Allowing safe pushes**: Permits the push to proceed if no security blockers are detected

## Files

- `pre-push-audit.sh` - The actual git hook script
- `install-pre-push-audit.sh` - Installation script for any repository
- `README-pre-push-audit.md` - This documentation file

## Installation

### Option 1: Using the Installation Script (Recommended)

1. Navigate to your git repository:
   ```bash
   cd /path/to/your/repo
   ```

2. Run the installation script:
   ```bash
   simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/install-pre-push-audit.sh
   ```

3. Test the installation:
   ```bash
   simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/install-pre-push-audit.sh --test
   ```

### Option 2: Manual Installation

1. Copy the hook to your repository:
   ```bash
   cp simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/pre-push-audit.sh /path/to/your/repo/.git/hooks/pre-push
   ```

2. Make it executable:
   ```bash
   chmod +x /path/to/your/repo/.git/hooks/pre-push
   ```

## How It Works

### Public Repository Detection

The hook identifies public repositories by checking the remote URL for:

- **GitHub**: `github.com`
- **GitLab**: `gitlab.com`
- **Bitbucket**: `bitbucket.org`
- **Codeberg**: `codeberg.org`
- **SourceForge**: `sourceforge.net`
- **Git protocol**: URLs starting with `git://`

### Security Audit Process

When a public repository is detected:

1. **Hook activation**: The pre-push hook is triggered by git
2. **Environment check**: Verifies Claude Code is available in PATH
3. **Audit execution**: Runs `claude /audit-public` in the repository
4. **Result evaluation**: Checks the exit code from the audit
5. **Push decision**: Blocks (non-zero exit) or allows (zero exit) the push

### What Gets Audited

The `audit-public` skill checks for:

**BLOCKER Issues** (blocks push):
- Personal usernames and email domains
- Real home paths (`simon//$HOME//simon`, `simon//$HOME//elena`)
- Internal IP addresses (`192.168.x.x`, `10.x.x.x`)
- Credential files (`.credentials.json`, files containing `SSHPASS`, `API_KEY`, `SECRET`)
- Private project names
- Custom patterns from `~/.claude/.audit-blocklist`

**IMPORTANT Issues** (logged but doesn't block):
- Undocumented environment variables
- Missing referenced files in documentation
- Potential secrets in git history

**MINOR Issues** (suggestions):
- Hardcoded localhost ports
- Documentation formatting issues
- Broken markdown links

## Usage Examples

### Normal Push to Private Repository
```bash
$ git push origin main
[INFO] Pre-push hook: checking remote 'origin' with URL 'git@company.com:private/repo.git'
[INFO] Not a public repository, skipping audit
```

### Push to Public Repository (Clean)
```bash
$ git push origin main
[INFO] Pre-push hook: checking remote 'origin' with URL 'git@github.com:user/repo.git'
[WARN] Detected push to public repository: git@github.com:user/repo.git
[INFO] Running security audit before push to public repository...

=== AUDIT RESULTS ===
✅ No BLOCKER issues found
📝 2 MINOR issues (documentation formatting)

[SUCCESS] Security audit passed - no blockers found
[INFO] Push allowed
```

### Push to Public Repository (Blocked)
```bash
$ git push origin main
[INFO] Pre-push hook: checking remote 'origin' with URL 'git@github.com:user/repo.git'
[WARN] Detected push to public repository: git@github.com:user/repo.git
[INFO] Running security audit before push to public repository...

=== AUDIT RESULTS ===
🚫 BLOCKER: Personal username 'simon' found in config.yaml line 15
🚫 BLOCKER: Internal IP address 'localhost0' found in deploy.sh line 23

[ERROR] Security audit failed with exit code 1
[ERROR] PUSH BLOCKED: Found security issues that must be resolved before pushing to public repository
[ERROR] Please fix the BLOCKER issues listed above and try again

[INFO] To bypass this check (NOT RECOMMENDED), you can:
[INFO]   1. Fix the issues and push again
[INFO]   2. Or temporarily disable the hook with: git push --no-verify
```

## Bypassing the Hook (Emergency Use)

⚠️ **WARNING**: Bypassing this hook may expose sensitive data publicly!

If you absolutely must bypass the hook:

```bash
git push --no-verify origin main
```

**Only use this if:**
- You're certain no sensitive data is present
- You've manually reviewed all changes
- This is a temporary emergency situation

## Troubleshooting

### Hook Not Running

1. **Check if hook exists and is executable**:
   ```bash
   ls -la .git/hooks/pre-push
   ```

2. **Verify hook permissions**:
   ```bash
   chmod +x .git/hooks/pre-push
   ```

### Claude Code Not Found

If you see "Claude Code not found in PATH":

1. **Check Claude Code installation**:
   ```bash
   which claude
   claude --version
   ```

2. **Add Claude Code to PATH** (if needed):
   ```bash
   export PATH="/path/to/claude:$PATH"
   ```

### Audit Skill Not Found

If the audit-public skill is not available:

1. **Check available skills**:
   ```bash
   claude --help
   ```

2. **Install or update Claude Code** to get the latest skills

### Hook Failing on Valid Repository

1. **Test the audit manually**:
   ```bash
   claude /audit-public --verbose
   ```

2. **Check for false positives** in the audit results

3. **Update audit blocklist** if needed:
   ```bash
   # Add patterns to skip to ~/.claude/.audit-blocklist
   echo "pattern-to-ignore" >> ~/.claude/.audit-blocklist
   ```

## Customization

### Adding Custom Public Domains

Edit the `is_public_repo()` function in `pre-push-audit.sh` to add more domains:

```bash
if [[ "$url" =~ (github\.com|gitlab\.com|bitbucket\.org|yourcustomdomain\.com) ]]; then
    return 0  # Is public
fi
```

### Modifying Audit Behavior

The hook calls `claude /audit-public`. You can modify this to:

- Add flags: `claude /audit-public --verbose`
- Use different skill: `claude /your-custom-audit-skill`
- Add preprocessing: Run custom scripts before the audit

## Integration with CI/CD

This hook works locally but consider also adding similar checks to your CI/CD pipeline:

```yaml
# Example GitHub Actions workflow
name: Security Audit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Run security audit
      run: |
        # Install Claude Code
        # Run audit
        claude /audit-public
```

## Uninstallation

To remove the hook:

```bash
rm .git/hooks/pre-push
```

To restore a backed-up hook:

```bash
mv .git/hooks/pre-push.backup.YYYYMMDD_HHMMSS .git/hooks/pre-push
```