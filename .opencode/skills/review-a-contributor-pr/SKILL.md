---
name: review-a-contributor-pr
description: Review a fork PR, review an external contributor PR, check provenance (DCO) and ee/ CLA, run /test, carry a fork commit into a same-repo branch, is this PR safe to merge. Checklist for pull requests from forks before a human approves or merges them.
---

# Skill: review-a-contributor-pr

Use for every PR whose head is not in `different-ai/openwork`
(`isCrossRepository: true`). Fork PRs get no automatic clearance: `warden.yml`
skips them (`head.repo.full_name == github.repository`, no secrets on fork
heads) and `warden-clearance.yml` refuses them. As at GitLab, contributing
means accepting the DCO, or the Individual or Corporate CLA for `ee/`
(CONTRIBUTING.md). There is no `Signed-off-by` requirement, no CLA signature
and no label to enforce.

`contributor-pr-required` (commit status) is the CI gate for contributor PRs.
Everything below runs from dev and never executes PR code:

- `contributor-pr.yml` (`pull_request_target`, every push): passes the
  status for same-repository and bot PRs, fails it for forks that touch CI or
  agent configuration, and leaves other forks pending until `/test`.
- Then, for forks, the free screen (`contributor-warden.yml`, stage `scan`,
  no model, no secrets) sets `contributor-pr/screen` and keeps one PR
  comment. Nothing that costs money runs before your `/test`:
  - **blocked** (red): hidden or look-alike characters, invalid UTF-8. The
    contributor must fix it; `/test` refuses.
  - **needs review** (yellow): dependency or lockfile changes, database
    changes (`ee/packages/den-db/**`, `*.sql`, migration jobs), binaries,
    encoded or obfuscated-looking lines, text aimed at an AI reviewer (in
    the diff or commit messages; treat later Warden results on that commit
    as unreliable). Read each listed item yourself before `/test`.
  - **passed** (green): nothing flagged. Still review before `/test`.
- After you finish this checklist, comment `/test` (binds the head as it was
  when you commented) or `/test <sha>`. `contributor-pr-test.yml` checks you
  have write access, the head hasn't moved, and the screen isn't blocked,
  then runs the AI screen (Warden's `contributor-screen` skill, once per
  commit, `contributor-pr/ai-screen`).
  - **AI screen clear:** it approves the fork's waiting test runs, runs the
    Warden security review (`contributor-pr/warden`), and passes
    `contributor-pr-required` once Warden is clear and
    `openwork-tests-required` (ci-tests.yml, no secrets) succeeds.
  - **AI screen flagged or incomplete:** nothing else runs. Read the
    findings in its PR comment; comment `/test` again to proceed anyway.
  - A new push needs a new review and a new `/test`.
- Fork tests run without secrets. The Freestyle, live and Windows proofs
  still need the carry in section 6.

The status gates the contributor, not the reviewer: this checklist is still
required.

Every item must be answered explicitly in the review comment. `Blocked` on any
item means no approval and no merge.

```bash
export R=different-ai/openwork N=<pr-number>
gh pr view $N -R $R --json isCrossRepository,headRepositoryOwner,headRepository,headRefOid,labels,files,author \
  --jq '{fork: .isCrossRepository, head: "\(.headRepositoryOwner.login)/\(.headRepository.name)@\(.headRefOid[:10])", author: .author.login, labels: [.labels[].name], ee: [.files[].path | select(startswith("ee/"))]}'
```

## 1. Provenance: the code is the contributor's to give

The DCO (outside `ee/`) or the CLA (`ee/`) applies by contributing; nothing
needs a signature or a `Signed-off-by` line. What a reviewer checks is that
the contribution is plausibly the contributor's to license:

- No code copied from another project without its license allowing it:
  look for foreign license headers, copyright lines, or large blocks that
  read like vendored or generated code.
- If the author says the work was done for an employer or client, the
  Corporate CLA covers `ee/`; outside `ee/`, ask them to confirm they may
  contribute it.
