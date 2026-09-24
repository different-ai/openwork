# Freestyle preview preparation

CI prepares one running snapshot per commit and world. Each reviewer launch still
clones that snapshot into a separate VM with its own URLs, access token, and filesystem.
ACME additionally isolates MySQL and Redis. Build caches never contain a reviewer's running VM.

The `desktop` world is a standalone, signed-out Electron/XFCE desktop, not an ACME
clone with its web links hidden. It installs no MySQL or Redis and starts no Den,
AI Gateway, seeded accounts, or separate web preview. Its private viewer is the
primary URL. The app's blank-slate profile isolates its home, config, engine and
user-data paths. Desktop health and source refresh verify empty onboarding rather
than invoking ACME session renewal. A separate CI job verifies two clones, exact
source, signed-out state and access isolation before deleting them.

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

CI uploads `freestyle-build-proof-<world>.json` and writes a stage table to its job
summary. `totalMs` measures preparation through a fully materialized running snapshot,
including cache misses, and excludes runner setup and subsequent independent-clone
checks. Nested stage durations overlap: do not add them. A `world` cache hit means
that exact commit was already prepared and is not evidence of a fast new build.
