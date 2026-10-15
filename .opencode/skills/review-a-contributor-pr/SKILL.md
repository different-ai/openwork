---
name: review-a-contributor-pr
description: Review a fork PR, review an external contributor PR, check provenance (DCO) and ee/ CLA, run /test, carry a fork commit into a same-repo branch, is this PR safe to merge. Checklist for pull requests from forks before a human approves or merges them.
---

# Review a contributor PR

Use for every PR whose head is not in `different-ai/openwork` (`isCrossRepository: true`), including fork bots.
Same-repo PRs use normal CI and review: no contributor status, no `/test`.
Fork PRs get no automatic clearance. `warden.yml` skips them (`head.repo.full_name == github.repository`, no secrets on fork heads). `warden-clearance.yml` refuses them.
Contributing means accepting the DCO, or the Individual or Corporate CLA for `ee/` (CONTRIBUTING.md, GitLab model). No `Signed-off-by`, no signature, no label to enforce.
Merge safeguards: required `openwork-tests-required` and `warden-clear` checks, plus trusted maintainer review. `warden-clear` is posted by the diff-warden App; for forks it appears after `/test`. Screen statuses are advisory.

## Fork pipeline (all runs from dev, never executes PR code)

| Stage | Workflow / status | What it does |
|---|---|---|
| Every fork push | `contributor-pr.yml` (`pull_request_target`) | Runs the free screen. Blocks CI or agent configuration changes; a maintainer carries those (section 6). |
| Free screen | `contributor-warden.yml` stage `scan` -> `contributor-pr/screen`, one PR comment | No model, no secrets. Nothing that costs money runs before `/test`. |
| Screen **blocked** (red) | | Hidden or look-alike characters, invalid UTF-8. Contributor must fix. `/test` refuses. |
| Screen **needs review** (yellow) | | Dependency or lockfile changes, database changes (`ee/packages/den-db/**`, `*.sql`, migration jobs), binaries, encoded or obfuscated-looking lines, text aimed at an AI reviewer (diff or commit messages; treat later Warden results on that commit as unreliable). Read each item yourself before `/test`. |
| Screen **passed** (green) | | Nothing flagged. Still review before `/test`. |
| `/test` or `/test <sha>` | `contributor-pr-test.yml` | Checks write access, head unmoved, screen not blocked. Runs AI screen (Warden `contributor-screen` skill, once per commit) -> `contributor-pr/ai-screen`. |
| AI screen **clear** | `contributor-pr/warden` | Approves only this PR's waiting runs on the reviewed SHA. Runs Warden security review. Confirm Warden clear and `openwork-tests-required` (ci-tests.yml, no secrets) succeeds before approving. No combined status is posted. |
| AI screen **flagged / incomplete** | | Nothing else runs. Read findings in its PR comment. Comment `/test` again to proceed anyway. |

- A new push needs a new review and a new `/test`. Fork tests run without secrets; Freestyle, live and Windows proofs need the carry (section 6).
- Repo Actions settings must require approval for **all outside collaborators**, not only first-time contributors. Never approve fork runs manually to bypass `/test`.
- Required CI, CODEOWNERS and approval of the latest push stay enabled. This checklist is the human merge gate; the ruleset separately blocks any PR without a passing `warden-clear`.
- Fork diffs with 300+ changed files need a maintainer carry (GitHub caps the immutable comparison file list). See [deployment and security caveats](../../../docs/fork-contributor-ci.md).

Answer every item explicitly in the review comment. `Blocked` on any item means no approval and no merge.

Collect the mechanical facts in one pass, bound to one head SHA (it exits 1 if the head moves mid-run):

```bash
export R=different-ai/openwork N=<pr-number>
bash .opencode/skills/review-a-contributor-pr/scripts/pr-facts.sh $N    # head, ee/ files, machinery files, Warden, risky added lines, package.json lines
```

## 1. Provenance: the code is the contributor's to give

DCO or CLA applies by contributing. Check the contribution is plausibly theirs to license.

- No code copied without a license allowing it. Look for foreign license headers, copyright lines, or blocks that read like vendored or generated code.
- Work done for an employer or client: the Corporate CLA covers `ee/`. Outside `ee/`, ask them to confirm they may contribute it.
- AI-generated content is fine. Ask for disclosure if it is large.
- Anything doubtful -> Blocked until source and license are clear.

