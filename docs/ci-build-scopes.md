# CI build scopes

Build only the products whose inputs changed. This is internal CI tooling, not a
product behavior change or feature rollout. Required merge checks, test
assertions, release publishing, and manual operator actions remain intact.

## GitHub build boundaries

`.github/scripts/build-inputs.mjs` reads workspace manifests without installing
dependencies and follows their dependency, development, optional, and peer
workspace edges. Explicit inputs cover source reads outside those declarations:
the shared app SPA, the server's MCP App sandbox module, the bundled provider
plugin, desktop version metadata, documentation embedded in Electron, review
colors, and the runner's desktop shell asset. Selective Docker `COPY` inputs are
included too, even when only a manifest is copied.

| Input change | Expensive products selected |
| --- | --- |
| Landing content only | No desktop, EE image, or worker snapshot build; existing landing deployment remains independent |
| Native Electron shell only | Desktop packaging/alpha, not cloud backends or the worker snapshot |
| Shared app UI | Desktop, hosted web client, and worker snapshot; not unrelated API/inference/Workbot builds |
| Den API source only | API and relevant contract checks, not desktop packaging or all EE images |
| Shared workspace dependency | Every consuming product, through the manifest graph |
| Lockfile, workspace/toolchain configuration, patches | Conservative rebuild of affected toolchains/consumers |
| Embedded docs `.md`, `.mdx`, or `docs.json` | Desktop packaging/alpha and docs validation |
| Docs screenshots only | Docs validation, not application/image packaging |

Missing history, incomplete file lists, unknown inputs, or failed comparisons
must select work rather than skip it. Push classification compares the full
`before` to `sha` range with both rename ends and deletions, not only the latest
commit. PR selection keeps its existing broad core/smoke coverage and checks
paginated file counts and head consistency. The stable
`openwork-tests-required` context requires every selected job to succeed and
every unselected job to be skipped. Bare-Node/static assertions run independently
of builds, package installation and services, and still gate that context.

### EE publication and cancellation

Each dev image compares its desired content fingerprint with the label on the
image actually published as `:dev`, not a previous push or a successful unrelated
matrix leg. An absent image/label, registry failure, or unknown fingerprint
selects a build. Queued, cancelled and failed work cannot advance that baseline.
The selection is checked again after acquiring the image's publishing lock.

Images publish immutable run-specific tags/digests first. A per-image lock and a
fresh comparison with that product's latest `dev` inputs guard promotion of the
mutable `:dev` tag. A newer unrelated commit does not disqualify a needed build;
a newer relevant change prevents an older build moving the tag backward. An
API build cannot be cancelled merely because a Workbot-only merge arrives.
Unchanged images retain their original source/version provenance; they are not
claimed to have been built from current HEAD.

Tag/manual runs still select all six EE images and Helm. Targeted infrastructure
PRs exercise all image builds and existing health/migration assertions without
publishing or entering the production environment. Chart validation is
independent of image builds. The gateway deploy hook follows only its own actual
publication; it is not evidence that a native Render source service consumes
GHCR images, and it does not replace the Render filters below.

The first new dev run rebuilds images whose legacy metadata has no fingerprint.
At rollout, let pre-change publishing runs finish (or explicitly cancel them)
before the new publisher promotes images: an old running workflow cannot acquire
or honor the new per-target locks.

### Worker snapshots and other workflows

Runtime push builds use the app/server runtime inputs, not native Electron or
landing sources. Scheduled/manual HEAD builds, promotion, drift checks, and
pruning stay in place as the maintenance/recovery backstop; snapshot naming is
still source-commit based. This deliberately does not turn off the nightly build
or invent content hashes that the pin/drift tools cannot resolve.

SDK/contract, i18n, alpha, runner, and review jobs use their own input boundaries.
Root dependency changes remain conservative. API docs refresh uses the API's
deployment inputs so filtering out an unrelated API deployment does not leave a
refresh waiting for that unrelated commit to appear in production.

CodeQL retains real Swift scans on every dev push, schedule and manual run. Its
all-language required scanning rule and coverage monitor currently expect a
complete commit baseline. Skipping that scan needs a separate proven accounting
change; never upload empty results on dev just to save a macOS build. PR Swift
selection fails open when comparison data is incomplete and scans analyzer
configuration changes too.

When adding a workspace dependency or an external build-time source read, add a
boundary regression and check the relevant workflow's coarse trigger as well as
its job selection. For native Render services, **reapply the stored filters after
workspace dependency or scope changes**. Vercel's existing graph-aware ignores
and cache-warming content reuse are separate mechanisms, not replacements for
these build/deploy decisions.

## Render source-service build filters

Render's native auto-deploys are separate from GitHub's image builds. Changing CI
path selection **does not update Render's settings**. The versioned filters in
`.github/scripts/render-build-filters.mjs` derive their include paths from
`.github/scripts/build-inputs.mjs`; there is no second hand-maintained allowlist
of source directories.

