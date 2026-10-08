# Fork contributor CI: deployment and security boundary

## What changes

`contributor-pr.yml` screens forks only (including fork bots). Its scan reads
Git objects as data, uses no model or secrets, and reports an advisory
`contributor-pr/screen` status and comment. Same-repository PRs have no
contributor gate. A same-repository `/test` comment is a read-only no-op.

`contributor-pr-test.yml` checks the commenter's current write/maintain/admin
permission, requires an open fork PR to `dev`, binds the reviewed SHA, and
refuses CI/agent machinery changes and a blocked/missing free screen. A
plain `/test` requires a valid first-seen workflow timestamp for that same
PR and SHA no later than the comment. Prefer `/test <full-reviewed-sha>`;
explicit commands require the full 40-character SHA, not a collision-prone
abbreviated prefix.

The file list is obtained by comparing immutable base/head SHAs, not from
the mutable PR-files endpoint. A changed head/base aborts authorization;
comparisons at GitHub's 300-file limit or with an incomplete count fail
closed and require a maintainer carry. Renames out of protected paths count.
The bot identity is never an exemption for a fork.

Only after authorization does sandboxed AI screening use a dedicated,
spend-limited key through a restricted proxy. Clear AI screening (or a
second maintainer `/test` after reading findings) permits test-run approval
and sandboxed Warden review. Test approval rechecks the immutable file list,
current fork head and target, then approves only this PR's waiting
`pull_request` run IDs on that SHA and fork repository. A later push cannot
change the code associated with those run IDs. Paid review also checks the
fetched head and exits without model calls when it is stale. Repeated
`/test` workflows are serialized per PR.

There is **no `contributor-pr-required` status writer or final status
polling job** in this flow. The only App token here is the `warden-check`
job's, scoped to checks. The other contributor statuses remain useful advisory reports.
Do not delete the Warden App credentials or environment: ordinary
`warden-clearance.yml` still uses them.

## Warden is required on every PR

The required `warden-clear` check carries Warden's verdict on the exact head
of every PR, posted as a check run by the diff-warden App:

- Same-repository PRs: `warden-clearance.yml` posts it after every Warden
  run, before approving or commenting, so a failed approval can't lose it.
- Fork PRs: after a maintainer's `/test`, the `warden-check` job in
  `contributor-pr-test.yml` posts it from that run's sandboxed review result
  (a job output, not a status anyone else can write).
- PRs that change Warden itself (`warden.toml`, `.warden/`, the Warden
  workflows and `warden-{clearance,report,check}.mjs`) get a failing check:
  a maintainer reviews them and an admin merges them.

The `dev` ruleset requires `warden-clear` from the diff-warden App
(integration ID 4454147). That App's key is only in the `warden-clearance`
environment, which only `dev` and `v*` tags can use, so no workflow on a
branch can create the check. It uses the App's existing Checks permission,
not commit statuses. Rollout: deploy, confirm the check appears on new PRs,
run the "Warden check backfill" workflow once from `dev`, then add the
required check. Dependabot PRs need `WARDEN_OPENAI_API_KEY` as a Dependabot
secret, since Dependabot runs only get Dependabot secrets.

`/test` authorizes spending and test execution; it is not a GitHub PR
approval. The free screen and AI screen statuses remain advisory.
`openwork-tests-required` comes from the GitHub Actions App and does not
distinguish a trusted workflow from a fork-edited one with the same name,
which is why `/test` refuses machinery changes and maintainers must carry
them to a trusted same-repository branch. Never use GitHub's manual Approve
workflows button to bypass that restriction.

Required repository setting: Settings → Actions → General → **Require
approval for all outside collaborators**. First-time-only approval does
not enforce the spending boundary. Keep fork secrets/write-token sharing
disabled. Neither a repository setting nor an advisory status prevents a
trusted maintainer from deliberately bypassing policy. Members and existing
repository collaborators may be exempt from GitHub's outside-collaborator
approval setting: their fork `pull_request` jobs can start automatically.
This design treats those identities as trusted; do not promise that every
possible fork needs `/test` to consume a CI runner. Model-key workflows in
this contributor flow still require `/test` regardless of identity.

If the requirement is **server-enforced Warden clearance before every fork
merge**, removal alone is insufficient. The smallest alternative is a
fork-only, SHA-bound human approval posted by a trusted reviewer after the
reports are clear (the existing required-review rule supplies the merge
barrier). If even reviewers must be prevented from overriding it, keep an
independent trusted required workflow/App boundary; a global required
check name emitted by ordinary GitHub Actions is not that boundary. If
**all** fork runner spending, including trusted collaborator forks, must be
automatically `/test`-gated, move fork CI into a trusted, SHA-bound dispatched
workflow and skip fork jobs on `pull_request`; the native outside-collaborator
approval setting cannot provide that stronger guarantee. These stronger
controls are separate policy changes, not silently included here.