- AI-generated content is fine; ask for it to be disclosed if it is large.

Anything doubtful -> Blocked until the source and license are clear.

## 2. ee/ paths are covered by the CLA notice

CONTRIBUTING.md (first section, same model as GitLab): contributing to `ee/`
means the contributor is deemed to accept the Individual or Corporate CLA in
`legal/`. There is no signature to collect and no label to apply. Renames out
of `ee/` count as `ee/` changes.

```bash
gh pr view $N -R $R --json files --jq '[.files[].path | select(startswith("ee/"))]'
```

- `ee/` files changed -> note it in the review comment so the record shows
  the CLA applied. Not a blocker on its own.
- Blocked if the PR body or commits say the contribution is "Not a
  Contribution", is submitted on behalf of a third party, or otherwise
  rejects the CLA terms. Ask the contributor to resolve it with
  team@openworklabs.com first.
- If the author is clearly contributing for an employer, mention the
  Corporate CLA (`legal/corporate-contributor-license-agreement.md`) in the
  review so they can confirm they are authorized.

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

- Fork head: `warden.yml` skips forks by design. Warden runs for forks
  after your `/test` (section 7), in the sandboxed `contributor-warden.yml`,
  and reports the `contributor-pr/ai-screen` and `contributor-pr/warden`
  statuses plus one PR comment each. Check them on the head being merged:

  ```bash
  gh api "repos/$R/commits/$HEAD/status" --jq '.statuses[] | select(.context | startswith("contributor-pr")) | "\(.context) \(.state) \(.description)"'
  ```

  `contributor-pr/warden` not `success` on that head -> Blocked.
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

Do this when a fork changes CI or agent configuration (the gate refuses
those), when the fork branch is stale and the contributor is unresponsive, or
when the change must be split. Preserve authorship.

```bash
git fetch origin dev "pull/$N/head:contributor/pr-$N"   # GitHub exposes the fork head as refs/pull/N/head
git worktree add /tmp/ow-carry-$N -b carry/pr-$N origin/dev
cd /tmp/ow-carry-$N
git log --oneline origin/dev..contributor/pr-$N          # the commits to carry, oldest last
git cherry-pick -x origin/dev..contributor/pr-$N         # keeps Author: as the contributor, adds "(cherry picked from commit ...)"
git log origin/dev.. --format='%h %an <%ae> %s'                    # the contributor must still be the author
git push -u origin carry/pr-$N
gh pr create -R $R --base dev --head carry/pr-$N --title "<original title>" \
  --body "Carries #$N by @<contributor> onto a same-repo branch so Warden can run. Original commits: <shas>."
```

Rules:

- `git cherry-pick` preserves `Author:`; the committer becomes you. That is
  correct and expected. Do not rewrite the author to yourself.
- If you squash or amend the contributor's commit and it must be attributed
  to you as committer, add `Co-authored-by: Name <email>` for the contributor
  so the credit trail survives.
- Close the fork PR with a comment linking the carry PR so the contributor
  keeps the credit trail and knows where review continues.
- The carry PR is a normal same-repo PR: Warden runs, clearance applies, and
  sections 1 to 5 still apply to it.

## 7. Record the review

Post one comment on the PR with the seven items above, each marked `OK`,
`Blocked (why)`, or `N/A (why)`, plus the head SHA the review binds to. If
the head changes after the comment, the review is stale; rerun sections 1,
3, 4, and 5 before approving.

If nothing is Blocked, bind the commit you read so `contributor-pr-required`
can pass:

```bash
gh pr comment $N -R $R --body "/test $(gh pr view $N -R $R --json headRefOid --jq .headRefOid)"
```

Naming the SHA you read is the strict form; a plain `/test` comment binds the
head as it was when you commented. The workflow replies on the PR if it
refuses (no write access, head moved, CI or agent configuration changed,
screen blocked or not finished).
