# Model catalog freshness

OpenWork keeps the shared `models.openworklabs.com` mirror. Both managed engine
lanes use it through `resolveOpencodeModelsUrl`; an explicit catalog override
and the development inference server retain priority. Provider credentials and
OpenWork's curated managed-model overlay are unchanged.

The Update Models workflow runs daily at 04:17 UTC and still accepts manual
runs against an explicit base branch. Scheduled runs target `dev`. Both kinds
of run use the same concurrency group for that branch. The updater validates
an entire upstream response before replacing the snapshot; an unchanged
response produces no diff. Updates continue through the existing snapshot PR,
required checks, approval and deployment process. This is eventual freshness,
not an instant or guaranteed daily deployment: GitHub scheduling, checks,
merge gates, and the catalog site's deployment must succeed.

## Investigation of #4035

At dev `85a5dfccb`, the Go catalog's identifiers and metadata match models.dev.
The snapshot refresh in #4340 restored the reported additions. A fresh isolated
cache with the pinned v1.18.18 engine and the production mirror exposes
GLM-5.3 and GLM-5.3 Flash after `models opencode-go --refresh`. The engine filters
out deprecated entries, including the snapshot's ox-alpha entry. Discovery was
tested with a synthetic credential; no generation or paid account access was
tested. A model's presence cannot establish account-specific availability.

The recurrent problem remained: snapshot updates required manual dispatch and
the broader mirror already differed from upstream. #4112 was closed unmerged
because bypassing the shared mirror was unwanted. This change automates the
existing refresh flow instead. #4471 changes managed inference capabilities
and settlement; #4388 and #4489 add v2 and organization-provider behavior.
None schedules this mirror's refresh.

The pinned engine versions are v1.18.18 and v2 0.0.0-beta-19086. In upstream
v1.18.18, `packages/core/src/models-dev.ts` keys disk caches by catalog URL,
checks a five-minute disk freshness window, refreshes on startup and hourly,
and invalidates its in-memory catalog after refresh. OpenWork's picker query
cache is five minutes; reconnecting cannot make an unchanged mirror newer.
This patch changes neither engine nor picker cache policy, and does not
certify v2 cache timing or existing installed clients.

## Verification

`pnpm evals:pr specs/model-catalog-refresh.test.ts` drives the production updater
CLI against a loopback HTTP catalog. Synthetic successive snapshots prove
additions and removals, retained metadata, unchanged output on repeated refresh,
and preservation of valid output after empty, invalid, or failed responses.
The world owns temporary output; it never writes the repository snapshot.
No existing journey covered the snapshot publication boundary, so this is a
new journey. It does not dispatch a production workflow or prove a live merge
or deployment. Scheduled dispatch can only be observed after this workflow
lands on the default branch.