The operator workflow manages only these existing source services, in an
operator-selected Render workspace, linked to
`https://github.com/different-ai/openwork` on `dev`:

| Exact service name | Shared build-input target | Build kind |
| --- | --- | --- |
| `api-private` | `native-den-api` | Native Node / filtered pnpm build |
| `inference-private` | `native-inference` | Native Node / filtered pnpm build |
| `workbot` | `native-workbot` | Native Node / filtered pnpm build |
| `client-web` | `client-web` | Source Docker: `packaging/docker/Dockerfile.den-gateway`, including the app SPA |

Native Node services use their source/dependency closure, not the inputs of an
unused Docker recipe. Den API reads `apps/desktop/package.json` for the desktop
version, so that exact manifest is an API input; the rest of the Electron shell
is not. `client-web` bakes the shared app UI into its Docker image, so app UI
changes must continue rebuilding it. Root toolchain files, workspace/lockfile
changes, patches, the shared input module, and the filter script/workflow are
included. There is no blanket `apps/**` or `ee/apps/**` trigger.

### One-time activation after merge

**This PR does not change live Render services. An operator apply is required
after merge.** Reapply after later edits to the versioned input patterns: a push
does not automatically synchronize Render's stored filters.

1. Open **Actions → Render build filters → Run workflow**, using branch **dev**.
   Preview and apply both run only from `dev` in the canonical repository; they
   never run branch-provided scripts next to the Render key.
2. Enter the **workspace/owner ID** from that Render workspace's Settings page.
   It is a required input, not a committed ID or a guessed workspace. Select
   `all` or one exact service name. Leave **apply unchecked (`false`)**.
3. The workflow uses the existing `RENDER_API_KEY` secret in GitHub's
   `den-production` environment. Never enter a token in workflow inputs, PRs,
   issues, or chat; dispatch inputs are visible in run metadata. Keep that
   environment's approval and branch protections in place.
4. Review the structured JSON plan in the job log/summary. It shows each safe
   service name, input target, previous filter, desired include paths, and
   `would_patch` or `noop`. It omits private service/workspace IDs, API headers,
   build commands, environment variables, and provider response/error bodies.
   Keep any before-state needed for rollback privately; do not commit it.
5. Run the same workflow on `dev` with the same owner/service selection and
   **apply checked (`true`)** only after reviewing the preview. It queries and
   validates live state again and prints a fresh plan before writing. Only
   changed filters get `PATCH { "buildFilter": { "paths": [...],
   "ignoredPaths": [] } }`. Matching filters are no-ops, including reordered
   equivalent patterns.
6. Run a final preview and verify every selected service is `noop`. Observe
   subsequent relevant and unrelated pushes in Render's deployment history to
   verify the intended build suppression. Offline tests and a successful PATCH
   alone are not proof of deployment behavior.

The workflow lists services with `ownerId`, resolves exact names uniquely, then
GETs each current service/filter before the first write. It fails closed for a
missing or ambiguous service, foreign owner/repository/branch, suspended service,
non-root `rootDir`, an unexpected runtime, a shared Build Source, or a different
client Docker recipe/context. Network, pagination, HTTP, and response-validation
errors fail the run; there is no fallback to an unscoped service lookup or an
unfiltered write. All selected services are validated before any PATCH.

Only `buildFilter` is sent in a PATCH. The workflow never changes `rootDir`,
auto-deploy settings, build/start commands, secrets, service type, or any other
service configuration. It does not create services or call a deploy endpoint.
Existing manual/API-triggered deployments remain separate from commit-triggered
build filtering. No Blueprint or new infrastructure is needed.

An apply rechecks the current filter immediately before a write and GETs it
afterward to verify storage. A filter edit observed at that recheck aborts rather
than being silently overwritten; coordinate dashboard edits during an apply,
because the check and PATCH are not a transaction. The operation across four
services is **not atomic**: a network failure after a PATCH can leave a
partial/uncertain apply. There are no automatic write retries or rollbacks.
Inspect the successful per-service results, then **preview again before
retrying**; do not assume a failed run wrote nothing.

### Recovery and maintenance

- If a guard fails, correct the owner selection or audit the changed service
  configuration and shared build inputs. Do not bypass the guard, change root
  directories, widen to every app, or guess build commands/secrets to make the
  workflow pass.
- For a missing build input, fix the shared module, add a regression test, merge,
  preview, and explicitly reapply. The native and Docker build kinds must stay
  distinct.
- For emergency rollback, use Render's dashboard for the exact same workspace,
  name, repository and `dev` branch. Restore **only** the previous Build Filters
  from the private before-state. If there previously was no filter, clear both
  include/ignored path lists (`paths: []`, `ignoredPaths: []`) to restore the
  conservative build-every-commit behavior. Do not change root/autodeploy or
  trigger a deployment as part of restoring filters. Then review/fix the
  versioned patterns before the next apply.

Offline regression tests (no Render credentials or network calls):

```sh
node --test .github/scripts/render-build-filters.test.mjs
```
