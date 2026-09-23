# OpenWork Review

An immutable, private review page composed from existing test records and
DocShot receipts. Publication reads completed files; it never runs tests,
captures screenshots, or calls a model. Reference images have no implied test
result. Pending judgments and coverage gaps remain visible.

## Develop and verify

```sh
pnpm --filter @openwork/review-app... install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile --ignore-scripts
pnpm --filter @openwork/review-app build
OPENWORK_EVAL_REVIEW=1 pnpm evals:pr specs/evidence-review.test.ts
```

The journey boots the production app with isolated local storage and checks
composed reports, failed and incomplete evidence, images, source records, and
rejection of production deployments through HTTP. Its inputs are explicitly
synthetic fixtures; they do not claim to have tested the example behaviors shown
in the report.

For development, create a directory and set `OPENWORK_REVIEW_LOCAL_DIR` to its
absolute path in both the app and publisher environments. Run
`pnpm --filter @openwork/review-app dev` (port 3011). `uploadReview()` also accepts
local storage through this environment variable, using the same manifest-last
write behavior. Local development has no login; keep it bound to loopback.

## Deploy once to Vercel

Create a project with root directory `apps/review`, enable source files outside
that directory, and connect a **private** Vercel Blob store. Configure
`BLOB_READ_WRITE_TOKEN` for the Preview environment. Enable **Vercel Authentication**
under Deployment Protection with **Standard Protection** (or All Deployments).
Deploy with `vercel deploy --target preview`, then give the deployment a stable
alias and use that alias for `OPENWORK_REVIEW_URL`:

```sh
vercel alias set <deployment-url> openwork-review-<team>.vercel.app
```

Never use a deployment URL (`<project>-<hash>-<team>.vercel.app`) for
`OPENWORK_REVIEW_URL`: it is an immutable snapshot, so every report link would
keep opening the app version from that one deploy. Aliases on `*.vercel.app`
stay under Standard Protection; do not alias a production custom domain.

Teammates open the PR's report link using their existing Vercel account with
access to this project. There is no app password. Vercel authenticates requests
before they reach pages, original JSON, or images; private Blob URLs are never
sent to the browser. Keep Deployment Protection enabled and the review domain
out of protection exceptions. Vercel deployments outside Preview return 503,
because Standard Protection does not protect production domains.

