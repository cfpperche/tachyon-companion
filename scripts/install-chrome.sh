#!/usr/bin/env bash
# Build + pack Tachyon Companion for Chrome/Chromium and print install paths.
# Optionally launch a browser with the extension preloaded (dogfood only).
#
# IMPORTANT: Google Chrome stable hard-blocks --load-extension
#   ("--load-extension is not allowed in Google Chrome, ignoring.")
# For automated launch we prefer Playwright "Chrome for Testing" / Chromium.
# Manual install into your daily Google Chrome still works via Load unpacked.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LAUNCH=0
if [[ "${1:-}" == "--launch" ]]; then
  LAUNCH=1
fi

node scripts/pack-chrome.mjs

VERSION="$(node -p "require('./apps/browser/package.json').version")"
OUT_DIR="$ROOT/dist/releases/tachyon-companion-browser-${VERSION}"
ZIP="$ROOT/dist/releases/tachyon-companion-browser-${VERSION}.zip"

if [[ ! -f "$OUT_DIR/manifest.json" ]]; then
  echo "install-chrome: pack failed — no manifest in $OUT_DIR" >&2
  exit 1
fi

resolve_browser() {
  # 1) explicit override
  if [[ -n "${TACHYON_CHROME:-}" && -x "${TACHYON_CHROME}" ]]; then
    echo "$TACHYON_CHROME"
    return
  fi
  # 2) Playwright Chromium / Chrome for Testing (supports --load-extension)
  local pw
  for pw in \
    "$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome" \
    "$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome" \
    "$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome" \
    "$HOME/.cache/ms-playwright/chromium-1134/chrome-linux/chrome"
  do
    if [[ -x "$pw" ]]; then
      echo "$pw"
      return
    fi
  done
  # 3) system chromium (not google-chrome — Google brand blocks CLI load)
  for c in chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then
      command -v "$c"
      return
    fi
  done
  # 4) google-chrome only for manual guidance (CLI load will fail)
  for c in google-chrome-stable google-chrome; do
    if command -v "$c" >/dev/null 2>&1; then
      command -v "$c"
      return
    fi
  done
  return 1
}

echo ""
echo "=== Tachyon Companion browser package ==="
echo "  Unpacked: $OUT_DIR"
echo "  Zip:      $ZIP"
echo ""
echo "Manual install (works in Google Chrome):"
echo "  1. Open chrome://extensions"
echo "  2. Turn on Developer mode"
echo "  3. Click \"Load unpacked\""
echo "  4. Select: $OUT_DIR"
echo ""

if [[ "$LAUNCH" -eq 1 ]]; then
  if ! BROWSER="$(resolve_browser)"; then
    echo "install-chrome: no browser binary found" >&2
    exit 1
  fi

  PROFILE="${TACHYON_COMPANION_CHROME_PROFILE:-$ROOT/dist/browser-dogfood-profile}"
  mkdir -p "$PROFILE/Default"

  # Seed Developer mode in chrome://extensions
  python3 - "$PROFILE" <<'PY'
import json, sys
from pathlib import Path
profile = Path(sys.argv[1])
pref = profile / "Default" / "Preferences"
data = {}
if pref.exists():
    try:
        data = json.loads(pref.read_text(encoding="utf-8"))
    except Exception:
        data = {}
data.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
data.setdefault("browser", {})["has_seen_welcome_page"] = True
pref.parent.mkdir(parents=True, exist_ok=True)
pref.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
print(f"seeded developer_mode → {pref}")
PY

  echo "Launching: $BROWSER"
  echo "  profile:   $PROFILE"
  echo "  extension: $OUT_DIR"

  # Detect Google Chrome brand (blocks --load-extension hard).
  if "$BROWSER" --version 2>/dev/null | grep -qi 'Google Chrome' \
    && ! "$BROWSER" --version 2>/dev/null | grep -qi 'Testing\|Chromium'; then
    echo ""
    echo "NOTE: Google Chrome ignores --load-extension (hard block)."
    echo "Opening Chrome on chrome://extensions for manual Load unpacked."
    echo "Select folder: $OUT_DIR"
    nohup "$BROWSER" \
      --user-data-dir="$PROFILE" \
      --no-first-run \
      --no-default-browser-check \
      "chrome://extensions" \
      >/tmp/tachyon-companion-browser.log 2>&1 &
    echo "pid=$!  log=/tmp/tachyon-companion-browser.log"
    exit 0
  fi

  # Chromium / Chrome for Testing: CLI load works with this feature re-enabled.
  nohup "$BROWSER" \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    --disable-sync \
    --disable-features=DisableLoadExtensionCommandLineSwitch \
    --load-extension="$OUT_DIR" \
    --remote-debugging-port="${TACHYON_COMPANION_CDP_PORT:-9229}" \
    "chrome://extensions" \
    >/tmp/tachyon-companion-browser.log 2>&1 &
  echo "pid=$!  log=/tmp/tachyon-companion-browser.log"
  sleep 3
  if grep -q 'not allowed in Google Chrome' /tmp/tachyon-companion-browser.log 2>/dev/null; then
    echo "WARN: browser still blocked CLI load — use Load unpacked: $OUT_DIR" >&2
  fi
  echo "OK — browser started with --load-extension."
  echo "Check chrome://extensions for \"Tachyon Companion\" (Developer mode should be ON)."
  echo "Pair: Tachyon → \"Pair Companion (show code)\" → paste into the popup."
fi
