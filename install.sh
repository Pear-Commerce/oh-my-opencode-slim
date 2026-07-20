#!/usr/bin/env bash
#
# Pear oh-my-opencode-slim — team installer
#
# Usage:
#   ./install.sh                 # install from this repo (script's own dir)
#   ./install.sh /path/to/clone  # install from a specific clone directory
#   ./install.sh --dry-run       # preview what would happen, write nothing
#   ./install.sh --help
#
# What this does:
#   1. Verifies prerequisites (bun required; opencode CLI optional).
#   2. Builds the plugin (bun install && bun run build) -> dist/index.js.
#   3. Installs three OpenCode config files into ~/.config/opencode/:
#        - opencode.jsonc             (generated from pear-config/opencode.jsonc.template,
#                                      with the plugin path patched to <clone>/dist/index.js)
#        - oh-my-opencode-slim.json   (copied from pear-config/)
#        - tui.json                   (copied from pear-config/)
#      Any existing file is backed up to <name>.bak.<timestamp> before it is overwritten.
#   4. Prints the manual next steps (provider auth, model refresh, restart).
#
# Works with both OpenCode Desktop (macOS .app) and the opencode CLI. Desktop
# reads the same ~/.config/opencode/ location, so the config install is
# identical; only the auth/restart next steps differ (detected automatically).
#
# Team flow:
#   git clone git@github.com:Pear-Commerce/oh-my-opencode-slim.git ~/oh-my-opencode-slim
#   cd ~/oh-my-opencode-slim
#   ./install.sh
#
# Update later:
#   git pull && ./install.sh
#
set -euo pipefail

DRY_RUN=false
REPO_DIR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) REPO_DIR="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR}"

# --- Validate repo dir -------------------------------------------------------
if [ ! -f "$REPO_DIR/package.json" ] || ! grep -q '"oh-my-opencode-slim"' "$REPO_DIR/package.json" 2>/dev/null; then
  echo "ERROR: $REPO_DIR does not look like the oh-my-opencode-slim fork" >&2
  echo "       (expected package.json with name 'oh-my-opencode-slim')." >&2
  exit 1
fi
CONFIG_SRC="$REPO_DIR/pear-config"
if [ ! -d "$CONFIG_SRC" ]; then
  echo "ERROR: $CONFIG_SRC not found — repo is missing Pear config templates." >&2
  exit 1
fi
for f in opencode.jsonc.template oh-my-opencode-slim.json tui.json; do
  if [ ! -f "$CONFIG_SRC/$f" ]; then
    echo "ERROR: $CONFIG_SRC/$f missing." >&2
    exit 1
  fi
done

OPENCODE_DIR="$HOME/.config/opencode"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

echo "Repo:       $REPO_DIR"
echo "Config dir: $OPENCODE_DIR"
echo "Dry run:    $DRY_RUN"
echo

# --- Prerequisites -----------------------------------------------------------
# bun is required to build the plugin. The opencode CLI is NOT required —
# OpenCode Desktop reads the same ~/.config/opencode/ config and has no CLI.
# We detect Desktop and tailor the next-steps accordingly.
if ! command -v bun >/dev/null 2>&1; then
  # Fall back to common bun locations for non-interactive shells whose
  # profile hasn't exported ~/.bun/bin onto PATH.
  for _b in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [ -x "$_b" ]; then export PATH="$(dirname "$_b"):$PATH"; break; fi
  done
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: 'bun' not found in PATH. Install it from https://bun.sh first." >&2
  exit 1
fi

DESKTOP_APP=""
if [ -d "/Applications/OpenCode.app" ]; then
  DESKTOP_APP="/Applications/OpenCode.app"
elif [ -d "$HOME/Applications/OpenCode.app" ]; then
  DESKTOP_APP="$HOME/Applications/OpenCode.app"
fi
HAS_OPENCODE_CLI=false
command -v opencode >/dev/null 2>&1 && HAS_OPENCODE_CLI=true

if [ -n "$DESKTOP_APP" ] && [ "$HAS_OPENCODE_CLI" = false ]; then
  echo "OpenCode:    Desktop ($DESKTOP_APP)"
elif [ -n "$DESKTOP_APP" ] && [ "$HAS_OPENCODE_CLI" = true ]; then
  echo "OpenCode:    Desktop ($DESKTOP_APP) + CLI on PATH"
elif [ "$HAS_OPENCODE_CLI" = true ]; then
  echo "OpenCode:    CLI"
