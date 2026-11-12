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

PRs run only the quick check. Start the non-required **PR change proof** by hand:

```sh
gh workflow run pr-proof.yml --ref <branch> -f pr=<number>
```

It selects specs from the live PR file list and uploads their records as artifacts.
Only secret-free GitHub lanes run; Daytona and real-Mac tests still cannot run
there. Unsupported proofs are not passes and never fall back to another regression.

The credentialed **Evidence review** workflow runs trusted default-branch code.
For a completed hand-started run, it uses GitHub's API to find exactly one open
same-repository PR with the run's branch and head SHA; forks and ambiguous or
missing matches are skipped. Dispatch inputs and artifacts never establish identity.
Existing pull-request runs remain supported. It re-reads the current PR file list,
derives the same selection, and accepts exactly one artifact per selected spec and run attempt. Every test record must
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

## Sandbox provider infrastructure

The reviewer derives launch choices **on the server** from its own provider credentials and supported preview worlds. This is CI/reviewer infrastructure, portable to self-hosted and hosted reviewers; it does not require an OpenWork Cloud organization or query a Den feature authority. Local Daytona CLI authentication proves nothing about a hosted reviewer. When both providers are available, the existing native-selector pattern offers **Provider**; one available provider is selected automatically. `OPENWORK_EVIDENCE_PROVIDER` is the preferred provider, not an enable switch. Unknown configuration fails closed. Missing credentials show an unavailable control and name the review app owner who can configure it.

Freestyle keeps its existing preview worlds. Fresh Daytona previews currently support **OpenWork web only**: a new private Linux VM running the web app and local engine from the report's exact fetchable product commit. Desktop and ACME choices remain visible but unavailable for Daytona; saved browser checkpoints are not passed off as fresh app previews. **Launch** opens an environment for manual review; it does not run verification tests or the enterprise `verify-openwork` skill.

Daytona needs server-only `DAYTONA_API_KEY` and a Linux-VM region (`OPENWORK_DAYTONA_EVIDENCE_REGION`, default `us-west-3`). It reuses the existing Daytona REST client/layer builder and shared app-web guest recipes, not CLI subprocesses or another provisioning service. Report SHA and association come from immutable server storage, never browser input. The gateway uses a signed provider hostname, a per-instance HttpOnly access cookie, two-hour access expiry and a guest shutdown timer; provider auto-deletion and the existing evidence cleanup backstop reclaim owned expired VMs. Failed launches remove only their owned VM. No provider credential enters a guest, report response or browser.

**Configuration boundary:** only the review deployment's server-side provider credentials and advertised capabilities authorize a fresh preview. Missing credentials, unknown providers and unsupported worlds fail closed. Configuration is rechecked for POSTs, readiness polling and deferred builds; removing a provider configuration prevents new allocation without revoking already-issued access or changing checkpoint opening. Provider API origins still require HTTPS, and same-origin request checks, immutable report source, private gateway isolation and expiry remain mandatory. This infrastructure configuration is separate from product feature flags; it does not enable or alter any Cloud/customer rollout.

Cold Daytona preparation can exceed the review function's 800-second budget. Operators can prewarm an exact pushed commit with the exported `buildDaytonaPreview(sha, "app-web")` in `@openwork/daytona-evidence/previews` using a scoped server credential; the same builder is used by the UI. Do not claim a ready preview until snapshot storage and authenticated app/backend probes pass. `OPENWORK_EVIDENCE_PROVIDER=daytona` chooses a preferred provider; it neither supplies credentials nor proves live availability.

## Interactive Freestyle previews

When the evidence report for a PR push is published, the **Evidence review** workflow
builds that commit's `app-web` and `acme-web` snapshots in the background, so
**Launch in Freestyle** is usually ready at the first click. Otherwise the first
launch of a commit and world builds its snapshot after the request returns (`202`),
within the function's 800-second budget. The page polls `GET /r/<id>/launch?world=…`,
which reports the build's current layer and finished service steps (read from the
builder VM tagged with the commit), and shows them like `pnpm world up`: finished
steps with their times, the running step, and what is left. It launches when the
snapshot is ready. Typical first builds: about 2 minutes for OpenWork web and 6 for
ACME with warm caches. The provider's builder lock deduplicates concurrent
first launches. Only the guest VM fetches and executes PR code, without the
provider credential. Clones resume the snapshot's processes; launch only assigns
public access, renews expired demo sessions if needed, and checks readiness.
Fresh clones write their private access file and wait for the first authorized
app HTML response before returning a link, so an early gateway response cannot
hide a still-starting app. ACME snapshots older than five days renew their demo session
before use so a new sandbox does not outlive the session it inherited.

Per-commit snapshots are deleted after two days, or after one day without a launch.
The hourly **Freestyle cleanup** workflow (`scripts/cleanup-freestyle.ts`) reclaims
old naming versions, superseded cache layers and expired checkpoints, and fails when
too many OpenWork snapshots remain. Run it with `--dry-run` to see the plan.

### Checkpoints on Daytona

