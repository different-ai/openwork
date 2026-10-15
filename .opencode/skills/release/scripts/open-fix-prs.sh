#!/usr/bin/env bash
# List open PRs that could block a release: fix PRs opened since the previous
# stable tag, fork PRs updated since then, and fork crash/startup fixes of any age.
#   bash .opencode/skills/release/scripts/open-fix-prs.sh [owner/repo]
set -euo pipefail
R="${1:-different-ai/openwork}"
PREV=$(gh release list -R "$R" --exclude-drafts --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName')
SINCE=$(gh release view "$PREV" -R "$R" --json createdAt --jq '.createdAt')
PRS=$(gh pr list -R "$R" --state open --base dev --limit 2000 \
  --json number,title,body,isCrossRepository,createdAt,updatedAt,url)

echo "previous stable tag $PREV created $SINCE"
echo
echo "## Since $PREV: fix PRs, and fork PRs updated"
jq -r --arg since "$SINCE" '[.[]
  | select((.createdAt >= $since
            and ((.title + " " + (.body // "")) | test("fix\\(app\\)|crash|blank|white screen|regression|first launch"; "i")))
           or (.isCrossRepository and .updatedAt >= $since))
  | "#\(.number)\(if .isCrossRepository then " [FORK]" else "" end) \(.title) \(.url)"]
  | if length == 0 then "(none)" else .[] end' <<<"$PRS"
echo
echo "## Fork backlog, any age: crash or startup fixes"
jq -r '[.[] | select(.isCrossRepository
    and ((.title + " " + (.body // "")) | test("crash|blank|white screen|first launch|regression"; "i")))
  | "#\(.number) \(.title) \(.url)"]
  | if length == 0 then "(none)" else .[] end' <<<"$PRS"
