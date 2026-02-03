#!/bin/bash
# Check if Cargo.lock is up to date with --locked flag
# Exit 0 if OK, exit 1 if needs update

set -e

CARGO_TOML="${1:-packages/desktop/src-tauri/Cargo.toml}"

echo "🔍 Checking Cargo.lock status for: $CARGO_TOML"

if cargo check --manifest-path "$CARGO_TOML" --locked 2>&1; then
    echo "✅ Cargo.lock is up to date"
    exit 0
else
    echo "❌ Cargo.lock needs update"
    echo ""
    echo "To fix, run:"
    echo "  cd $(dirname "$CARGO_TOML") && cargo update --workspace"
    exit 1
fi
