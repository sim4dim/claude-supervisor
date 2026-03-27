#!/bin/bash
# Global installation script for pre-push audit hook
# This script sets up the hook as a global git template

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

# Paths
HOOK_SOURCE="simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/pre-push-audit.sh"
HOOK_INSTALLER="simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/install-pre-push-audit.sh"
GLOBAL_TEMPLATE_DIR="$HOME/.git-templates/hooks"

# Function to show usage
show_usage() {
    cat <<EOF
Global Pre-Push Audit Hook Installer

This script sets up the pre-push audit hook globally for all new git repositories.

Usage:
    $0 [OPTIONS]

Options:
    --uninstall    Remove the global hook template
    --status       Show current global template status
    --help         Show this help message

What this does:
1. Creates a git template directory with the pre-push hook
2. Configures git to use this template for new repositories
3. Provides a command to easily install the hook in existing repositories

After installation:
- All NEW git repositories will automatically have the hook
- For EXISTING repositories, run the individual installer:
  $HOOK_INSTALLER

EOF
}

# Function to check prerequisites
check_prerequisites() {
    if [[ ! -f "$HOOK_SOURCE" ]]; then
        log_error "Source hook file not found: $HOOK_SOURCE"
        log_error "Please ensure the claude-supervisor project is available."
        exit 1
    fi

    if [[ ! -f "$HOOK_INSTALLER" ]]; then
        log_error "Hook installer script not found: $HOOK_INSTALLER"
        exit 1
    fi
}

# Function to install global template
install_global_template() {
    log_info "Setting up global git template for pre-push audit hook..."

    # Create template directory
    mkdir -p "$GLOBAL_TEMPLATE_DIR"

    # Copy the hook
    cp "$HOOK_SOURCE" "$GLOBAL_TEMPLATE_DIR/pre-push"
    chmod +x "$GLOBAL_TEMPLATE_DIR/pre-push"

    # Configure git to use the template
    git config --global init.templateDir "$HOME/.git-templates"

    log_success "Global git template configured successfully!"
    log_info "Template directory: $GLOBAL_TEMPLATE_DIR"

    # Create a convenience script for existing repositories
    create_convenience_script
}

# Function to create convenience script
create_convenience_script() {
    local script_path="$HOME/bin/install-audit-hook"

    # Create bin directory if it doesn't exist
    mkdir -p "$HOME/bin"

    # Create the convenience script
    cat > "$script_path" << 'EOF'
#!/bin/bash
# Convenience script to install pre-push audit hook in the current repository
INSTALLER="simon//$HOME//simon/projects/claude-supervisor/.claude/hooks/install-pre-push-audit.sh"

if [[ -f "$INSTALLER" ]]; then
    "$INSTALLER" "$@"
else
    echo "Error: Hook installer not found at $INSTALLER"
    echo "Please ensure the claude-supervisor project is available."
    exit 1
fi
EOF

    chmod +x "$script_path"

    log_success "Created convenience script: $script_path"
    log_info "You can now run 'install-audit-hook' in any repository to install the hook"

    # Check if ~/bin is in PATH
    if [[ ":$PATH:" != *":$HOME/bin:"* ]]; then
        log_warn "$HOME/bin is not in your PATH"
        log_info "Add this to your ~/.bashrc or ~/.zshrc:"
        log_info "  export PATH=\"\$HOME/bin:\$PATH\""
    fi
}

# Function to uninstall global template
uninstall_global_template() {
    log_info "Removing global git template..."

    # Remove the template directory
    if [[ -d "$GLOBAL_TEMPLATE_DIR" ]]; then
        rm -rf "$GLOBAL_TEMPLATE_DIR"
        log_success "Removed template directory: $GLOBAL_TEMPLATE_DIR"
    fi

    # Remove the git config (reset to default)
    if git config --global --get init.templateDir >/dev/null 2>&1; then
        git config --global --unset init.templateDir
        log_success "Reset git template directory configuration"
    fi

    # Remove convenience script
    local script_path="$HOME/bin/install-audit-hook"
    if [[ -f "$script_path" ]]; then
        rm "$script_path"
        log_success "Removed convenience script: $script_path"
    fi

    log_success "Global template uninstalled successfully!"
}

# Function to show status
show_status() {
    echo "Global Git Template Status"
    echo "=========================="
    echo

    # Check git config
    local template_dir
    if template_dir=$(git config --global --get init.templateDir 2>/dev/null); then
        log_info "Template directory configured: $template_dir"
    else
        log_warn "No global template directory configured"
    fi

    # Check template hook
    if [[ -f "$GLOBAL_TEMPLATE_DIR/pre-push" ]]; then
        log_success "Pre-push hook template exists: $GLOBAL_TEMPLATE_DIR/pre-push"
        if [[ -x "$GLOBAL_TEMPLATE_DIR/pre-push" ]]; then
            log_success "Hook template is executable"
        else
            log_warn "Hook template is not executable"
        fi
    else
        log_warn "Pre-push hook template not found"
    fi

    # Check convenience script
    local script_path="$HOME/bin/install-audit-hook"
    if [[ -f "$script_path" ]]; then
        log_success "Convenience script exists: $script_path"
        if [[ -x "$script_path" ]]; then
            log_success "Convenience script is executable"
        else
            log_warn "Convenience script is not executable"
        fi
    else
        log_warn "Convenience script not found"
    fi

    # Check PATH
    if [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
        log_success "$HOME/bin is in PATH"
    else
        log_warn "$HOME/bin is not in PATH"
    fi

    echo
    echo "Usage for existing repositories:"
    echo "  cd /path/to/your/repo"
    if [[ -f "$script_path" && ":$PATH:" == *":$HOME/bin:"* ]]; then
        echo "  install-audit-hook"
    else
        echo "  $HOOK_INSTALLER"
    fi
}

# Main function
main() {
    local action="install"

    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --uninstall)
                action="uninstall"
                shift
                ;;
            --status)
                action="status"
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

    case $action in
        install)
            check_prerequisites
            echo "Global Pre-Push Audit Hook Installation"
            echo "======================================"
            echo
            log_info "This will configure git to automatically include the pre-push audit hook"
            log_info "in all NEW repositories created with 'git init'."
            echo
            install_global_template
            echo
            log_info "Installation complete!"
            echo
            log_info "For NEW repositories: The hook will be automatically installed"
            log_info "For EXISTING repositories: Use the convenience script or manual installer"
            echo
            show_status
            ;;
        uninstall)
            uninstall_global_template
            ;;
        status)
            show_status
            ;;
    esac
}

# Run main function with all arguments
main "$@"