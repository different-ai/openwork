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
composed reports, failed and incomplete evidence, private images, and source
records through HTTP. Its inputs are explicitly synthetic fixtures; they do
not claim to have tested the example behaviors shown in the report.

For development, create a directory and set `OPENWORK_REVIEW_LOCAL_DIR` to its
absolute path in both the app and publisher environments. Run
`pnpm --filter @openwork/review-app dev` (port 3011). `uploadReview()` also accepts
local storage through this environment variable, using the same manifest-last
write behavior. Production always requires `OPENWORK_REVIEW_PASSWORD`; HTTP
Basic username is `review`. Keep local development bound to loopback.

## Deploy once to Vercel

Create a project with root directory `apps/review`, enable source files outside
that directory, and connect a **private** Vercel Blob store. Configure
`BLOB_READ_WRITE_TOKEN` and `OPENWORK_REVIEW_PASSWORD` for the app. Deployment
Protection may additionally restrict access to team members. Pages, original
JSON, and images all share the app's access boundary; Blob URLs are never sent
to the browser. Unconfigured production instances return 503.

The app only rebuilds when it or its dependencies change. Report publication
uploads data to the existing app; it never creates a deployment.

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

For automatic publication, configure repository variable `OPENWORK_REVIEW_URL`
and secret `OPENWORK_REVIEW_BLOB_TOKEN`. The separate **Evidence review** workflow
consumes existing uploaded artifacts after checks finish. It runs trusted
default-branch code, ignores stale runs, and only publishes when GitHub supplies
an associated PR and matching source commit. It never runs downloaded code.
An existing review of that commit takes precedence, preserving the author's
selected evidence. Explicit publication can update that selection.
**Do not require Evidence review in branch protection.** Failures remain visible
in its optional workflow; existing test checks retain their verdicts.

## Contract

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
