#!/usr/bin/env bash
# Collect the mechanical facts for a contributor PR review, bound to one head SHA.
# Judgment stays with the reviewer: this never approves, comments, or runs PR code.
#   bash .opencode/skills/review-a-contributor-pr/scripts/pr-facts.sh <pr-number> [owner/repo]
set -euo pipefail
N="${1:?usage: pr-facts.sh <pr-number> [owner/repo]}"
R="${2:-different-ai/openwork}"
none() { if [ -z "$1" ]; then echo "(none)"; else printf '%s\n' "$1"; fi; }

META=$(gh pr view "$N" -R "$R" --json isCrossRepository,headRepositoryOwner,headRepository,headRefOid,labels,author,files)
HEAD=$(jq -r .headRefOid <<<"$META")
DIFF=$(gh api -H "Accept: application/vnd.github.v3.diff" "repos/$R/pulls/$N")
FILES=$(jq -r '.files[].path' <<<"$META")

echo "## Head"
jq -r '"fork: \(.isCrossRepository)\nhead: \(.headRepositoryOwner.login)/\(.headRepository.name)@\(.headRefOid)\nauthor: \(.author.login)\nlabels: \([.labels[].name] | join(", "))"' <<<"$META"
echo "files: $(grep -c . <<<"$FILES" || true), diff lines: $(wc -l <<<"$DIFF" | tr -d ' ')"
[ "$(jq -r '.files | length' <<<"$META")" -ge 300 ] && echo "WARNING: 300+ files; GitHub caps the comparison list, a maintainer carry is required"

echo; echo "## ee/ files (CLA notice applies)"
none "$(grep '^ee/' <<<"$FILES" || true)"

echo; echo "## Review machinery and dependency files"
none "$(grep -E '^\.github/|^warden\.toml$|^\.warden/|^\.agents/skills/|^\.claude/skills/|(^|/)opencode\.json$|^\.opencode/|pnpm-lock\.yaml$' <<<"$FILES" || true)"

echo; echo "## Warden on $HEAD"
none "$(gh api "repos/$R/commits/$HEAD/check-runs" --paginate --jq '.check_runs[] | select(.name | startswith("warden")) | "check \(.name): \(.conclusion // .status)"')"
none "$(gh api "repos/$R/commits/$HEAD/status" --jq '.statuses[] | select(.context | startswith("contributor-pr")) | "status \(.context): \(.state) \(.description)"')"
none "$(gh pr view "$N" -R "$R" --json reviews --jq '.reviews[] | select(.author.login == "diff-warden") | "diff-warden review: \(.state)"')"

echo; echo "## Added lines touching IPC, network, processes, eval"
none "$(awk '/^diff --git/ { file = $4; sub(/^b\//, "", file) }
  /^\+[^+]/ && /(ipcMain|ipcRenderer|contextBridge|exposeInMainWorld|webContents\.send|handle\(|fetch\(|http\.|https\.|net\.|WebSocket|child_process|spawn\(|exec\(|shell\.openExternal|eval\(|new Function)/ { print file ": " substr($0, 1, 160) }' <<<"$DIFF" | head -50)"

echo; echo "## Added package.json lines"
none "$(awk '/^diff --git/ { pkg = /package\.json/ } pkg && /^\+ +"/' <<<"$DIFF")"

NOW=$(gh pr view "$N" -R "$R" --json headRefOid --jq .headRefOid)
echo
if [ "$NOW" != "$HEAD" ]; then echo "WARNING: head moved to $NOW during collection. Rerun."; exit 1; fi
echo "All facts above are for $HEAD. Read the full diff yourself: gh pr diff $N -R $R"
