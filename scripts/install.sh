#!/usr/bin/env bash
#
# CodeEater installer — one script, any platform (Linux / macOS; Windows Git-Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/GeorgeKstr/CodeEater/<ref>/scripts/install.sh | bash
#                                       (public repo; for the private repo use --github / --tarball, see below)
#
#   ./scripts/install.sh                install from THIS checkout (developer mode)
#   ./scripts/install.sh --github       fetch latest from GitHub (git clone, uses your SSH keys / creds)
#   ./scripts/install.sh --tarball      fetch GitHub tarball (set GH_TOKEN for the private repo)
#   ./scripts/install.sh --dir /opt/codeeater --branch main
#   ./scripts/install.sh --skip-build   reuse existing build after a fetch
#   ./scripts/install.sh --skip-deps    never install system packages
#   ./scripts/install.sh --uninstall    remove everything the installer created
#
# What it does (Linux/macOS):
#   1. checks/installs prerequisites (node, npm, python3, make, C compiler, git)
#   2. fetches CodeEater from GitHub (unless run inside a checkout)
#   3. npm install + npm run build (node-pty & better-sqlite3 are rebuilt for Electron)
#   4. installs the `coe` command, app icon and desktop entry
#
# Windows: run scripts/install.ps1 instead (native PowerShell).

set -euo pipefail

# ------------------------------------------------------------------ helpers
if [ -t 1 ]; then
  log() { printf '\033[1;34m[coe]\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m[coe!]\033[0m %s\n' "$*" >&2; }
  die() { printf '\033[1;31m[coe-error]\033[0m %s\n' "$*" >&2; exit 1; }
else
  log() { printf '[coe] %s\n' "$*"; }
  warn() { printf '[coe!] %s\n' "$*" >&2; }
  die() { printf '[coe-error] %s\n' "$*" >&2; exit 1; }
fi
have() { command -v "$1" >/dev/null 2>&1; }

realpath_of() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

SYSTEM="$(uname -s 2>/dev/null || true)"
case "$SYSTEM" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows-gitbash ;;
  *) OS=unsupported ;;
esac

# ------------------------------------------------------------------ options
REPO="GeorgeKstr/CodeEater"
BRANCH="master"
REMOTE_SSH="git@github.com:${REPO}.git"
REMOTE_HTTPS="https://github.com/${REPO}.git"
DO_DEPENDENCIES=1
DO_BUILD=1
DO_FETCH=0        # 1 = fetch from GitHub into INSTALL_DIR
DO_TARBALL=0
DO_UNINSTALL=0
INSTALL_DIR=""
GITHUB_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --github) GITHUB_MODE=1; DO_FETCH=1 ;;
    --tarball) GITHUB_MODE=1; DO_FETCH=1; DO_TARBALL=1 ;;
    --branch) BRANCH="$2"; shift ;;
    --dir) INSTALL_DIR="$2"; shift ;;
    --skip-build) DO_BUILD=0 ;;
    --skip-deps) DO_DEPENDENCIES=0 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --remote) REMOTE_SSH="$2"; REMOTE_HTTPS="$2"; shift ;;
    -h | --help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "unknown option: $1 (ignored)" ;;
  esac
  shift
done

# ----------------------------------------- detect: checkout vs standalone fetch
# When run via `curl | bash`, no script file exists -> we must fetch from GitHub.
SCRIPT_SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_SRC="$(realpath_of "${BASH_SOURCE[0]}")"
fi

if [ "$GITHUB_MODE" = 1 ]; then
  MODE="fetch"
elif [ -n "$SCRIPT_SRC" ] && [ -f "$(dirname "$SCRIPT_SRC")/../package.json" ] && \
     grep -q '"name"[[:space:]]*:[[:space:]]*"codeeater"' "$(dirname "$SCRIPT_SRC")/../package.json"; then
  MODE="local"
else
  MODE="fetch"
fi

if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="${HOME}/.local/share/codeeater"
fi

