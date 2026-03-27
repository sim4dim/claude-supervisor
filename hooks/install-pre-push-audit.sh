#!/bin/bash
# Installation script for pre-push audit hook
# This script can be run in any git repository to install the pre-push audit hook

set -euo pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to log with colors
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

# Path to the source hook file
HOOK_SOURCE="simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/pre-push-audit.sh"

# Function to check if we're in a git repository
check_git_repo() {
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        log_error "Not in a git repository. Please run this script from within a git repository."
        exit 1
    fi
}

# Function to backup existing hook if it exists
backup_existing_hook() {
    local hook_path="$1"

    if [[ -f "$hook_path" ]]; then
        local backup_path="${hook_path}.backup.$(date +%Y%m%d_%H%M%S)"
        log_warn "Existing pre-push hook found. Backing up to: $(basename "$backup_path")"
        cp "$hook_path" "$backup_path"
    fi
}

# Function to install the hook
install_hook() {
    local repo_root
    repo_root=$(git rev-parse --show-toplevel)

    local hooks_dir="$repo_root/.git/hooks"
    local hook_path="$hooks_dir/pre-push"

    # Check if source hook file exists
    if [[ ! -f "$HOOK_SOURCE" ]]; then
        log_error "Source hook file not found: $HOOK_SOURCE"
        log_error "Please ensure the claude-supervisor project is available at the expected location."
        exit 1
    fi

    # Create hooks directory if it doesn't exist
    if [[ ! -d "$hooks_dir" ]]; then
        log_error "Git hooks directory not found: $hooks_dir"
        log_error "This doesn't appear to be a valid git repository."
        exit 1
    fi

    # Backup existing hook
    backup_existing_hook "$hook_path"

    # Copy the hook
    log_info "Installing pre-push audit hook..."
    cp "$HOOK_SOURCE" "$hook_path"
    chmod +x "$hook_path"

    # Verify installation
    if [[ -x "$hook_path" ]]; then
        log_success "Pre-push audit hook installed successfully!"
        log_info "Hook location: $hook_path"
    else
        log_error "Failed to install hook. Check permissions."
        exit 1
    fi
}

# Function to test the hook
test_hook() {
    local repo_root
    repo_root=$(git rev-parse --show-toplevel)

    local hook_path="$repo_root/.git/hooks/pre-push"

    if [[ ! -x "$hook_path" ]]; then
        log_error "Hook not found or not executable: $hook_path"
        return 1
    fi

    log_info "Testing hook with a non-public repository URL..."

    # Test with a non-public URL (should pass without running audit)
    if "$hook_path" "origin" "git@internal.example.com:repo.git" <<<''; then
        log_success "Hook test passed for non-public repository"
    else
        log_error "Hook test failed for non-public repository"
        return 1
    fi
}

# Function to show usage information
show_usage() {
    cat <<EOF
Pre-Push Audit Hook Installer

This script installs a git pre-push hook that automatically runs the audit-public
skill when pushing to public repositories (GitHub, GitLab, etc.).

The hook will:
- Detect pushes to public git hosting services
- Run '/audit-public' skill to scan for sensitive data
- Block the push if BLOCKER level issues are found
- Allow the push to proceed if no blockers are found

Usage:
    $0 [OPTIONS]

Options:
    --test      Test the installed hook
    --help      Show this help message

Installation:
    1. Navigate to your git repository
    2. Run: $0
    3. The hook will be installed and ready to use

The hook can be bypassed (not recommended) with:
    git push --no-verify

EOF
}

# Main function
main() {
    local test_only=false

    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --test)
                test_only=true
                shift
                ;;
            --help)
                show_usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    # Check if we're in a git repository
    check_git_repo

    if [[ "$test_only" == true ]]; then
        log_info "Testing existing pre-push hook..."
        test_hook
    else
        # Show information about what we're going to do
        echo "Pre-Push Audit Hook Installation"
        echo "================================="
        echo
        log_info "This will install a pre-push hook that runs security audits for public repositories."
        log_info "Repository: $(git rev-parse --show-toplevel)"
        echo

        # Install the hook
        install_hook

        echo
        log_info "Installation complete!"
        echo
        log_info "The hook will now automatically run when you push to public repositories like:"
        log_info "  • GitHub (github.com)"
        log_info "  • GitLab (gitlab.com)"
        log_info "  • Bitbucket (bitbucket.org)"
        log_info "  • Other public git hosting services"
        echo
        log_info "To test the installation, run: $0 --test"
        echo
        log_warn "The hook can be bypassed with 'git push --no-verify' but this is NOT recommended"
        log_warn "for public repositories as it may leak sensitive information."
    fi
}

# Run main function with all arguments
main "$@"