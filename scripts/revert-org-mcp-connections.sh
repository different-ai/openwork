#!/usr/bin/env bash
set -euo pipefail

# Rollback runbook for org MCP connections (PRs #2406 + #2451 (desktop PR #2439 was superseded by #2451)).
#
# Org MCP connections are generally available, so there is no per-organization
# switch any more: rolling back means reverting code.
#
# Code revert (this script): builds a revert branch from the squash commits on
# origin/dev, newest first, and opens a PR. Reverting #2451 removes the desktop
# side; --all also reverts the server/API PR #2406.
#
# DB note: #2406's tables (external MCP connections, grants) are additive.
# A code revert leaves them in place on purpose — do NOT run destructive
# down-migrations as part of an emergency revert.
#
# Usage:
#   bash scripts/revert-org-mcp-connections.sh            # revert #2451 only (dry run)
#   bash scripts/revert-org-mcp-connections.sh --execute  # create the revert branch
#   bash scripts/revert-org-mcp-connections.sh --all --execute
#   bash scripts/revert-org-mcp-connections.sh --all --execute --push  # + push and open PR

PRS=(2451)
EXECUTE=0
PUSH=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) PRS=(2451 2406) ;;
    --pr) shift; PRS+=("${1:?missing PR number}") ;;
    --execute) EXECUTE=1 ;;
    --push) PUSH=1 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

git fetch origin dev

SHAS=()
for pr in "${PRS[@]}"; do
  sha="$(git log origin/dev --grep "(#${pr})" --format=%H -1)"
  if [ -z "$sha" ]; then
    echo "ERROR: no squash commit for PR #${pr} found on origin/dev — is it merged?" >&2
    exit 1
  fi
  echo "PR #${pr} -> $(git log -1 --oneline "$sha")"
  SHAS+=("$sha")
done

if [ "$EXECUTE" -ne 1 ]; then
  echo ""
  echo "Dry run. Re-run with --execute to create the revert branch."
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty." >&2
  exit 1
fi

BRANCH="revert/org-mcp-connections-$(date -u +%Y%m%d-%H%M)"
git switch -c "$BRANCH" origin/dev
for sha in "${SHAS[@]}"; do
  git revert --no-edit "$sha"
done

echo ""
echo "Revert branch ready: $BRANCH"
if [ "$PUSH" -eq 1 ]; then
  git push origin "$BRANCH"
  gh pr create --base dev --head "$BRANCH" \
    --title "revert: org MCP connections (${PRS[*]/#/#})" \
    --body "Emergency revert of the org MCP connections stack; this removes the code. Additive DB tables are intentionally left in place."
else
  echo "Next: git push origin $BRANCH && gh pr create --base dev --head $BRANCH"
fi