## Exact migration (administrator, after deployment only)

No workflow or script in this change edits live rules. Do not remove any
required check until the new default-branch workflows/scripts are deployed
and reviewed. During the deployment-to-rule-update interval, the old
`contributor-pr-required` requirement will still block PRs because its
writer has been removed. Plan a short administrator-controlled migration
window; do not add a fake replacement success writer. If the old writer is
already broken, use an explicitly authorized existing admin bypass for the
reviewed deployment PR, not a broad weakening of the rules before deployment.

1. Preserve the current rule configuration in a local backup (do not commit
   live configuration or identities). Confirm the default branch is `dev`.
   Confirm Actions requires approval for all outside collaborators, fork
   secrets/write-token sharing is disabled, and CODEOWNERS protection is
   actually applicable to sensitive paths. Do not assume that toggling
   CODEOWNERS approval creates coverage where no owners file exists.
2. Deploy the workflow/script changes to `dev`. Check a same-repository PR
   skips fork screening, and use a controlled fork to check free screening,
   refusal of a non-maintainer or machinery change, stale-SHA refusal, and
   authorized test approval without any App-token step. Do not mutate rules
   merely to make these checks green.
3. In the existing `dev` ruleset, remove **only** the status-check entry whose
   context is `contributor-pr-required`. Preserve the required-status-check
   rule itself and every other entry/parameter. In particular preserve
   `openwork-tests-required` with `integration_id: 15368`, strict/up-to-date
   settings if present, required review count (one), CODEOWNERS approval,
   latest-push approval, stale-review settings, enforcement, branch filters,
   bypass actors, deletion/force-push restrictions and all other rules.
4. Read the ruleset again and compare against the backup: the sole semantic
   difference must be that one entry's removal. Check inherited rules and
   legacy branch protection do not separately require the removed context.
   If they do, review and remove that context only in each applicable source.
5. Recheck a same-repository PR: its normal CI/review requirements remain,
   with no contributor status required. Recheck the controlled fork and its
   reviewed SHA. Existing contributor statuses on older commits can remain;
   do not delete their history.

### Optional API form of step 3

These commands are a future administrator runbook, **not** automation run by
this patch. Use the UI if the rule is organization-owned/inherited. For a
repository-owned ruleset, choose the ID from the live list, then review the
local diff before submitting. Avoid parallel ruleset edits during this window.

```bash
R=different-ai/openwork
gh api "repos/$R/rulesets" --jq '.[] | {id, name, source_type}'
RULESET_ID='the-existing-dev-repository-ruleset-id' # replace with its numeric ID
gh api "repos/$R/rulesets/$RULESET_ID" > ruleset-before.json
jq -e '
  [.rules[] | select(.type == "required_status_checks")
    | .parameters.required_status_checks[]
    | select(.context == "contributor-pr-required")] | length == 1
' ruleset-before.json || exit 1
jq '
  {name, target, enforcement, conditions, bypass_actors, rules}
  | .rules |= map(
      if .type == "required_status_checks" then
        .parameters.required_status_checks |= map(
          select(.context != "contributor-pr-required"))
      else . end)
' ruleset-before.json > ruleset-update.json
jq '{name, target, enforcement, conditions, bypass_actors, rules}' \
  ruleset-before.json > ruleset-before-writable.json
diff -u ruleset-before-writable.json ruleset-update.json
# Only after checking deployment and the single-entry diff:
gh api --method PUT "repos/$R/rulesets/$RULESET_ID" \
  --input ruleset-update.json
gh api "repos/$R/rulesets/$RULESET_ID" > ruleset-after.json
jq '{name, target, enforcement, conditions, bypass_actors, rules}' \
  ruleset-after.json > ruleset-after-writable.json
diff -u ruleset-update.json ruleset-after-writable.json
```

Stop on any unexpected difference. Do not overwrite concurrent administrator
changes with an old backup. Re-read, review and regenerate the single-entry
update from the current configuration.

## Focused verification

```bash
node --test .github/scripts/contributor-pr.test.mjs \
  .github/scripts/contributor-screen.test.mjs
actionlint -shellcheck= .github/workflows/contributor-pr.yml \
  .github/workflows/contributor-pr-test.yml \
  .github/workflows/contributor-warden.yml
```

The CLI tests use a local fake GitHub API to check actual requests and
outputs: immutable comparison, stale/missing/oversized data fail-closed,
exact PR/run approval, same-repository no-op, and fork-bot-only backfill.
They do not prove live GitHub settings, deployment, or approval behavior;
the administrator must verify those during rollout.
