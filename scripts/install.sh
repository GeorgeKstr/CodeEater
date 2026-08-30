#!/usr/bin/env bash
#
# Install CodeEater's `coe` command and desktop integration.
#
#   ./scripts/install.sh            install to ~/.local/bin + desktop entry
#   ./scripts/install.sh --skip-build   reuse the existing build
#   ./scripts/install.sh --uninstall    remove everything it installed
#
# Result:
#   ~/.local/bin/coe                 the launcher (symlink into this repo)
#   ~/.local/share/applications/codeeater.desktop
#   ~/.local/share/icons/codeeater.png
#   PATH updated via ~/.bashrc / ~/.zshrc when needed

set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(dirname "$(dirname "$SCRIPT")")"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons"

DO_BUILD=1
DO_UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --skip-build) DO_BUILD=0 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

uninstall() {
  rm -f "$BIN_DIR/coe"
  rm -f "$APP_DIR/codeeater.desktop"
  rm -f "$ICON_DIR/codeeater.png"
  echo "Removed: $BIN_DIR/coe, codeeater.desktop, codeeater.png"
  echo "PATH entries added by the installer were left in your shell rc (harmless)."
}

if [ "$DO_UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi

echo "CodeEater install"
echo "  repo: $ROOT"

if [ "$DO_BUILD" = 1 ]; then
  echo "Building (npm run build)…"
  (cd "$ROOT" && npm run build)
elif [ ! -f "$ROOT/out/main/index.js" ]; then
  echo "No build found — building anyway…"
  (cd "$ROOT" && npm run build)
fi
chmod +x "$ROOT/scripts/coe"

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

# 1. launcher
ln -sf "$ROOT/scripts/coe" "$BIN_DIR/coe"
echo "  ✓ $BIN_DIR/coe -> $(readlink -f "$BIN_DIR/coe")"

# 2. icon
if [ -f "$ROOT/build/icon.png" ]; then
  cp "$ROOT/build/icon.png" "$ICON_DIR/codeeater.png"
  echo "  ✓ icon -> $ICON_DIR/codeeater.png"
else
  echo "  ! build/icon.png missing (run: python3 scripts/make-icon.py)"
fi

# 3. desktop entry
COE_BIN="$(readlink -f "$BIN_DIR/coe")"
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
echo "  ✓ $APP_DIR/codeeater.desktop"

# 4. PATH
if ! printf '%s' "$PATH" | grep -q "${BIN_DIR}"; then
  LINES=(
    ""
    '# added by CodeEater installer (coe command)'
    "export PATH=\"\${HOME}/.local/bin:\$PATH\""
  )
  case "${SHELL:-/bin/bash}" in
    *zsh)
      RC="${HOME}/.zshrc"
      ;;
    *)
      RC="${HOME}/.bashrc"
      ;;
  esac
  if [ -f "$RC" ] && grep -q "added by CodeEater installer" "$RC"; then
    echo "  ! PATH already added to $RC"
  else
    printf '%s\n' "${LINES[@]}" >> "$RC"
    echo "  ✓ added ~/.local/bin to PATH in $RC"
    echo "    (run \"source $RC\" in this shell, or open a new terminal)"
  fi
else
  echo "  ✓ ~/.local/bin already on PATH"
fi

echo
echo "Done. Usage:"
echo "  coe              open CodeEater"
echo "  coe .            open the current folder"
echo "  coe ~/project    open a specific folder"
echo "  coe -h           help"
echo
echo "Tip: run  source ~/.bashrc  (or open a new terminal) if 'coe' is not found."