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
| Clean-revert fast lane (auto-approved revert PRs) | A reviewed change must be undone immediately | A machine verifies that the PR tree is the exact inverse of a commit that already passed review. Approval inherits the original review. | Bot approval with the verified SHA on the PR |

## Post-hoc review SLA

Every `emergency-change` issue must receive sign-off from a human reviewer other than the actor within one business day. Link the incident or reason. Only that reviewer closes the issue.

## Metrics & audit

Quarterly, count `emergency-change` issues. Expect this path to remain rare (target: fewer than one per month), and require every issue to be closed with sign-off. This issue set is also the SOC 2 evidence set for the emergency-change control.
