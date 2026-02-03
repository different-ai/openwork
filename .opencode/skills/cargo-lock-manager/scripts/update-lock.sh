#!/bin/bash
# Update Cargo.lock for the Tauri workspace

set -e

CARGO_TOML="${1:-packages/desktop/src-tauri/Cargo.toml}"
WORKDIR=$(dirname "$CARGO_TOML")

echo "📦 Updating Cargo.lock in: $WORKDIR"

cd "$WORKDIR"
cargo update --workspace

echo ""
echo "✅ Cargo.lock updated"
echo "📝 Don't forget to commit the changes!"