When CI runs evidence worlds on Daytona (`OPENWORK_EVIDENCE_PROVIDER=daytona`),
checkpoints are Daytona memory snapshots (`ow-dy-checkpoint-v1-*`). Each records
`provider: "daytona"` and always opens on Daytona, whatever the default is. **Open
from here** starts the reviewer's own VM from the snapshot and returns a signed
Daytona host plus the in-VM gateway's one-hour access link. Set `DAYTONA_API_KEY`
(an organization with Linux VMs in `us-west-3`) in the protected Vercel Preview
environment; without it Daytona checkpoints show "Checkpoint access is not
configured". Checkpoint access keeps its recorded provider, independently of the preferred fresh-preview provider.
The hourly **Evidence world cleanup** reclaims Daytona checkpoints after 14 hours.

Set `FREESTYLE_API_KEY` in the protected Vercel Preview environment to offer
**Launch in Freestyle**. The server reads the commit from the stored report;
the browser cannot select another revision. On the first launch it checks out that
exact public commit in an isolated builder, installs OpenWork, starts the web app
and local engine, and saves a private running snapshot. Later launches clone it.
Each click gets a new VM, a new hostname, and a new access token, including repeat
clicks from the same reviewer. **Open sandbox** opens the resulting app.

The snapshot contains an empty local workspace and no API keys, production login,
or connected accounts. Models can be connected inside each disposable sandbox.
The first build may take several minutes. Failed builds and launches clean up
their VMs; provider-enforced TTLs also bound interrupted operations. Preview VMs
expire after two hours, and per-commit snapshots after two days (one day unused). Snapshot
slugs and VM metadata are durable state in Freestyle, shared across app instances;
a unique builder slug coordinates concurrent first launches. Public routes only
expose the access-controlled gateway; the app and engine listen on loopback.

Build a commit's snapshot by hand (for example before a demo):

```sh
node --env-file=.env.freestyle.local scripts/prepare-freestyle-preview.ts <full-pushed-sha>
```

The same provider is available in the world CLI (export `FREESTYLE_API_KEY` in
the invoking shell, or use Node's `--env-file` option):

```sh
pnpm world up preview-app-web --place freestyle --detach --timeout 800000 -- --ref <full-pushed-sha>
pnpm world outputs preview-app-web --reveal
pnpm world down preview-app-web
```

World teardown deletes its owned VM, with a resource ledger for interrupted
teardown. The access URL is a secret world output. The existing world CLI supports
`app-web` and the co-located `acme-web` demo; other desktop recipes retain their
existing placements.

In the review page, **Desktop only (signed out)** selects the distinct `desktop`
Freestyle snapshot: Electron, its local engine and internal renderer, XFCE, and
noVNC. It starts on a fresh profile without Den, MySQL, Redis, AI Gateway, demo
accounts, or a separate web preview. OpenWork's normal empty local workspace and
free starter model are retained, with no conversations or provisioned providers.
Only the private desktop viewer is published; no demo sign-in details are returned. Its dedicated
CI job verifies two signed-out clones, viewer access and cross-clone isolation,
then deletes the test clones (`freestyle-desktop-launch-proof`).

**ACME desktop (full stack)** retains the signed-in demo alongside ACME web.
**Open desktop** streams the actual Electron app, never silently falls back to the
web preview, and remains bound to the world that was launched. Switching choices
clears the previous world's displayed links, not its VM. All choices keep the
same two-hour expiry and access checks.

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

## Developer review workspace

Evidence is the default surface. A verdict banner is the focal element: a
status icon, the selected-evidence verdict, one sentence saying where to look
first, and test/check/screenshot counts. Each section shows its checks as
"N of M checks passed" (open only when one is not passed) and its screenshots
as a numbered gallery; commit, capture time, links and the raw record sit
under "Source and diagnostics". Screenshots with a saved browser carry a
"Saved browser" badge; the checkpoint controls live only in the viewer. All, Failed, and Incomplete filter sections
without changing the report verdict or hiding declared coverage gaps. Next failure returns
to all sections and focuses the next failed section. Narrow screens retain a
native section selector.

Screenshot links open a native modal with fit/100% zoom, previous/next arrow-key
navigation, source assertions, and visual judgments. Image hashes are shareable;
Escape closes the viewer. Original records and traces remain directly linked.

Show sandbox opens an optional panel without moving the report header. The panel
preserves a launched session when hidden or when another environment is selected;
the session's label and links always describe the environment that actually
launched. Credentials start masked. Expiration removes access links and connection
details and offers Launch again. Copy feedback identifies the copied field.

The changed UI follows DESIGN.md P1, P3, P6, P7, P11, S1, S6, C1, C5, C6,
V1 and V2. Native buttons/selects/details and a native modal provide keyboard and
focus behavior (P5); colors reuse the desktop Radix palette. Browser proofs emit
real-size screenshots for P10:

```sh
pnpm --filter @openwork/review-app build
pnpm evals:e2e specs/review-workspace.e2e.test.ts --local
pnpm evals:e2e specs/review-sandbox.e2e.test.ts --local
pnpm evals:e2e specs/freestyle-review.e2e.test.ts --local
```

The sandbox UI proof uses a local HTTP response fixture that intercepts every
mutation. It verifies state transitions without a provider credential or VM;
it is not evidence that a live Freestyle launch succeeds. The ordinary review
fixture remains disconnected and continues testing the real launch route's
missing-connection and cross-origin behavior.
