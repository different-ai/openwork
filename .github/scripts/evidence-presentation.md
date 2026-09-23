# Native PR evidence

The trusted `Evidence review` workflow presents `PR change proof` through a
commit-bound **Evidence preview** check, a standalone **OpenWork Evidence** status,
a single updating preview comment, and an **Evidence / PR N** deployment.
GitHub's deployment URL opens the immutable report, where reviewers can launch
independent sandboxes. No new GitHub App or additional secret is required.

`workflow_run` requested/in-progress events show progress. Completion validates
and publishes recorded evidence, writes a local publication receipt, then updates
the check and creates a deployment. The receipt comes from the trusted publisher,
never from downloaded artifacts. Only the current same-repository PR head and
latest producer run/attempt can publish. Deployments are non-transient because immutable reports remain accessible.
Older deployments are marked inactive;
deployment status writes never automatically deactivate another deployment.

The check verdict combines the selected report's recorded verdict with the
producer outcome. A published report can describe failed tests: its deployment
is available while its evidence check is red. Missing publication fails closed.
A successful run with no changed E2E specs gets a neutral check and no deployment.
This check does not replace required verification or human approval.

Automatic publication updates its own GitHub Actions bot comment with the commit,
publication time, and Open preview link. While a newer run is pending or fails to
publish, previous evidence is explicitly labeled outdated. The comment uses a
separate marker, so existing manual report selections remain protected.
The standalone commit status avoids unrelated dynamic check-suite headings.
GitHub statuses have no neutral state: no selected E2E specs yields a successful
status with explicit no-evidence wording, alongside the neutral detailed check.
Public check text contains only commit/run identity, timestamps, aggregate counts,
and the report link. Screenshots and disposable sandbox credentials remain in the
existing report, not copied into public annotations or check images.

Progress needs `checks: write`, `statuses: write`, `pull-requests: write`, and
`deployments: write`; publishing also uses the
existing review URL and blob token. Both jobs check out the default branch, never
PR code. Candidate PR checks exercise the controller with a mocked GitHub API;
live workflow behavior activates after this change reaches the default branch.

Tests:

    node --test .github/scripts/evidence-preview-card.test.mjs \
      .github/scripts/evidence-presentation.test.mjs \
      .github/scripts/pr-proof.test.mjs evals/scripts/publish-review.test.mjs \
      evals/packages/test-artifacts/test/*.test.ts
