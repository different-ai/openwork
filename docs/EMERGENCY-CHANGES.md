# Emergency changes

## Why this exists

The change management control is a reviewed pull request into `dev`.
Incidents sometimes require a faster path.
Every expedited path below has a compensating control and leaves evidence. No undocumented bypasses are permitted.

## The expedited paths

| Path | When | Compensating control | Evidence |
| --- | --- | --- | --- |
| Tag-first release (manual `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`, admins only) | A release must go out now from a commit not yet on `dev` | The `v*` tag ruleset limits this path to admins. Versions live in tags only — no version-bump commit exists; the tag names exactly the code that ships. | Auto-opened `Post-hoc review` issue from the expedited release audit workflow when the tagged commit is not on `dev` |
| Published-release rollback (`pnpm release:rollback`) | A bad version is live | The script is non-destructive: it re-points Latest and demotes the bad release, but never deletes it. It redeploys only previously reviewed artifacts. | GitHub audit log, release timeline, and a note in the post-hoc issue |
| Clean-revert fast lane (auto-approved revert PRs) | A reviewed change must be undone immediately | Trusted-base verification proves the exact inverse of one non-merge ancestor of protected `dev`; eligible reverts are exempt from expensive CI and Warden analysis. Approval inherits the original review, not a new Warden review. | SHA-bound bot approval, existing `openwork-tests-required` check, and explicit not-reviewed Warden summaries |

See [Releasing OpenWork](./RELEASING.md) for release mechanics.

### Exact clean-revert exemption

Only open, non-draft, same-repository PRs targeting `dev` qualify. A revert title
or `This reverts commit <40-hex>` body is a candidate hint, never authority.
The preflight runs from an immutable trusted base checkout, fetches PR commits
only as Git data, and re-applies the named non-merge ancestor's inverse to the
full base SHA. Its tree must equal the full PR head SHA's tree. Current PR
head/base and the `dev` tip are checked before and after verification.

Empty diffs, forks, stale/invalid SHAs, conflicts, hand edits, and missing,
malformed or unavailable helpers do not qualify. Changes to `.github/`,
`scripts/ci/`, `.warden/`, `warden.toml`, `.agents/skills/`, `.claude/skills/`,
`.opencode/`, or root `AGENTS.md` also take normal checks and review, even if
they are exact reverts. Existing protected review-machinery guards remain.

For a validated exemption, core, build, and workflow-authoring jobs skip; the
**existing** aggregate check succeeds only with verified exemption output and
the expected skipped lanes. Non-PR and ordinary PR routing is unchanged.
The existing Warden job reports **not reviewed**, skips analysis/reporting,
and emits no normal review receipt. Clearance recognizes that producer step
only as a routing marker, binds the successful run and attempt to the current
PR, then independently re-verifies the exact revert. It grants no Warden
approval. An ordinary missing receipt still fails closed. The separate revert
approval workflow retains its ruleset checks and SHA-bound approval/auto-merge.
No branch rule is changed and no duplicate success status is synthesized.

**Rollout:** this policy-changing PR must pass normal checks and human review.
Trusted-base and default-branch helpers must land before the fast path is
available; bootstrap failures fall back to normal checks. Local tests do not
prove GitHub routing: validate a subsequent eligible revert after rollout.
Runner queues and GitHub scheduling can still delay completion; seconds of
wall-clock time are not guaranteed.

## Post-hoc review SLA

Every `emergency-change` issue must receive sign-off from a human reviewer other than the actor within one business day. Link the incident or reason. Only that reviewer closes the issue.

## Metrics & audit

Quarterly, count `emergency-change` issues. Expect this path to remain rare (target: fewer than one per month), and require every issue to be closed with sign-off. This issue set is also the SOC 2 evidence set for the emergency-change control.
