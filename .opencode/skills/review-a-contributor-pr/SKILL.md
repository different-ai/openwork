---
name: review-a-contributor-pr
description: Review a fork PR, review an external contributor PR, check DCO sign-off, check ee/ CLA, carry a fork commit into a same-repo branch, is this PR safe to merge. Checklist for pull requests from forks before a human approves or merges them.
---

# Skill: review-a-contributor-pr

Use for every PR whose head is not in `different-ai/openwork`
(`isCrossRepository: true`). Fork PRs get no automatic clearance: `warden.yml`
skips them (`head.repo.full_name == github.repository`, no secrets on fork
heads) and `warden-clearance.yml` refuses them. Nothing enforces DCO or the
`ee/` CLA today either; two external commits were merged on 2026-09-09 without
`Signed-off-by`. Open PRs #4733 (fork guard: DCO + `ee/` label status) and
#4709 (DCO + EE CLA policy and status gate) will automate parts of this; this
checklist does not depend on them and stays required after they land, because
they gate the contributor, not the reviewer.

Every item must be answered explicitly in the review comment. `Blocked` on any
item means no approval and no merge.

```bash
export R=different-ai/openwork N=<pr-number>
gh pr view $N -R $R --json isCrossRepository,headRepositoryOwner,headRepository,headRefOid,labels,files,author \
  --jq '{fork: .isCrossRepository, head: "\(.headRepositoryOwner.login)/\(.headRepository.name)@\(.headRefOid[:10])", author: .author.login, labels: [.labels[].name], ee: [.files[].path | select(startswith("ee/"))]}'
```

## 1. DCO: every commit carries Signed-off-by

CONTRIBUTING.md section 1: every commit must certify the DCO with a
`Signed-off-by: Name <email>` trailer. Check every non-merge commit on the PR
head, not just the last one:

```bash
gh api "repos/$R/pulls/$N/commits" --paginate \
  --jq '.[] | select(.parents | length == 1)
    | "\(.sha[:10]) author=\(.commit.author.email) signed_off=\(.commit.message | test("(?m)^Signed-off-by: .+ <.+>$")) \(.commit.message | split("\n")[0])"'
```

- Any `signed_off=false` -> Blocked. Ask the contributor to
  `git rebase --signoff origin/dev && git push --force-with-lease`. Do not
  add the trailer yourself; only the author can certify.
- The sign-off email should match the commit author email (or the author's
  GitHub noreply address). A trailer naming someone else is not that author's
  certification.
- Squash-merging does not repair this: the squash commit inherits the PR
  body, and the trailers of the original commits are lost. Fix the commits
  first.

## 2. ee/ paths need a CLA on file

CONTRIBUTING.md section 2: anything under `ee/` additionally needs an
Individual or Corporate CLA. Renames out of `ee/` count.

```bash
gh pr view $N -R $R --json files --jq '[.files[].path | select(startswith("ee/"))] | length'
gh pr view $N -R $R --json labels --jq '[.labels[].name] | index("cla-signed") != null'
```

- `ee/` files changed and no `cla-signed` label -> Blocked. Point to
  `legal/individual-contributor-license-agreement.md` or
  `legal/corporate-contributor-license-agreement.md`.
- Only a maintainer applies `cla-signed`, and only after confirming the
  signed agreement is on file privately. The label records that check; it is
  not the check. Never apply it to unblock a PR.
- Check the previous `ee/` commit inventory against the same contributor's
  earlier PRs: the CLA covers the person or company, not the PR.

## 3. Warden ran on the exact head being merged

Two Warden skills must have reviewed the diff: `diff-security-review` and
`confidentiality-review` (this repo is public; see AGENTS.md Confidentiality).
On a same-repo head they appear as check runs and clearance is a review by
`diff-warden`:

```bash
HEAD=$(gh pr view $N -R $R --json headRefOid --jq .headRefOid)
gh api "repos/$R/commits/$HEAD/check-runs" --paginate \
  --jq '.check_runs[] | select(.name | startswith("warden")) | "\(.name) \(.conclusion)"'
gh pr view $N -R $R --json reviews --jq '.reviews[] | select(.author.login == "diff-warden") | .state'
```

