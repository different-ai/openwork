# Coworker Release Size

Keep production dependencies limited to **unbundled runtime imports**. Renderer
libraries and other inputs already bundled into main, server, or plugins belong
in development dependencies. Preserve runtime externals and their transitive
dependencies. This is packaging hygiene, not a feature cut: retain the engine,
plugins, PDFium, native modules, preloads, and Computer Use helper resources.

Before adding a dependency, prefer an existing package or Node/Electron API.
Record whether it is bundled or loaded at runtime, its incremental **packaged**
bytes including peers/native assets, and the feature that needs it. Lazy imports
can improve startup but do not remove downloaded bytes. Do not weaken runtime
checks or raise a size budget just to accommodate unexplained growth.

## Measured First Pass — September 10, 2026

Local macOS ARM64 comparison from `feature/open-coworker` at `5ea6b0756` to the
then-uncommitted `perf/coworker-release-size` candidate. Same application build inputs,
Electron 43.2.0, pnpm 11.4.0 isolated dependency collection, Node 24.11.1, and Bun
1.3.4. The CI Bun pin is 1.3.10; this is a local comparison, not CI/release proof.
Both app packages are unsigned; the native helper is ad-hoc signed.
These measurements predate integration onto a newer Coworker head; rebuild to
measure an updated branch rather than treating these bytes as its release size.

| Metric | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Packaged regular-file bytes | 762,588,206 | 513,296,721 | 32.7% |
| Packaged app (MiB) | 727.26 | 489.52 | 237.74 MiB |
| ZIP (`ditto -c -k --keepParent`) | 283,534,451 | 193,855,053 | 31.6% |
| ZIP (MiB) | 270.40 | 184.87 | 85.52 MiB |

The same compiled renderer/server/main/helper outputs were packaged before and
after the collection changes; no runtime feature code or dependency version
changed. The measured reductions are:

- **135.77 MiB:** ship the target-qualified engine once. `beforePack` uses the
  builder target, maps its metadata to `sidecars/versions.json`, and leaves the
  shared staging directory unchanged. Unsupported/missing targets fail closed.
- **84.50 MiB:** do not collect the Computer Use JS package and Swift build tree;
  retain the separate native helper application and its architecture/signature
  validation.
- **17.47 MiB:** remove redundant bundled dependency copies, renderer source maps,
  and 108 compiled server test outputs. Maps remain in the local build output.

Ten direct dependencies moved to devDependencies: `@modelcontextprotocol/ext-apps`,
`@openwork/automations`, `@openwork/browser-tabs`, `@openwork/computer-use`,
`@openwork/headless-threads`, `@openwork/ui`, `dompurify`, `marked`, `react`, and
`react-dom`. They still participate in the build; this is not removal of those
features. Keep the full unbundled embedded-server and explicit main-process
external dependency closure.

Passed: frozen filtered install, full baseline build, candidate packaging and
payload checks, Coworker typecheck, four focused packaging/profile checks,
and isolated packaged imports of the embedded server, MCP client/transports and
browser tools. Electron's in-memory SQLite works and the retained engine reports
1.18.18. The isolated package was extracted outside the repository so parent
node_modules could not hide missing runtime packages. The size check rejected the
baseline's duplicate/debris payload and accepted the candidate.

Full packaged user journeys, Windows/Linux builds, signed/notarized distribution
and CI execution are **deferred / Incomplete**. No release or installed app changed.
An initial packaging attempt used the wrong hook context property; it was repaired
to `context.packager.projectDir` before the successful package above.

## Second Pass — September 11, 2026

Local macOS ARM64 measurement of `open-coworker-optimization` (unsigned, helper
ad-hoc signed) after the toolchain refresh and two runtime-dependency removals,
against the September 10 candidate above. Electron 44.2.0 (Node 24.20), pnpm
11.4.0 isolated collection, Node 24.11.1 and Bun 1.3.4 on the host. Same
target-qualified engine `v1.18.18`. This is a local comparison, not CI or
release proof; Windows and Linux were not packaged.

| Bucket | September 10 | September 11 | Change |
| --- | ---: | ---: | ---: |
| Packaged regular-file bytes | 513,296,721 | 497,764,046 | −15,532,675 |
| Packaged app (MiB) | 489.52 | 474.70 | −14.82 MiB |
| Electron framework | 274.87 | 286.91 | +12.04 MiB (Electron 44; ANGLE statically linked) |
| Unpacked dependencies | 26.08 | 0.00 | −26.08 MiB (`better-sqlite3` removed) |
| Engine, plugins, helper | unchanged | unchanged | — |