The local journey verifies app behavior after Vercel authentication. Verify
the hosted boundary with an anonymous request to the preview: report, JSON,
and image routes must return Vercel's authentication response. An authenticated
request (or `vercel curl` for verification) must reach the app with no Basic
authorization header. See [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

The **Review app deploy** workflow redeploys the app whenever `apps/review`,
`packages/review`, or the lockfile changes on the default branch (or on manual
dispatch) and moves the alias named by `OPENWORK_REVIEW_URL` to the new
deployment, then checks that the alias still answers anonymous requests with
Vercel Authentication. It needs repository variables
`OPENWORK_REVIEW_VERCEL_ORG_ID` and `OPENWORK_REVIEW_VERCEL_PROJECT_ID` (from
`.vercel/project.json` after `vercel link`) and the `VERCEL_TOKEN` secret.
Report publication uploads data to the existing app; it never creates a
deployment.

Set `OPENWORK_REVIEW_URL` and `BLOB_READ_WRITE_TOKEN` in the publishing
environment. The existing command publishes a compact link when configured:

```sh
pnpm evals:e2e --publish --pr 123 --test-run <run-directory>
pnpm evals:e2e --publish --pr 123 --all --docshot <image.png.review.json>
```

Repeat `--test-run` to choose several runs deliberately, or `--all` to choose
all stored runs matching the current PR head. Every selected source, including
DocShot, must carry the same commit. Optional `--title` and repeatable `--gap`
provide context. Test and image captions supply the default structure. Each
publish replaces the compact comment with the complete selection, preserving
the comment's identity. Include all claimed runs in that selection.

`--dry-run` validates and renders the summary without uploads or GitHub calls
(except resolving the PR head if `--all --pr` is used). Legacy single-run
publication remains available when the review app is not configured.
Visual judging is explicit: `pnpm --dir evals evidence:judge -- --test-run <run>`.

## PR change proofs

Every `evals/specs/**/*.e2e.test.ts` a PR adds or changes is treated as that
PR's proof of work. Nothing is required and nothing is blocked: a PR that
touches no E2E spec produces no proof evidence, and the run says so.

The non-required **PR change proof** workflow selects those specs from the live
PR file list and runs each one in its own bounded job on the exact PR head, with
a virtual display so Electron-driving specs can run. Each job uploads one hashed
artifact. Failed, skipped, unsupported, and cancelled proofs stay visible as
non-passing executions; they never fall back to packaged smoke or another
regression.

The credentialed **Evidence review** workflow runs trusted default-branch code.
It re-reads the current PR file list, derives the same selection, and accepts
exactly one artifact per selected spec and run attempt. Every test record must
name that spec and the current PR SHA. Records from all selected specs are
combined into one report with one section per test. Downloaded PR artifacts are
data and are never imported or executed. Unrelated evidence, unexpected proof
artifacts, stale heads or attempts, and missing or duplicate records are refused.

Candidate publisher and review-app checks live in the PR-only
`Evidence review candidate checks` workflow. It has no publishing secret or
write permission.

For automatic publication, keep repository variable `OPENWORK_REVIEW_URL`, secret
`OPENWORK_REVIEW_BLOB_TOKEN`, and the existing Vercel Preview/private Blob
configuration. No new environment variable is required. Do not require Evidence
review or PR change proof in branch protection; only the proof-supplied contract
is part of the existing required aggregate. Human approval remains in GitHub.

To replay publication without rerunning a proof (default branch only):

```sh
gh workflow run evidence-review.yml --ref dev -f run_id=<pr-change-proof-run-id>
```

The publish job summary says **published**, **skipped**, **unavailable**, or
**failed**. Only **published** confirms delivery. A compact sticky PR comment
links to the private report; no raw trace or public screenshots are used as a
fallback. Signed-in project members should verify the report commit and sources.
Anonymous report, JSON, and image requests must redirect to Vercel Authentication.

## Interactive Freestyle previews

The **Freestyle preview prewarm** workflow prepares both `app-web` and `acme-web`
snapshots for each same-repository PR head targeting `dev`. Configure the repository
secret `FREESTYLE_API_KEY` as well as the Vercel secret below. Fork and Dependabot
PRs do not receive this credential. A manual workflow run prepares its selected ref.
The CI runner checks out the reviewed controller pinned to an immutable commit, never
the PR source. Only the guest VM fetches and executes PR code, without the provider
credential. Update the controller pin after reviewing its code and dependencies.
Each world/commit is serialized in CI; the provider snapshot cache and builder lock
also deduplicate reruns and concurrent reviewer launches. Existing snapshots are
reused until their seven-day expiry. Prewarming does not create a shared reviewer VM:
each click still clones separately. ACME is fully seeded, its service chain verified, and browser entry points compiled
before its memory snapshot is captured. Clones resume those processes; launch only
assigns public access, renews expired demo sessions if needed, and checks readiness.

After prewarming, CI measures two real ACME launches and verifies restored processes,
independent databases/access, sign-in, and a fresh AI Gateway reply. The prewarm job
summary and `freestyle-launch-proof` artifact contain sanitized measurements. These
measure controller launch through first app HTML readiness, **not** reviewer HTTP overhead
or browser rendering. The ACME selected-proof report verifies the world recipe;
it does not benchmark Freestyle. Do not quote a direct launch timing as click-to-usable.
The OpenWork web prewarm job also verifies a fresh clone's app HTML and engine,
with separate ready-link and repeat-page timings in `freestyle-app-launch-proof`.
Fresh clones write their private access file and wait for the first authorized
app HTML response before returning a link, so an early gateway response cannot
hide a still-starting app. ACME snapshots older than five days renew their demo session
before use so a new sandbox does not outlive the session it inherited.

Set `FREESTYLE_API_KEY` in the protected Vercel Preview environment. Every report
offers **Launch in Freestyle**. The server reads the commit from the stored report;
the browser cannot select another revision. On the first launch it checks out that
exact public commit in an isolated builder, installs OpenWork, starts the web app
and local engine, and saves a private running snapshot. Later launches clone it.
Each click gets a new VM, a new hostname, and a new access token, including repeat
clicks from the same reviewer. **Open sandbox** opens the resulting app.

The snapshot contains an empty local workspace and no API keys, production login,
or connected accounts. Models can be connected inside each disposable sandbox.
The first build may take several minutes. Failed builds and launches clean up
their VMs; provider-enforced TTLs also bound interrupted operations. Preview VMs
expire after two hours, and unused snapshots expire after seven days. Snapshot
slugs and VM metadata are durable state in Freestyle, shared across app instances;
a unique builder slug coordinates concurrent first launches. Public routes only
expose the access-controlled gateway; the app and engine listen on loopback.

Prewarm a commit before reviewers arrive:

```sh
node --env-file=.env.freestyle.local scripts/prepare-freestyle-preview.ts <full-pushed-sha>
```

The same provider is available in the world CLI (export `FREESTYLE_API_KEY` in
the invoking shell, or use Node's `--env-file` option):

```sh
pnpm world up app-web --place freestyle --detach --timeout 800000 -- --ref <full-pushed-sha>
pnpm world outputs app-web --reveal
pnpm world down app-web
```

World teardown deletes its owned VM, with a resource ledger for interrupted
teardown. The access URL is a secret world output. Freestyle placement currently
supports `app-web` and the co-located `acme-web` demo. ACME also starts the real desktop app, signed in as the demo owner when available, behind the same private access; **Open Desktop app** streams it through noVNC. If the display cannot start, the rest of the world still launches without that link. The reviewer offers a world selector and a visible personal sandbox panel with service URLs and sign-in details. Developer credentials expand below; copying always returns usable values. Desktop recipes retain their existing placements.

Validate with `pnpm --filter @openwork/freestyle test`, the world package tests,
and the reviewer production build. UI follows DESIGN.md P3, P4, P10, P11, S1,
C1, C2, and C6: the launch stays in place, failures are actionable, and snapshot
details are collapsed. Review has no shared button component, so it uses a native
keyboard-accessible button (P5).

## Report data contract

`packages/review/src/schema.ts` is the runtime schema and TypeScript source of
truth. Sections refer to evidence by stable IDs, allowing the same evidence to
appear in several sections. Images are deduplicated by content within a report.
Original records retain diagnostics; the page loads them only when opened.
Each upload has a new immutable ID. The manifest is written only after all
assets succeed, and the publisher rechecks the PR head before updating GitHub.

Status describes selected evidence: a failed assertion or visual judgment is
Failed; skipped/unknown tests, missing assertion evidence, pending judgments,
and declared gaps are Incomplete. An image-only document is Reference. Human
approval and discussion stay in GitHub.

Freestyle previews use the verified `preview.openwork.software` wildcard: `*.preview` CNAME to `beta-web.freestyle.sh`, `_acme-challenge.preview` NS to `beta-dns.freestyle.sh`, and Freestyle ownership verification. Keep its wildcard certificate active. This avoids the permanent free `style.dev` hostname claim limit; TLS routes still expire with each VM.
