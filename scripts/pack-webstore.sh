#!/usr/bin/env bash
# pack-webstore.sh — build a Chrome Web Store ZIP from extension source only.
# Excludes tests, docs, scripts, and all dev/repo files.
# Usage: bash scripts/pack-webstore.sh
# Output: evidexa-viewport-<version>.zip in the project root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

VERSION=$(node -p "require('$ROOT/manifest.json').version")
OUT="$ROOT/evidexa-viewport-${VERSION}.zip"

# Remove stale zip if it exists
rm -f "$OUT"

cd "$ROOT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  region-selector.js \
  db.js \
  popup.html popup.js popup.css \
  tab.html tab.js tab.css \
  icons/ \
  lib/ \
  --exclude "*.DS_Store"

echo "✓ Created: $(basename "$OUT")  ($(du -sh "$OUT" | cut -f1))"