The dependency cleanup alone is about 27 MiB; the Electron 44 framework grew by
12 MiB, so the net package is 14.8 MiB smaller than the September 10 candidate.
`better-sqlite3` was never loaded on Electron: the embedded server opens its
runtime database through `node:sqlite` (`runtime-db.ts`), and the Node path
imports nothing from that package. `htmlparser2` and its `domhandler` /
`domutils` tree only served `openwork-office-attachments`, which Bun bundles
standalone into `opencode-plugins/`. Both were mirrors of `apps/server`'s
manifest, not runtime imports of this package.

**Packaging hygiene, same day:** the ASAR still carried 11.3 MiB of dependency
source maps, 2.9 MiB of `.d.mts` / `.d.cts` declarations (classic `.d.ts` is
already excluded by electron-builder), zod's 2.0 MiB shipped `src/` tree, ajv's
`lib/*.ts` sources, and 3.4 MiB of icon files that only electron-builder reads
from the project tree (`.icns`, `.ico`, the Linux set and the 1024 px source).
`files` now excludes those; the two PNGs the main process reads at run time
(`icon.png`, `icon-macos.png`) stay. `.ts` is not excluded broadly because
`@openwork/types` exports its TypeScript sources as the runtime entry.

| Bucket | Before hygiene | After hygiene | Change |
| --- | ---: | ---: | ---: |
| ASAR | 42.14 MiB | 21.70 MiB | −20.44 MiB |
| Packaged app | 474.70 MiB | **454.27 MiB** | −20.43 MiB |
| Files in ASAR | 5,579 | 3,170 | −2,409 |

Against the September 10 candidate the package is now 35.25 MiB (7.2 %)
smaller despite the heavier Electron 44 framework. The isolated Electron-Node
imports of `embedded.js`, `server.js`, the URL guard, the KV store and
`runtime-db` from a copy of the trimmed ASAR outside the repository passed,
zod's runtime entry parsed a schema, and the isolated-profile app launched
with no console errors. `--check` now rejects dependency maps, declarations
and packaging-only icons so the saving cannot regress quietly.

Startup timeline from the same isolated launches (spawn to event, unpackaged
dev tree with the built renderer, local macOS ARM64): CDP reachable 0.7 s,
renderer first contentful paint ~0.36 s after navigation start, welcome screen
visible **1.35 s** on a warm profile and 6.2 s on a first run. The cold gap is
the one-time engine SDK seeding (`engine-sdk.mjs`, `npm install` into the
engine plugin directory), a reliability measure documented in that module, not
renderer work.

Renderer (`vite build`, same source):

| Metric | Vite 6.4.3 | Vite 8.2.2 + lazy screens | Change |
| --- | ---: | ---: | ---: |
| Startup JavaScript (entry + statically imported chunks) | 1,294 kB | 1,013 kB | −21.7% |
| Startup JavaScript, gzip | 377 kB | ~297 kB | −21% |
| Deferred chunks (settings, providers, apps, computer, browser, MCP host, reset, local mode) | 0 | ~259 kB | loaded on first use |
| Production build | 1.23 s | 0.4–0.6 s | Rolldown/Oxc |
| `typecheck` (both projects) | 4.5 s | ~1.0 s | TypeScript 7 native |

Passed: frozen isolated install, coworker typecheck and unit tests (444 pass, 1
skipped; the pre-existing `prompt-stack` tool-catalog budget failure at 18,039
chars is unchanged from the base head), full `build:electron`, unsigned
`--dir` package, `release-size --check --arch arm64`, isolated Electron-Node
imports of `server/dist/embedded.js`, the URL guard (`undici`), the KV store
(`drizzle-orm`) and `runtime-db` from an `app.asar` copy outside the repository,
`node:sqlite` in Electron's Node, and a launched isolated-profile app whose
lazily loaded local-setup screen mounted from the built chunks without console
errors. Deferred / Incomplete: packaged user journeys, Windows and Linux
packages, signed distribution and CI execution. No release or installed app
changed.

The 512 MiB budget is unchanged: a single Electron major can add 10–15 MiB of
framework, and the remaining headroom is deliberate. Remaining dependency
attribution after this pass: `drizzle-orm` 8.88 MiB (eager KV store import; a
shared-server change), `@modelcontextprotocol/client` 6.28 MiB plus `core`
1.25 MiB (the enterprise MCP client's runtime), `zod` 3.83 MiB (its packaged
tree includes every locale and the v3/v4 compatibility surface), and
`@modelcontextprotocol/sdk` 2.74 MiB.

## Measure One Package

Run from the repository root after packaging has finished. Pass the exact `.app`
on macOS, or the exact Windows/Linux unpacked directory, not `dist-electron`, an
installer, or `app.asar`. Use the actual output path for the target:

