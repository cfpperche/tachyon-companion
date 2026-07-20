#!/usr/bin/env bash
# Build + pack Tachyon Companion for Chrome and print install paths.
# Optionally launch Chrome with the extension preloaded (dogfood only).
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

# Prefer a desktop Chrome; fall back to chromium.
CHROME="${TACHYON_CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for c in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then
      CHROME="$(command -v "$c")"
      break
    fi
  done
fi

echo ""
echo "=== Tachyon Companion Chrome package ==="
echo "  Unpacked: $OUT_DIR"
echo "  Zip:      $ZIP"
echo ""
echo "Manual install:"
echo "  1. Open chrome://extensions"
echo "  2. Turn on Developer mode"
echo "  3. Click \"Load unpacked\""
echo "  4. Select: $OUT_DIR"
echo ""

if [[ "$LAUNCH" -eq 1 ]]; then
  if [[ -z "$CHROME" ]]; then
    echo "install-chrome: no Chrome binary found (set TACHYON_CHROME=...)" >&2
    exit 1
  fi
  PROFILE="${TACHYON_COMPANION_CHROME_PROFILE:-$ROOT/dist/chrome-dogfood-profile}"
  mkdir -p "$PROFILE"
  echo "Launching: $CHROME"
  echo "  profile:  $PROFILE"
  echo "  extension:$OUT_DIR"
  # Isolated profile so we do not touch the user's main Chrome.
  exec "$CHROME" \
    --user-data-dir="$PROFILE" \
    --disable-extensions-except="$OUT_DIR" \
    --load-extension="$OUT_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "chrome://extensions" \
    >/dev/null 2>&1 &
  echo "Chrome started in background (dogfood profile)."
  echo "Then: pair with Tachyon → command \"Tachyon: Pair Companion (show code)\"."
fi
