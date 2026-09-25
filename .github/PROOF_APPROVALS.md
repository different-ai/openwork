# PR proof approvals

Human authors reported by GitHub as organization `MEMBER` or `OWNER` run proof
without a deployment review in `pr-internal-specs`. The PR must use a branch in
this repository. The selector checks both the event and a fresh PR API response;
the job also checks GitHub's event identity independently of selector outputs.

All other authors, including outside collaborators with repository access, use
`pr-slow-specs` and its existing required reviewers. Missing membership metadata
keeps that gate. Fork PRs remain unsupported for credentialed proof, even when a
maintainer reruns them. This does not change merge protection.

GitHub creates `pr-internal-specs` when a workflow first references it. It must
have no required reviewers or wait timer. The current `pr-slow-specs` environment
has no environment-specific secrets or variables, so these jobs continue using
the existing repository and organization configuration. Keep future credentials
available to both environments where needed; never move production credentials
into the automatic proof environment.

The live, Windows and checkpoint proof lanes share this rule. Chained product
journeys use the fresh PR identity from their existing default-branch authorization
controller. Scheduled and manually dispatched journeys keep their existing
`scheduled-e2e-regression` environment.