else
  echo "WARN: neither OpenCode Desktop nor the opencode CLI was detected." >&2
  echo "      The config will still be installed to $OPENCODE_DIR," >&2
  echo "      but install OpenCode (https://opencode.ai) before using it." >&2
fi

# --- Build -------------------------------------------------------------------
echo "==> Building plugin (bun install && bun run build)"
if [ "$DRY_RUN" = true ]; then
  echo "    (skipped in dry-run)"
else
  (cd "$REPO_DIR" && bun install && bun run build)
fi
PLUGIN_PATH="$REPO_DIR/dist/index.js"
if [ "$DRY_RUN" = false ] && [ ! -f "$PLUGIN_PATH" ]; then
  echo "ERROR: build did not produce $PLUGIN_PATH" >&2
  exit 1
fi
echo

# --- Install config files ----------------------------------------------------
mkdir -p "$OPENCODE_DIR"

backup_if_exists() {
  local dest="$1"
  if [ -f "$dest" ]; then
    local bak="$dest.bak.$TIMESTAMP"
    echo "==> Backing up existing $(basename "$dest") -> $bak"
    [ "$DRY_RUN" = true ] || cp -p "$dest" "$bak"
  fi
}

install_copy() {
  local src="$1" dest="$2"
  backup_if_exists "$dest"
  echo "==> Installing $(basename "$dest")"
  [ "$DRY_RUN" = true ] || cp -p "$src" "$dest"
}

# opencode.jsonc is GENERATED from the template with the plugin path substituted.
TEMPLATE="$CONFIG_SRC/opencode.jsonc.template"
TARGET="$OPENCODE_DIR/opencode.jsonc"
backup_if_exists "$TARGET"
echo "==> Generating opencode.jsonc (plugin path: $PLUGIN_PATH)"
if [ "$DRY_RUN" = false ]; then
  sed "s|__OMO_PLUGIN_PATH__|$PLUGIN_PATH|g" "$TEMPLATE" > "$TARGET"
fi

# The other two are copied verbatim (portable, no per-user values).
install_copy "$CONFIG_SRC/oh-my-opencode-slim.json" "$OPENCODE_DIR/oh-my-opencode-slim.json"
install_copy "$CONFIG_SRC/tui.json"                 "$OPENCODE_DIR/tui.json"

echo
echo "Done."
echo
echo "Next steps (manual — the installer cannot do these for you):"
echo
if [ -n "$DESKTOP_APP" ]; then
  echo "  You're running OpenCode Desktop. Config is loaded at startup, so:"
  echo "  1. If OpenCode Desktop is running, quit it completely (Cmd-Q), then reopen."
  echo "  2. (One-time UI setup) To get the 3-option new-session dialog"
  echo "     (agent + model + effort) instead of the 2-option view (model + effort),"
  echo "     enable Show agent: ctrl+p -> Settings -> General -> Show agent -> ON."
  echo "     This persists across restarts. opencode has no config field for this,"
  echo "     so it must be toggled in the UI once per machine."
  echo "  3. In Desktop, sign in to OpenRouter and Fireworks AI via the in-app"
  echo "     auth flow (Settings / account). Pear uses both providers."
  echo "     Alternatively, export FIREWORKS_API_KEY in your shell profile."
  echo "  4. Confirm the GLM 5.2 model is visible in the Desktop model picker:"
  echo "       fireworks-ai/accounts/fireworks/models/glm-5p2"
  echo "     If not, refresh models in the picker."
else
  echo "  1. Log in to the providers Pear uses (OpenRouter + Fireworks AI):"
  echo "       opencode auth login"
  echo "     If you prefer an API key for Fireworks, export FIREWORKS_API_KEY."
  echo "  2. Refresh the model list and confirm GLM 5.2 is visible:"
  echo "       opencode models --refresh"
  echo "     You should see 'fireworks-ai/accounts/fireworks/models/glm-5p2'."
  echo "  3. Restart opencode (config is loaded once at startup)."
  echo "  4. (One-time UI setup) If the new-session dialog shows only model + effort"
  echo "     with no agent picker, enable Show agent: ctrl+p -> Settings -> Show agent -> ON."
fi
echo
echo '  Note: auto-accept permissions is pre-configured ("permission": "allow" in'
echo '  opencode.jsonc), so tool calls run without approval prompts. To re-enable'
echo '  prompts, change "permission" in ~/.config/opencode/opencode.jsonc.'
echo
echo "Update later:  git pull && ./install.sh"
