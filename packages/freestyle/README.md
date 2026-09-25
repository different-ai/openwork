# Freestyle preview preparation

## Opt-in web evidence checkpoints

The checkpoint proof keeps its controller on Blacksmith and runs the web app,
Den, databases, Chromium and mocked inference together in one private Freestyle
VM. It does not move the normal test suite or use real model credentials.

```sh
pnpm --filter @openwork/review-app build
pnpm evals:e2e web-checkpoint-fork --local --engine v1 --surface web --checkpoints
# Or open a standalone world, using the merged world/source API:
pnpm world up evidence-web --place freestyle --source app-web=sha:<full-pushed-sha>
```

Supply `FREESTYLE_API_KEY` to the host environment. Do not put it in a guest or
artifact. No Infisical integration is required or added. CI uses the existing
protected `pr-slow-specs` environment and repository secret. The key's delivery
can later change without changing capture or fork APIs.

Checkpoints are explicit and never part of the proof:

- A spec saves one with `user.checkpoint(caption?)` or `step(name, fn, { checkpoint: true })`.
  Tests tagged `checkpoints` also keep their end state. `user.screenshot()` never saves one.
- They run only with `--checkpoints`, on a world that advertises the capability
  (`checkpointCapability` from `@openwork/env`). Only Freestyle-backed worlds do;
  anywhere else the run prints one warning and continues unchanged.
- Capture rule: take image A, start the snapshot without waiting for it to be
  saved, send no input for 5 s (the VM state was captured 0.19–4.1 s after the
  call in measurements), take image B. The same route and visible text label the
  checkpoint **exact**, otherwise **approximate**. The world's `stop()` waits for
  pending saves before deleting its VM.
- A capture failure keeps the image, marks it screenshot-only and never fails the test.
- Opened copies, the review browser and the noVNC client are never checkpointed.

The complete co-located web world is saved: Chromium memory, the engine, Den,
databases, workspace files and the mock stream.

Open the PR's **OpenWork Checkpoints** check for the branch-specific report.
Checkpoint pictures offer **Open from here** directly below the image and inside
the image viewer, followed by **Enter saved browser**. Both controls share the
same copy. **New copy** deliberately restores that same checkpoint again without
reloading the report; retrying a failed initial launch retains its request ID.
Each new launch creates an independent copy behind the private preview gateway. The viewer shows the restored Chromium tab, not a new
page. The deterministic streaming fixture pauses at a known point and exposes
**Continue response** in the viewer. Real external-provider connections are not
promised to survive a fork. The controlled stream hold keeps the paused response still while its checkpoint
is captured.

The evidence world template is keyed by a fingerprint of the files that run
inside the VM (server, app, Den, worlds, eval runtime packages, dependencies and
the controller), not by commit. Commits that only change specs, host-side test
worlds, the review app, docs, CI or host-only Freestyle code reuse the existing
template in seconds. A new world verifies that fingerprint before use.

Limits: ten captures along a VM's checkpoint lineage, 24-hour checkpoint retention, one-hour forks,
and three concurrent forks per checkpoint. Expiry preserves the screenshot.
Request retries reuse the same fork instead of spending another slot. Provider
TTL bounds orphan lifetime; normal teardown deletes source and verification VMs.

The PR proof deploys a separate protected review preview from the same head and
publishes a branch-format report there. It never updates the shared review alias
or waits for a merge to `dev`. The plan and acceptance boundaries are in
[`docs/plans/web-evidence-checkpoints.md`](../../docs/plans/web-evidence-checkpoints.md).

## Existing preview preparation

The first reviewer launch builds one running snapshot per commit and world. Each launch
clones that snapshot into a separate VM with its own URLs, access token, and filesystem.
ACME additionally isolates MySQL and Redis. Build caches never contain a reviewer's running VM.

The `desktop` world is a standalone, signed-out Electron/XFCE desktop, not an ACME
clone with its web links hidden. It installs no MySQL or Redis and starts no Den,
AI Gateway, seeded accounts, or separate web preview. Its private viewer is the
primary URL. The app's blank-slate profile isolates its home, config, engine and
user-data paths. Desktop health and source refresh verify empty onboarding rather
than invoking ACME session renewal.

Preparation reuses four private, immutable layers:

1. **Tools**: OS packages, package manager and OpenCode, keyed by the install recipe.
2. **Dependencies**: all workspace manifests, both lockfiles, package manager
   configuration and patches. Application source and lifecycle hooks are excluded
   during installation; only explicit registry dependency rebuilds run. Manifest
   scripts and descriptive metadata do not invalidate this layer; lockfiles,
   dependency declarations, configuration and unknown fields still do.
3. **Compiled packages**: the dependency key, build recipe and compiled source/config
   inputs. Generated workspace `dist` directories and desktop sidecars are restored
   after checking out the requested commit. Changes to shared packages, the server,
   desktop or build configuration invalidate this layer. Interpreted app/Den source
   is checked out fresh and compiled by its development server on every world build.

4. **Running services**: a fully booted and verified world, keyed by every backend,
   schema, seed, dependency and controller input. Only app frontend source, Den
   components/static assets, and inert docs/CI files may vary. This cache expires
   after 24 hours. It is an immutable snapshot, never a reviewer's live VM.

The final commit snapshot is a new clone of those running services. It checks out
that exact commit, warms the updated module graph and Den pages, reloads the desktop
into a verified new document, and renews demo sessions. Backend/input changes rebuild
and verify the running template first. Schema creation, demo data and AI Gateway
verification run on every new template; CI verifies a fresh gateway reply from the
final snapshot on every commit. Reviewer isolation is unchanged.

Template origins are placeholders that only the authenticated edge rewrites for
browsers. ACME VMs refuse them locally (`/etc/hosts` to loopback): Den still advertises
them to in-VM clients, and the signed-in desktop's OpenWork Cloud MCP otherwise hung
at the public edge on every sync, starving the VM until desktop setup reached the
snapshot deadline. Cloud MCP is unavailable in previews either way.

CI's desktop chat check runs inside the clone with its own 240-second deadline, always
prints one result line (step names and timings only) and exits; the host waits longer,
so a failure names its step instead of a killed command.

Desktop startup overlaps gateway verification and browser warmup. Go compiler workers
use an explicit memory limit to release unused build memory; unused Linux filesystem
caches are released before saving each snapshot. Application memory remains running.
Prepared workspace packages are not built a second time by the desktop launcher.

Concurrent misses share a provider-enforced builder slug. Failed builders publish
nothing and are deleted. Builder deletion runs in the background so provider
cleanup latency does not block the next layer; the 30-minute provider TTL also
bounds cleanup failures and host termination. Cache snapshots
expire after seven unused days and at most thirty days; commit snapshots after seven.
App-web compiled/running keys exclude the local Den/Gateway services and eval
runtime it never starts. Shared package and lockfile changes remain conservative.
Test/lint/typecheck commands in manifests do not invalidate runtime keys; build
and startup commands still do.

Changing dependencies or build inputs can still take several minutes. The fastest path
is a frontend change whose backend and build inputs are already cached.

`scripts/prepare-freestyle-preview.ts` writes `freestyle-build-proof-<world>.json` and a stage
table (to the job summary when run in Actions). `totalMs` measures preparation through a fully materialized running snapshot,
including cache misses, and excludes runner setup and subsequent independent-clone
checks. Nested stage durations overlap: do not add them. A `world` cache hit means
that exact commit was already prepared and is not evidence of a fast new build.