```sh
node apps/coworker/scripts/release-size.mjs "apps/coworker/dist-electron/mac-arm64/Open Coworker.app"
node apps/coworker/scripts/release-size.mjs "apps/coworker/dist-electron/mac-arm64/Open Coworker.app" --check --arch arm64 --json /tmp/coworker-size-arm64.json
node apps/coworker/scripts/release-size.mjs apps/coworker/dist-electron/win-unpacked --check --platform win32 --arch x64
node apps/coworker/scripts/release-size.mjs apps/coworker/dist-electron/linux-unpacked --check --platform linux --arch x64
```

The build-only script uses Node builtins and electron-builder's existing
`app-builder-lib -> @electron/asar` dependency. No new dependency is required;
run it with the filtered/isolated build dependencies installed.

- Default mode reports size without enforcing cleanup invariants or a budget.
- `--check` rejects duplicate/generic or missing target-qualified engines,
  renderer maps and server test artifacts in ASAR, dependency source maps and
  `.d.ts` / `.d.mts` / `.d.cts` declarations in ASAR, packaging-only icon files
  (anything under `resources/icons/` other than the two runtime PNGs), packaged
  `@openwork/computer-use` / `@openwork/ui`, and native `.build` / `.dSYM` debris
  in unpacked dependencies. It also requires nonempty main/server/preload/reset
  entries, renderer HTML, sidecar metadata, declared plugin bundles, PDFium, and
  the macOS helper. Plugins must not also be duplicated inside ASAR.
- Platform comes from the package layout; engine architecture comes from its
  target-qualified filename, never the host CPU. Optional `--platform` asserts
  the layout and `--arch` asserts the engine target with `--check`. These are not
  native binary/signature checks; existing afterPack checks remain authoritative
  and unchanged.
- `--check` enforces a **512 MiB macOS ARM64** package budget, based on the
  489.52 MiB candidate above. Other targets have no numeric budget until measured;
  their payload invariants still run. `--max-mib <positive-number>` explicitly
  supplies a different budget for a comparison, including report-only mode.
- `--json <path>` writes the report even when a size/invariant gate fails. Its
  parent must exist outside the app, including through symlinks, and the output
  file must not already exist. Existing files are never overwritten.
- Exit status is zero for a successful report with all requested gates passing,
  and one for invalid input, missing/unreadable ASAR, output errors, or gate
  failures. Full numeric byte counts and gate results are available in JSON.

## Accounting

The total is the sum of logical **regular-file bytes** in this staged package.
Directories and symlinks contribute nothing; symlinks are never followed.
Hardlinked regular-file paths count separately. Mutually exclusive buckets split
Electron/framework files, the physical ASAR, unpacked dependencies, sidecars,
plugins, and helper/other resources. On macOS, framework/executable/localization
files form the Electron bucket; on Windows/Linux, files outside `resources/` do.

The top 20 dependency names aggregate packed file sizes from the ASAR header and
actual regular files in `app.asar.unpacked`. Virtual unpacked entries and ASAR
links add no second copy. Nested files belong to their innermost package;
multiple packaged versions aggregate under the same name. This attribution is
**already included in the total**, not an additional disk cost, and excludes ASAR
header overhead and bundled code without a `node_modules` path.

Staged package size, installed filesystem allocation, and compressed download
size are different measurements. Compare the same target, packaging/signing
stage, and metric. The script does not
invoke Git or label an artifact with the current checkout's HEAD: release
provenance should be recorded by the build that produced the artifact.

## Integration And Limits

The build workflow runs `--check` on unpacked targets before uploading and on the
signed macOS app after its existing signature/import checks. Reports are in build
logs. Local JSON can be retained alongside artifacts, never inside the signed app.
Run against a completed package, not concurrently with packaging/signing.

Retain existing native CPU/signature checks and packaged runtime verification;
metadata presence alone does not prove imports, startup, or feature behavior.
Remaining opportunities are measured, not assumed safe to remove:

- `better-sqlite3` **26.08 MiB**: unused by Coworker's current Node SQLite path,
  but still retained by the shared server manifest and Drizzle's optional peers.
  Remove that runtime edge deliberately; do not blindly prune transitive imports.
- `drizzle-orm` **8.88 MiB**: eagerly imported by the unbundled server's KV store,
  even though this Electron path uses Node SQLite. Isolating its Bun-only path is
  shared-server work and needs storage/restart proof.
- Electron/framework **274.87 MiB** plus the required engine **135.77 MiB** dominate
  the remainder. Replacing either is a product/runtime change, not a dependency
  cleanup. Do not strip locales, architectures, permissions or browser capability
  without an explicit supported-feature decision and target-specific validation.
