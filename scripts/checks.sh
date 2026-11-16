#!/bin/bash
# Shared local/CI entry point. Never launches the app bundle or real executor.
set -euo pipefail
cd "$(dirname "$0")/.."

run_xctest=true
if [[ "$#" -gt 0 ]]; then
  if [[ "$#" -eq 1 && "$1" == "--without-xctest" ]]; then
    run_xctest=false
  else
    echo "Usage: bash scripts/checks.sh [--without-xctest]" >&2
    exit 2
  fi
fi

swift --version
node --version
python3 --version
swift build -q
BIN_DIR="$(swift build --show-bin-path)"
"$BIN_DIR/printer-cli-checks"
"$BIN_DIR/printer-helper-checks"
"$BIN_DIR/card-renderer-checks"
python3 scripts/smoke_test.py "$BIN_DIR/printer-cli"
python3 scripts/test_install_printer.py
CARD_RENDERER_BIN="$BIN_DIR/card-renderer" python3 -m unittest discover -s Tests/DailyCardTests -v
HELPER_CHECKS_BIN="$BIN_DIR/printer-helper-checks" npm test --prefix bridge
node --test .github/extensions/pocket-printer-preview/test/*.test.mjs

if [[ "$run_xctest" == true ]]; then
  swift test
else
  echo "NOT RUN: XCTest explicitly omitted. This is not a complete CI result; full Xcode is required." >&2
fi