# ------------------------------------------------------------- uninstall
if [ "$DO_UNINSTALL" = 1 ]; then
  rm -f "${HOME}/.local/bin/coe"
  rm -f "${HOME}/.local/share/applications/codeeater.desktop"
  rm -f "${HOME}/.local/share/icons/codeeater.png"
  if [ "$MODE" != "local" ] && [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "removed $INSTALL_DIR"
  fi
  log "removed: ~/.local/bin/coe, codeeater.desktop, codeeater.png"
  log "PATH lines added by the installer were left in your shell rc (harmless)."
  exit 0
fi

log "CodeEater install  (branch=$BRANCH, mode=${MODE}, os=${OS})"

# ------------------------------------------------------------ prerequisites
if [ "$DO_DEPENDENCIES" = 1 ]; then
  need_node() {
    if ! have node || ! have npm; then
      warn "node.js >= 18 with npm is required (native modules build against Electron)."
      if [ "$OS" = macos ] && have brew; then
        log "installing node via Homebrew…"
        brew install node
      elif [ "$OS" = linux ]; then
        warn "installing via nvm (user-scoped, no sudo)…"
        if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; then
          . "${HOME}/.nvm/nvm.sh" 2>/dev/null || true
          nvm install --lts >/dev/null 2>&1 || die "nvm failed to install node — install node >= 18 manually and re-run."
        else
          die "nvm install failed — install node >= 18 manually and re-run."
        fi
      else
        die "install node >= 18 manually (https://nodejs.org) and re-run."
      fi
    fi
    NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//;s/\..*$//')"
    NODE_MAJOR="${NODE_MAJOR:-0}"
    [ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required (found $(node -v))."
  }
  need_node

  # native build toolchain (node-pty / better-sqlite3 -> node-gyp)
  NATIVE_OK=1
  have python3 || NATIVE_OK=0
  have make || NATIVE_OK=0
  have cc || have clang || have gcc || NATIVE_OK=0
  if [ "$NATIVE_OK" = 0 ]; then
    if [ "$OS" = linux ]; then
      if have apt-get; then
        sudo apt-get update -qq && sudo apt-get install -y -qq python3 make g++ git curl 2>/dev/null \
          || warn "could not install build tools — run: sudo apt-get install -y python3 build-essential git curl"
      elif have dnf; then
        sudo dnf install -y python3 gcc-c++ make git curl 2>/dev/null \
          || warn "could not install build tools — run: sudo dnf install -y python3 gcc-c++ make git"
      elif have pacman; then
        sudo pacman -S --noconfirm --needed python base-devel git 2>/dev/null \
          || warn "could not install build tools — run: sudo pacman -S --needed python base-devel git"
      fi
    elif [ "$OS" = macos ]; then
      if ! xcode-select -p >/dev/null 2>&1; then
        warn "Xcode Command Line Tools are required (python3 + clang + make)."
        log "opening the installer…"
        xcode-select --install 2>/dev/null || true
        warn "finish the CLT install, then re-run this script."
        exit 1
      fi
      have python3 || { warn "python3 not found — install it (brew install python)."; exit 1; }
    fi
    have python3 && have make && { have cc || have clang || have gcc; } \
      || warn "missing build toolchain — npm's postinstall rebuilds node-pty/better-sqlite3 and may fail at runtime."
  fi
fi

have git || die "git is required to fetch from GitHub. Install it and re-run."
have curl || have wget || die "curl or wget is required."

# ------------------------------------------------------------ fetch (github)
ROOT=""
if [ "$MODE" = "local" ]; then
  ROOT="$(dirname "$(dirname "$SCRIPT_SRC")")"
  log "using existing checkout: $ROOT"
else
  if [ -e "$INSTALL_DIR" ]; then
    warn "removing existing install dir: $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  mkdir -p "$INSTALL_DIR"

  if [ "$DO_TARBALL" = 1 ]; then
    log "fetching $REPO tarball (branch $BRANCH)…"
    TARBALL_URL="https://api.github.com/repos/${REPO}/tarball/${BRANCH}"
    TMP_TAR="$(mktemp -d)/coe.tar.gz"
    if [ -n "${GH_TOKEN:-}" ]; then
      curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" -o "$TMP_TAR" "$TARBALL_URL" \
        || die "tarball fetch failed (private repo needs GH_TOKEN)."
    else
      curl -fsSL -o "$TMP_TAR" "$TARBALL_URL" \
        || die "tarball fetch failed (repo may be private — set GH_TOKEN)."
    fi
    tar -xzf "$TMP_TAR" -C "$INSTALL_DIR" --strip-components=1 || die "tarball extract failed."
  else
    log "cloning $REPO (branch $BRANCH) — SSH keys preferred, HTTPS fallback…"
    if git clone --depth 1 --branch "$BRANCH" "$REMOTE_SSH" "$INSTALL_DIR" 2>/dev/null; then
      :
    elif git clone --depth 1 --branch "$BRANCH" "$REMOTE_HTTPS" "$INSTALL_DIR"; then
      :
    else
      die "clone failed. Check your GitHub access (SSH keys / GH_TOKEN / gh auth)."
    fi
  fi
  ROOT="$INSTALL_DIR"
  MODE_AFTER_FETCH="fetch"
fi

# --------------------------------------------------------------------- build
if [ "$DO_BUILD" = 1 ]; then
  if [ ! -d "$ROOT/node_modules" ]; then
    log "installing npm dependencies (this downloads Electron + builds native modules)…"
    (cd "$ROOT" && { [ -f package-lock.json ] && npm ci || npm install; })
  else
    log "dependencies already present — skipping npm install"
  fi
  log "building…"
  (cd "$ROOT" && npm run build)
elif [ ! -f "$ROOT/out/main/index.js" ]; then
  warn "no build found — building anyway…"
  (cd "$ROOT" && npm run build)
fi

[ -f "$ROOT/out/main/index.js" ] || die "build did not produce out/main/index.js"
chmod +x "$ROOT/scripts/coe"

# -------------------------------------------------------- desktop integration
if [ "$OS" = linux ] || [ "$OS" = macos ]; then
  BIN_DIR="${HOME}/.local/bin"
  APP_DIR="${HOME}/.local/share/applications"
  ICON_DIR="${HOME}/.local/share/icons"
  mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

  ln -sf "$ROOT/scripts/coe" "$BIN_DIR/coe"
  log "✓ $BIN_DIR/coe -> $ROOT/scripts/coe"

  if [ -f "$ROOT/build/icon.png" ]; then
    cp "$ROOT/build/icon.png" "$ICON_DIR/codeeater.png"
    log "✓ icon -> $ICON_DIR/codeeater.png"
  else
    warn "build/icon.png missing (run: python3 scripts/make-icon.py)"
  fi

  COE_BIN="$(realpath_of "$BIN_DIR/coe")"
  cat > "$APP_DIR/codeeater.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=CodeEater
Comment=AI-native code editor — fast navigation, concise AI understanding, safe AI edits
Exec=${COE_BIN} %F
Icon=codeeater
Terminal=false
Categories=Development;Utility;TextEditor;
Keywords=editor;code;ai;
StartupWMClass=codeeater
EOF
  log "✓ desktop entry -> $APP_DIR/codeeater.desktop"

  # PATH
  if ! printf '%s' "$PATH" | grep -q "${BIN_DIR}"; then
    RC=""
    case "${SHELL:-/bin/bash}" in
      *zsh) RC="${HOME}/.zshrc" ;;
      *fish) RC="${HOME}/.config/fish/config.fish" ;;
      *) RC="${HOME}/.bashrc" ;;
    esac
    if [ -f "$RC" ] && grep -q "added by CodeEater installer" "$RC"; then
      log "PATH already added in $RC"
    else
      if [ "$(basename "$RC")" = "config.fish" ]; then
        printf '\n# added by CodeEater installer (coe command)\nset -gx PATH %s $PATH\n' "$BIN_DIR" >> "$RC"
      else
        printf '\n# added by CodeEater installer (coe command)\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"
      fi
      log "✓ added $BIN_DIR to PATH in $RC"
      log "  (run \"source $RC\" or open a new terminal)"
    fi
  else
    log "✓ $BIN_DIR already on PATH"
  fi

  if [ "$OS" = macos ]; then
    warn "CodeEater is unsigned — if macOS blocks it, right-click the app and choose Open."
  fi
else
  warn "desktop integration skipped on $OS — on Windows use scripts/install.ps1 for shortcuts."
  mkdir -p "${HOME}/bin"
  ln -sf "$ROOT/scripts/coe" "${HOME}/bin/coe"
  log "✓ ${HOME}/bin/coe -> $ROOT/scripts/coe"
fi

echo
log "Done. Usage:"
log "  coe              open CodeEater"
log "  coe .            open the current folder"
log "  coe ~/project    open a specific folder"
log "  coe -h           help"
echo
log "Tip: run  source ~/.bashrc  (or open a new terminal) if 'coe' is not found."