## 2. ee/ paths are covered by the CLA notice

Contributing to `ee/` means accepting the Individual or Corporate CLA in `legal/`. Renames out of `ee/` count as `ee/` changes.

`pr-facts.sh` lists them under "ee/ files".

- `ee/` files changed -> note it in the review so the record shows the CLA applied. Not a blocker alone.
- Blocked if the PR body or commits say "Not a Contribution", submitted on behalf of a third party, or otherwise reject the CLA. Contributor resolves with team@openworklabs.com first.
- Clearly contributing for an employer -> mention `legal/corporate-contributor-license-agreement.md` so they confirm authorization.

## 3. Warden ran on the exact head being merged

Two Warden skills must review the diff: `diff-security-review` and `confidentiality-review` (repo is public; see AGENTS.md Confidentiality). `pr-facts.sh` prints the Warden checks, `contributor-pr/*` statuses and `diff-warden` review for the head. Set `HEAD` to the SHA it printed.

- Fork head: Warden runs after `/test` (section 7) in sandboxed `contributor-warden.yml`. It posts `contributor-pr/ai-screen` and `contributor-pr/warden` plus one comment each. `contributor-pr/warden` not `success` on the merge head -> Blocked.
- Same-repo head: `warden` and `warden-clear` must both be `success` on the merge head. `warden-clear` passes only when both skills completed on that exact head with no confidentiality and no high or medium security findings (`.github/scripts/warden-clearance.mjs`). Missing, skipped, or failed -> Blocked.
- Any PR touching `.github/`, `warden.toml`, `.warden/`, `.agents/skills/`, or `.claude/skills/` is never self-cleared (`warden-clearance.yml` refuses review machinery). Human security review is the gate.

## 4. A human read the full diff

Not the summary, the files list, or the CI result.
```bash
gh pr diff $N -R $R | wc -l
gh pr diff $N -R $R
```

Record the head SHA you read, files read in full, and anything skimmed (generated files, lockfiles, fixtures). If you skimmed anything that executes, you did not review it.

## 5. No new IPC, network, or dependency surface without justification

`pr-facts.sh` lists added lines touching IPC, network, processes or eval (by file), added `package.json` lines, and machinery or lockfile changes. Ask the PR to justify or remove every hit.

- New IPC channels or preload exposure: which renderer needs it, what data crosses, how main validates it.
- New outbound network: which host, why, what leaves the machine. Desktop mode keeps files local. Phoning home without a documented reason -> Blocked.
- New dependencies: pnpm only, pinned in `pnpm-lock.yaml`, no postinstall scripts, maintained upstream, no duplicate of a workspace dep. Native deps stay on one major (#3561).
- Workflow, `opencode.json`, or `.opencode/` changes from a fork are review machinery. A maintainer reproduces them on a same-repo branch; never merge the fork's copy.

## 6. Carry a fork commit into a same-repo branch

Carry when a fork changes CI or agent configuration, the fork branch is stale and the contributor unresponsive, or the change must be split. Preserve authorship.

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

- `git cherry-pick` keeps `Author:`. You become committer. That is expected. Never rewrite the author to yourself.
- Squashed or amended and attributed to you: add `Co-authored-by: Name <email>` for the contributor.
- Close the fork PR with a comment linking the carry PR, so the credit trail survives and the contributor knows where review continues.
- The carry PR is a normal same-repo PR. Warden runs, clearance applies, sections 1 to 5 still apply.

## 7. Record the review

Post one comment with all seven items, each `OK`, `Blocked (why)`, or `N/A (why)`, plus the head SHA it binds to. Follow **Thirty-Second Reader**.
Per **Honest Verdict**, the review binds to that SHA. If the head changes, it is stale; rerun sections 1, 3, 4 and 5 before approving.

If clear, authorize tests on the commit you read (`HEAD` printed by `pr-facts.sh`), not a fresh lookup of a possibly newer head:

```bash
gh pr comment $N -R $R --body "/test $HEAD"
```

`/test <sha>` is the strict form; plain `/test` binds the head as it was when you commented. The workflow replies if it refuses: no write access, head moved, CI or agent configuration changed, screen blocked or not finished.
Approve the PR only after its Warden results and required CI are clear.
