#!/usr/bin/env bash
# Bifrost installer — works on macOS, Linux, and Termux (Android)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gorlitzer-labs/bifrost/main/install.sh | bash
#
# Or clone and run:
#   git clone https://github.com/gorlitzer-labs/bifrost && cd bifrost && bash install.sh

set -euo pipefail

REPO="gorlitzer-labs/bifrost"
# Pin to a tag for reproducible installs. Override with: BIFROST_REF=main bash install.sh
BIFROST_REF="${BIFROST_REF:-v1.5.0}"
RAW_URL="https://raw.githubusercontent.com/$REPO/$BIFROST_REF"

# ── Colors ──
C='\033[36m' G='\033[32m' Y='\033[33m' R='\033[31m'
D='\033[2m' B='\033[1m' N='\033[0m'

info()  { echo -e "  ${G}✓${N} $1"; }
warn()  { echo -e "  ${Y}⚠${N} $1"; }
err()   { echo -e "  ${R}✗${N} $1"; }
step()  { echo -e "\n${B}$1${N}"; }

# ── Platform detection ──
detect_platform() {
  if [[ -d "/data/data/com.termux" ]]; then
    echo "termux"
  elif [[ "$(uname)" == "Darwin" ]]; then
    echo "macos"
  else
    echo "linux"
  fi
}

PLATFORM=$(detect_platform)

echo -e "
${C}  ╔╗ ╦╔═╗╦═╗╔═╗╔═╗╔╦╗${N}  ${D}installer${N}
${C}  ╠╩╗║╠═ ╠╦╝║ ║╚═╗ ║${N}
${C}  ╚═╝╩╚  ╩╚═╚═╝╚═╝ ╩${N}
"
echo -e "  Platform: ${B}$PLATFORM${N}"

# ── Install dependencies ──
step "Installing dependencies..."

case "$PLATFORM" in
  termux)
    # Update package list
    pkg update -y 2>/dev/null || apt update -y 2>/dev/null

    # Core dependencies
    for pkg_name in tmux openssh curl; do
      if command -v "$pkg_name" &>/dev/null; then
        info "$pkg_name already installed"
      else
        echo -e "  ${D}Installing $pkg_name...${N}"
        pkg install -y "$pkg_name" 2>/dev/null || apt install -y "$pkg_name" 2>/dev/null
        info "$pkg_name installed"
      fi
    done

    # Tailscale for Android — can't install via pkg, needs the app
    if ! command -v tailscale &>/dev/null; then
      warn "Tailscale — install the Tailscale app from Google Play"
      echo -e "    ${D}https://play.google.com/store/apps/details?id=com.tailscale.ipn${N}"
      echo -e "    ${D}Then: Settings → Developer → Enable CLI in Termux${N}"
    else
      info "Tailscale available"
    fi
    ;;

  macos)
    # Check for Homebrew
    if ! command -v brew &>/dev/null; then
      warn "Homebrew not found — install from https://brew.sh"
      echo -e "    ${D}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${N}"
    fi

    # tmux
    if command -v tmux &>/dev/null; then
      info "tmux already installed"
    elif command -v brew &>/dev/null; then
      echo -e "  ${D}Installing tmux...${N}"
      brew install tmux
      info "tmux installed"
    else
      err "tmux not found — brew install tmux"
    fi

    # iTerm2 (optional but recommended)
    if [[ -d "/Applications/iTerm.app" ]]; then
      info "iTerm2 installed"
    else
      warn "iTerm2 not found (optional — enables visual grid workspace)"
      echo -e "    ${D}brew install --cask iterm2${N}"
    fi

    # Tailscale
    if command -v tailscale &>/dev/null; then
      info "Tailscale available"
    elif [[ -d "/Applications/Tailscale.app" ]]; then
      info "Tailscale app installed"
    else
      warn "Tailscale not found"
      echo -e "    ${D}brew install --cask tailscale${N}"
    fi
    ;;

  linux)
    # tmux
    if command -v tmux &>/dev/null; then
      info "tmux already installed"
    elif command -v apt &>/dev/null; then
      echo -e "  ${D}Installing tmux...${N}"
      sudo apt install -y tmux
      info "tmux installed"
    elif command -v dnf &>/dev/null; then
      echo -e "  ${D}Installing tmux...${N}"
      sudo dnf install -y tmux
      info "tmux installed"
    elif command -v pacman &>/dev/null; then
      echo -e "  ${D}Installing tmux...${N}"
      sudo pacman -S --noconfirm tmux
      info "tmux installed"
    else
      err "tmux not found — install it with your package manager"
    fi

    # Tailscale
    if command -v tailscale &>/dev/null; then
      info "Tailscale available"
    else
      warn "Tailscale not found"
      echo -e "    ${D}curl -fsSL https://tailscale.com/install.sh | sh${N}"
    fi
    ;;
esac

# SSH
if command -v ssh &>/dev/null; then
  info "ssh available"
else
  err "ssh not found — this shouldn't happen"
fi

# ── Install bifrost ──
step "Installing bifrost..."

# Determine install path
if [[ "$PLATFORM" == "termux" ]]; then
  INSTALL_DIR="$HOME/bin"
