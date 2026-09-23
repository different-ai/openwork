# Freestyle preview preparation

CI prepares one running snapshot per commit and world. Each reviewer launch still
clones that snapshot into a separate VM with its own URLs, access token, filesystem,
MySQL and Redis. Build caches never contain a reviewer's running VM.

Preparation reuses three private, immutable layers:

1. **Tools**: OS packages, package manager and OpenCode, keyed by the install recipe.
2. **Dependencies**: all workspace manifests, both lockfiles, package manager
   configuration and patches. Application source and lifecycle hooks are excluded
   during installation; only explicit registry dependency rebuilds run.
3. **Compiled packages**: the dependency key, build recipe and compiled source/config
   inputs. Generated workspace `dist` directories and desktop sidecars are restored
   after checking out the requested commit. Changes to shared packages, the server,
   desktop or build configuration invalidate this layer. Interpreted app/Den source
   is checked out fresh and compiled by its development server on every world build.

The final layer always starts and verifies the exact requested commit. Schema
creation, demo data, AI Gateway verification and browser warmup still run. Desktop
startup overlaps gateway verification and browser warmup. ACME uses 8 CPUs and
16 GiB RAM so its concurrent compilers do not exhaust the base VM's 8 GiB;
reviewer clones inherit that size. Unused Linux filesystem caches are released
before saving each snapshot while application memory remains running. Prepared workspace packages
are not built a second time by its launcher.

Concurrent misses share a provider-enforced builder slug. Failed builders publish
nothing and are deleted; provider TTL also bounds cleanup failures. Cache snapshots
expire after seven unused days and at most thirty days; commit snapshots after seven.
Changing dependencies or build inputs can still take several minutes. The fast path
is a new commit whose tools, dependencies and compiled packages are already cached.

CI uploads `freestyle-build-proof-<world>.json` and writes a stage table to its job
summary. `totalMs` measures preparation through a fully materialized running snapshot,
including cache misses, and excludes runner setup and subsequent independent-clone
checks. Nested stage durations overlap: do not add them. A `world` cache hit means
that exact commit was already prepared and is not evidence of a fast new build.