- Fork head: these are absent by design, and approving the workflow run in
  the Actions UI does not help (the job's `if:` skips fork heads regardless).
  The only ways to get Warden coverage are (a) carry the commit into a
  same-repo branch (section 6) and let `Warden` run there, or (b) run the
  local preflight on that branch: `pnpm warden:check` (bare mode, clean tree,
  per `.warden/README.md`) and record the run reference, both refs, and the
  skills that actually ran. Local clearance never substitutes for the GitHub
  approval; it only tells you whether to proceed.
- Same-repo head with `warden: diff-security-review` or
  `warden: confidentiality-review` missing, skipped, or failed -> Blocked.
- Any PR that touches `.github/`, `warden.toml`, `.warden/`,
  `.agents/skills/`, or `.claude/skills/` is never self-cleared by Warden
  (`warden-clearance.yml` refuses review machinery); a human security review
  is the gate.

## 4. A human read the full diff

Not the summary, not the files list, not the CI result.

```bash
gh pr diff $N -R $R | wc -l
gh pr diff $N -R $R
```

Record in the review comment: the head SHA you read, which files you read
in full, and anything you skimmed (generated files, lockfiles, fixtures).
If you skimmed anything that executes, you did not review it.

## 5. No new IPC, network, or dependency surface without justification

Grep the diff, then ask the PR to justify every hit or remove it:

```bash
gh pr diff $N -R $R | grep -n -E '^\+.*(ipcMain|ipcRenderer|contextBridge|exposeInMainWorld|webContents\.send|handle\(|fetch\(|http\.|https\.|net\.|WebSocket|child_process|spawn\(|exec\(|shell\.openExternal|eval\(|new Function)' | head -50
gh pr diff $N -R $R | awk '/^diff --git/ { pkg = /package\.json/ } pkg && /^\+ +"/'   # added package.json lines
gh pr diff $N -R $R --name-only | grep -E 'pnpm-lock\.yaml|^\.github/|opencode\.json|^\.opencode/|^warden\.toml|^\.warden/'
```

- New IPC channels or preload exposure: which renderer needs it, what data
  crosses, and how the main side validates it.
- New outbound network: which host, why, what leaves the machine. Desktop
  mode keeps files local; anything that phones home is Blocked without a
  documented reason.
- New dependencies: pnpm only, pinned in `pnpm-lock.yaml`, no postinstall
  scripts, maintained upstream, and not duplicating something already in the
  workspace (native deps must stay converged on one major, see #3561).
- Workflow, `opencode.json`, or `.opencode/` changes from a fork: treat as
  review machinery; a maintainer reproduces the change on a same-repo branch
  rather than merging the fork's copy.

## 6. Carry a fork commit into a same-repo branch

Do this when Warden coverage is required (section 3), when the fork branch is
stale and the contributor is unresponsive, or when the change must be split.
Preserve authorship; do not manufacture certification.

```bash
git fetch origin dev "pull/$N/head:contributor/pr-$N"   # GitHub exposes the fork head as refs/pull/N/head
git worktree add /tmp/ow-carry-$N -b carry/pr-$N origin/dev
cd /tmp/ow-carry-$N
git log --oneline origin/dev..contributor/pr-$N          # the commits to carry, oldest last
git cherry-pick -x origin/dev..contributor/pr-$N         # keeps Author: as the contributor, adds "(cherry picked from commit ...)"
git log origin/dev.. --format='%h %an <%ae>%n%(trailers:key=Signed-off-by)'   # author and original Signed-off-by must survive
git push -u origin carry/pr-$N
gh pr create -R $R --base dev --head carry/pr-$N --title "<original title>" \
  --body "Carries #$N by @<contributor> onto a same-repo branch so Warden can run. Original commits: <shas>."
```

Rules:

- `git cherry-pick` preserves `Author:`; the committer becomes you. That is
  correct and expected. Do not rewrite the author to yourself.
- If you squash or amend the contributor's commit and it must be attributed
  to you as committer, add `Co-authored-by: Name <email>` for the contributor.
  `Co-authored-by` is attribution only. It is not a DCO certification, and
  your own `Signed-off-by` only certifies your right to submit under DCO
  clause (c): you received it from someone who certified (a), (b), or (c).
  That still requires the contributor's own `Signed-off-by` on the original
  commit (section 1). If the original was unsigned, the carry is Blocked
  until the contributor signs it; do not sign on their behalf.
- Keep the contributor's `Signed-off-by` trailer intact through the
  cherry-pick, then add your own with `git commit --amend -s` only if you
  changed the content.
- Close the fork PR with a comment linking the carry PR so the contributor
  keeps the credit trail and knows where review continues.
- The carry PR is a normal same-repo PR: Warden runs, clearance applies, and
  sections 1 to 5 still apply to it.

## 7. Record the review

Post one comment on the PR with the seven items above, each marked `OK`,
`Blocked (why)`, or `N/A (why)`, plus the head SHA the review binds to. If
the head changes after the comment, the review is stale; rerun sections 1,
3, 4, and 5 before approving.
