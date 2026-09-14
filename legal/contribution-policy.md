# Contribution licensing process

This document describes a repository merge gate. It is process guidance, not
a CLA, an employment or contractor agreement, legal advice, or evidence that
an agreement has been executed.

## The two contribution requirements

1. **DCO for every commit.** A syntactically valid `Signed-off-by:` entry must
   appear in the commit message's final trailer block and exactly match the Git
   author name and email. Every final-block `Co-authored-by:` identity needs a
   corresponding sign-off. There are no bot or known-collaborator exemptions.
   This certifies the DCO text; it is not identity proof or a cryptographic
   signature.
2. **An applicable CLA for `ee/`.** Any addition, modification, deletion, or
   rename whose old or new path is `ee/` or below requires private verification
   of the applicable individual or corporate CLA. Mixed pull requests are EE
   pull requests for this purpose.

Commercial employment, contractor, work-trial, and other service arrangements
are outside this contribution policy and gate. They do not create a third
repository contribution requirement. Existing CLA provisions are unchanged,
including the individual CLA's representations concerning employer rights,
permission, waiver, or a corporate CLA.

The gate never treats PR text, checkboxes, labels, comments, arbitrary status
names, email domains, authorship, or known-collaborator status as CLA evidence.
There is no authorized CLA database, signer service, or approvals map connected
to this repository. Consequently every `ee/` change fails closed with
`CLA verification not configured; pending private verification`. There is no
allow switch. A future trusted verifier requires an explicit administrator and
counsel decision; this repository does not claim that anyone is verified now.
Executed agreements, identity records, and other private evidence must not be
committed or pasted into a pull request.

## Existing license terms are not reinterpreted

The root `LICENSE` continues to preserve its existing allocation: `ee/` uses
the EE license, prior versions remain under the license under which they were
released, third-party or upstream components keep their original licenses, and
the remaining content is MIT-licensed. The EE license's client-side exception
and its conversion of each version to MIT on that version's second anniversary
also remain unchanged. CI deliberately does not classify an apparent image,
font, CSS, or client-side JavaScript path as exempt from CLA review.

Counsel should separately reconcile the EE license's rights language for
modifications and patches with the CLAs' retained-ownership language and broad
license grants, and review the individual CLA's employer-authority alternatives
and the EE client-side exception. These are review flags, not new
interpretations or changes to any license or CLA.

## Trusted execution and status

The workflow runs on `pull_request_target`, checks out only the immutable event
base SHA, and executes only the verifier from that base. It never checks out or
executes pull-request code, installs dependencies, or passes pull-request text
to a shell. It reads every commit and changed-file page from the GitHub API,
compares the live base and head before and after collection, and fails closed
when counts are missing, malformed, inconsistent, or reach GitHub's 250-commit
or 3,000-file API ceilings. Both sides of every rename are evaluated.

Because a `pull_request_target` job check attaches to the base commit, the
workflow publishes the stable `contribution-policy-required` commit status to
the exact event head SHA with the Actions runtime token. It writes pending
before collection, then success or failure only while its run remains the
current pending writer. Per-PR serialization, run-ID/run-attempt ordering, and
a final status recheck prevent an older run from replacing a newer result.
Collection errors produce failure or leave pending; they never produce green.
Draft and fork pull requests follow the same evaluation. No label event or
label value affects the result.

This workflow does not implement `merge_group`. Do not enable a merge queue
until an equivalent queue-head evaluation exists and is required.

## Administrator-owned safeguards still required

This repository intentionally does not add `CODEOWNERS` with an unapproved
identity. Administrators must select approved legal/security/repository owners
and require their review for at least:

- `/ee/`
- `/legal/`
- `/LICENSE`
- `/CONTRIBUTING.md`
- `/.github/pull_request_template.md`
- `/.github/workflows/`, especially
  `/.github/workflows/contribution-policy.yml`
- `/scripts/ci/check-contribution-policy.mjs`
- `/scripts/ci/check-contribution-policy.test.mjs`
- every active CODEOWNERS location, including `/.github/CODEOWNERS`,
  `/CODEOWNERS`, and `/docs/CODEOWNERS`

Until approved ownership is configured, the evaluator also holds changes to
these policy, license, and ownership paths. That hold is an administrative
protection, not another contributor certification or agreement, and has no
in-repository self-approval path.

For every branch that accepts pull requests, administrators must deploy this
trusted workflow and separately configure repository rules to:

1. require the head-bound `contribution-policy-required` status;
2. bind the required status to its expected GitHub App/source where supported,
   restrict who can write statuses, and use an organization/repository required
   workflow control so another workflow cannot satisfy the context by name;
3. protect changes to Actions workflows, this verifier, licenses, contribution
   docs, and CODEOWNERS with the approved reviewers and audited bypass policy;
4. require the PR head to be up to date with its exact target before merge, so
   a head-only status is not reused after the base advances;
5. prevent force pushes or branch/ruleset changes from bypassing the gate; and
6. leave merge queues disabled until `merge_group` is implemented.

A status context alone is not origin proof: another authorized integration can
publish the same name. The workflow cannot declare branch or ruleset enforcement
from repository files, and none is claimed to be configured here.

## Deployment and live validation

This change must start as a draft pull request because `pull_request_target`
uses the workflow already on the base branch; the new workflow cannot prove its
own live behavior before an authorized bootstrap merge. After deployment and
the safeguards above, administrators must validate on each merge target:

1. a normal non-EE PR with signed commits moves the exact head status from
   pending to success;
2. unsigned, author-mismatched, body-only, and missing-coauthor sign-offs each
   fail, including unsigned bot-authored commits;
3. EE additions, modifications, deletions, and renames into or out of `ee/`
   fail even when the path appears client-side and labels or checkboxes claim
   verification;
4. a protected policy/license-path change fails and requires the audited
   administrator path rather than a repository-controlled allow signal;
5. draft, fork, reopened, edited, and synchronized PRs are re-evaluated;
6. a head or base change during collection never greens the stale evaluation,
   and a delayed older run cannot overwrite a newer run's status; and
7. the required rule recognizes only the expected status producer and blocks
   merges when the workflow is absent, fails, or remains pending.

Until those GitHub-hosted checks and rule inspections are completed, live
workflow and merge enforcement remain **Incomplete**.
