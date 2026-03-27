#!/bin/bash
# Pre-push hook that runs audit-public skill for public repositories
# Blocks pushes if BLOCKER level issues are found

set -euo pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to log with colors
log_info() { echo -e "${BLUE}[INFO]${NC} $1" >&2; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1" >&2; }

# Function to check if a URL is a public repository
is_public_repo() {
    local url="$1"

    # Common public git hosting services
    if [[ "$url" =~ (github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sourceforge\.net) ]]; then
        return 0  # Is public
    fi

    # Check for git:// protocol (typically public)
    if [[ "$url" =~ ^git:// ]]; then
        return 0  # Is public
    fi

    return 1  # Not public
}

# Function to run audit-public skill
run_audit() {
    local repo_path="$1"

    log_info "Running security audit before push to public repository..."

    # Change to repository directory
    cd "$repo_path"

    # Check if we have claude command available
    if ! command -v claude >/dev/null 2>&1; then
        log_error "Claude Code not found in PATH. Cannot run audit."
        return 1
    fi

    # Run the audit-public skill
    local audit_output
    local audit_exit_code=0

    # Capture both output and exit code
    audit_output=$(claude /audit-public 2>&1) || audit_exit_code=$?

    # Show the audit output
    echo "$audit_output" >&2

    return $audit_exit_code
}

# Main function
main() {
    local remote="$1"
    local url="$2"

    log_info "Pre-push hook: checking remote '$remote' with URL '$url'"

    # Get the repository root directory
    local repo_root
    repo_root=$(git rev-parse --show-toplevel)

    # Check if this is a push to a public repository
    if ! is_public_repo "$url"; then
        log_info "Not a public repository, skipping audit"
        exit 0
    fi

    log_warn "Detected push to public repository: $url"

    # Run the audit
    if run_audit "$repo_root"; then
        log_success "Security audit passed - no blockers found"
        log_info "Push allowed"
        exit 0
    else
        local exit_code=$?
        log_error "Security audit failed with exit code $exit_code"
        echo >&2
        log_error "PUSH BLOCKED: Found security issues that must be resolved before pushing to public repository"
        log_error "Please fix the BLOCKER issues listed above and try again"
        echo >&2
        log_info "To bypass this check (NOT RECOMMENDED), you can:"
        log_info "  1. Fix the issues and push again"
        log_info "  2. Or temporarily disable the hook with: git push --no-verify"
        exit $exit_code
    fi
}

# Git pre-push hook receives remote name and URL as arguments
# Standard input contains lines with: <local ref> <local sha1> <remote ref> <remote sha1>

if [[ $# -eq 2 ]]; then
    main "$1" "$2"
else
    log_error "Invalid arguments. This script should be called by git as a pre-push hook."
    log_error "Usage: $0 <remote-name> <remote-url>"
    exit 1
fi