# Contributor security review

This document defines the review boundary for pull requests from forks. It does
not change repository settings or authorize credentialed execution of pull
request code.

## Automated scope

`.github/workflows/external-contributor-checks.yml` checks out the pull request's
exact event head with persisted checkout credentials disabled, verifies that
`HEAD` still equals that SHA, and runs `git diff --check` against the event base.
It does not install dependencies, execute pull request code, receive secrets,
perform security analysis, or produce product test evidence. Its separate fork
job therefore reports **INCOMPLETE — not reviewed and not tested** and fails.

Unsupported credentialed execution of fork code remains blocked. There is no
credentialed consumer behind this workflow. Copying a fork commit or branch to
an internal branch does not count as review, approval, or evidence and must not
be used to bypass this boundary.

## Manual exact-head review record

Before treating a fork change as reviewed, a maintainer must record:

- repository and pull request number, base SHA, and the exact 40-character head
  SHA;
- reviewer identity, review time, files and generated artifacts reviewed, and
  the trust boundary used;
- every finding's stable ID, classification, evidence, `Clear when` condition,
  and disposition, including an explicit list of unresolved gaps;
- exact commands, exit codes, placement, artifact directories, and observable
  assertions for product evidence; skips remain not tested;
- confirmation that the PR head was re-read after any approval wait and still
  matched the reviewed SHA. A changed head invalidates the record and requires
  review and tests to run again.

The review must include introduced risk in:

- dependencies, lockfiles, package-manager configuration, install hooks, and
  lifecycle or build scripts;
- test/evaluation harnesses, fixtures, setup actions, runners, caches, and
  artifact download or publication paths;
- workflow triggers, event types, permissions, third-party actions, checkout
  refs, environment gates, and any code that plans or dispatches later jobs;
- executable, generated, binary, and symlinked files, network destinations,
  storage boundaries, logging, and credential access; and
- application and service changes that alter authorization, data access,
  command execution, or desktop/cloud trust boundaries.

Follow `.warden/README.md` for the repository's final committed-branch review.
A local review result is supporting evidence, never GitHub approval.

## Isolated credentialed testing prerequisites

Credentialed testing may be designed only after a maintainer approves the exact
head. It requires all of the following:

1. A fresh disposable runner or sandbox dedicated to that SHA, with no shared
   home directory, credential cache, mounted volume, host socket, or reusable
   workspace.
2. No access to production services or shared development accounts. Network and
   service access must be limited to disposable test resources.
3. Narrow, short-lived test credentials held outside pull-request-controlled
   files and commands. Broad organization, developer, deployment, cloud, or
   source-control credentials must never be reused.
4. A fresh server-side comparison of the current PR head to the approved SHA
   immediately before dispatch, after every approval wait. Mismatch must stop
   the run.
5. Recorded negative controls proving that stale-head dispatch, access to
   shared files or volumes, production endpoints, unapproved outbound traffic,
   and credential disclosure through logs or artifacts are blocked. These
   controls must be tested, not assumed.
6. Destruction of the sandbox and revocation of its credentials after the run,
   with only reviewed, secret-scanned evidence retained.

This repository does not currently provide that fork credential-execution
route. Administrators must choose and configure enforcement, such as required
checks or rulesets for the failing fork status, protected environments and
reviewers for any future trusted workflow, and the location and required format
of manual exact-head records. Until then, the workflow status communicates an
incomplete review; it does not prove that merge policy blocks the pull request.