else
  # Prefer ~/bin, fall back to /usr/local/bin
  if [[ -d "$HOME/bin" ]] || [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
    INSTALL_DIR="$HOME/bin"
  elif [[ -d "$HOME/.local/bin" ]]; then
    INSTALL_DIR="$HOME/.local/bin"
  else
    INSTALL_DIR="$HOME/bin"
  fi
fi

mkdir -p "$INSTALL_DIR"

# Download or copy bifrost
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/bifrost" ]]; then
  # Running from cloned repo
  cp "$SCRIPT_DIR/bifrost" "$INSTALL_DIR/bifrost"
  info "Copied from local repo"
else
  # Download from GitHub (pinned to $BIFROST_REF)
  curl -fsSL "$RAW_URL/bifrost" -o "$INSTALL_DIR/bifrost"
  info "Downloaded $BIFROST_REF from GitHub"
fi

# Sanity check: must be a shell script, not an error page.
if ! head -1 "$INSTALL_DIR/bifrost" | grep -qE '^#!.*\b(bash|sh)\b'; then
  err "Downloaded file is not a shell script — aborting install."
  err "  First line: $(head -1 "$INSTALL_DIR/bifrost")"
  rm -f "$INSTALL_DIR/bifrost"
  exit 1
fi

chmod +x "$INSTALL_DIR/bifrost"
info "Installed to $INSTALL_DIR/bifrost"

# Ensure install dir is in PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  # Detect shell config file
  local_shell=$(basename "${SHELL:-/bin/bash}")
  case "$local_shell" in
    zsh)  rc_file="$HOME/.zshrc" ;;
    bash) rc_file="$HOME/.bashrc" ;;
    *)    rc_file="$HOME/.profile" ;;
  esac

  if [[ "$PLATFORM" == "termux" ]]; then
    rc_file="$HOME/.bashrc"
  fi

  echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$rc_file"
  export PATH="$INSTALL_DIR:$PATH"
  info "Added $INSTALL_DIR to PATH in $rc_file"
fi

# ── Generate tmux.conf ──
step "Generating tmux.conf..."

"$INSTALL_DIR/bifrost" version
mkdir -p "$HOME/.config/bifrost"

# Generate platform-aware tmux.conf
MOUSE="on"
[[ "$PLATFORM" == "termux" ]] && MOUSE="off"

# Back up any existing tmux.conf so user customizations aren't silently lost.
if [[ -f "$HOME/.config/bifrost/tmux.conf" ]]; then
  cp "$HOME/.config/bifrost/tmux.conf" "$HOME/.config/bifrost/tmux.conf.bak"
fi

cat > "$HOME/.config/bifrost/tmux.conf" <<TMUXCONF
# Bifrost tmux.conf — generated by installer
# Platform: $PLATFORM

set -g status on
set -g status-position top
set -g status-style "bg=default,fg=white"
set -g status-left-length 30
set -g pane-border-status top
set -g pane-border-format " #{pane_title} "
set -g mouse $MOUSE
setw -g mode-keys vi
set -g default-terminal "screen-256color"
set -g set-titles on
set -g set-titles-string "#S"
TMUXCONF

info "tmux.conf generated (mouse: $MOUSE)"

# ── Termux extras ──
if [[ "$PLATFORM" == "termux" ]]; then
  step "Termux extras..."

  # Create Termux:Widget shortcut
  WIDGET_DIR="$HOME/.shortcuts"
  mkdir -p "$WIDGET_DIR"

  cat > "$WIDGET_DIR/bifrost-gateway" <<'SHORTCUT'
#!/usr/bin/env bash
# Termux:Widget shortcut — opens bifrost gateway
bifrost gateway
SHORTCUT
  chmod +x "$WIDGET_DIR/bifrost-gateway"
  info "Widget shortcut: bifrost-gateway"

  cat > "$WIDGET_DIR/bifrost-workspace" <<'SHORTCUT'
#!/usr/bin/env bash
# Termux:Widget shortcut — launches bifrost workspace
bifrost workspace
SHORTCUT
  chmod +x "$WIDGET_DIR/bifrost-workspace"
  info "Widget shortcut: bifrost-workspace"

  cat > "$WIDGET_DIR/bifrost-sessions" <<'SHORTCUT'
#!/usr/bin/env bash
# Termux:Widget shortcut — shows all sessions
bifrost sessions
SHORTCUT
  chmod +x "$WIDGET_DIR/bifrost-sessions"
  info "Widget shortcut: bifrost-sessions"

  echo ""
  echo -e "  ${D}Install Termux:Widget from F-Droid for home screen shortcuts.${N}"
  echo -e "  ${D}Long-press home → Widgets → Termux:Widget${N}"
fi

# ── Done ──
step "Done!"
echo ""
echo -e "  ${B}bifrost${N} is ready. Next steps:"
echo ""
echo -e "  ${G}bifrost doctor${N}            ${D}check everything${N}"
echo -e "  ${G}bifrost realm scan${N}         ${D}find your machines${N}"
echo -e "  ${G}bifrost realm add${N} <name>   ${D}add a realm${N}"
echo -e "  ${G}bifrost workspace${N}          ${D}launch${N}"
echo ""

if [[ "$PLATFORM" == "termux" ]]; then
  echo -e "  ${Y}Termux tip:${N} Scroll with Ctrl-b [ then arrow keys."
  echo -e "  ${Y}Keyboard:${N}  Mouse mode is off — your soft keyboard just works."
  echo ""
fi
