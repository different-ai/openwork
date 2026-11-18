#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "${BASH_SOURCE[0]}")/upgrade-and-migration.mjs"
