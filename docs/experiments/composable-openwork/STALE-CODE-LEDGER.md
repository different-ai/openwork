# Stale-code ledger

No entry is permission to delete. A candidate moves to `removed` only after its
deletion condition passes in the same commit.

| Candidate | Confidence | Evidence | Deletion condition | Status |
| --- | --- | --- | --- | --- |
| `apps/app/src/react-app/kernel/global-sdk-provider.tsx` | high | No imports outside the paired legacy provider/docs; active provider composition omits it | 174 app tests, app typecheck/build, and canonical `core-flow` fraimz pass without it | removed |
| `apps/app/src/react-app/kernel/global-sync-provider.tsx` | high | No imports outside its own file/docs; active provider composition omits it | Same proof; active provider diagram corrected in the deletion commit | removed |
| Root `test:orchestrator` script | high | The router package and its `test:router` owner were removed in `e1a68743`; no workflow, package, documentation, or tracked executable consumes the root alias | Remove the alias; package-local orchestrator typecheck and build pass | removed |
| Orchestrator `test:files` harness | high | This is the surviving file-session integration owner and exercises real behavior, but its Bun-launched server currently fails to resolve dynamic `node:sqlite` | Retain; repair in an orchestrator-owned slice and require the full temporary-workspace integration test to pass | retained / broken |
| `ee/apps/den-controller/README.md` | high | The package/source were removed in `6820933a`, but that commit deliberately retained this 13-line migration stub so historical repository links resolve | Retain as link compatibility; reassess only with evidence that historical links redirect independently | retained |
| `scripts/dev-web-local.sh` and `scripts/dev-den-local.sh` | high | No package/workflow/container invokes either script; the wrapper only calls the former, which `cd`s into the non-workspace controller and starts missing `src/index.ts`; current root aliases use `scripts/dev-local.mjs` | Both scripts removed; the one stale packaging paragraph now points to the live composition root; `dev:den` package-script graph verified | removed |
| Removed Tauri/story-book paths in `scripts/find-unused.sh` | high | Those paths are absent from the live repository and no longer indexed by the audit; the live `apps/ui-demo/vite.config.ts` remains covered | Portable macOS-Bash-compatible fixture passes and audit README uses advisory bucket terminology | repaired |
| Unreferenced AI Elements Markdown/CodeBlock pair | high | `components/ui/markdown.tsx` had no static, dynamic, barrel, convention, test, story, demo, packaging, or documentation consumer; its sole local edge was to the equally unreferenced `components/ui/code-block.tsx` | Remove the pair and its exclusive direct dependencies; app tests, typecheck, both production builds, and the unused-audit fixture pass | removed |
| Duplicate active Markdown renderer pipeline | medium | Two reachable implementations still repeat parsing, link, and rendering behavior; removing the unrelated orphan pair does not consolidate them | Characterization fixtures prove exact output/security parity before consolidation | candidate |
| Duplicate extension translators in app/server | medium | Same resource/config projection concepts have separate implementations | Canonical schema fixtures cover old and current payloads; all consumers migrated | candidate |
| Declared but unproduced enterprise MCP contract variants | medium | `protocol-initialize` / `unknown-request` have no observed producer | Package owner decides to wire or remove; package tests and downstream typechecks pass | candidate |

## Required evidence for every removal

1. Repository import/reference search, including dynamic strings.
2. Package scripts, TypeScript configs, framework conventions, build tools,
   Electron packaging, Docker/Helm, release workflows, and documentation search.
3. Workspace and packed-artifact build where applicable.
4. Focused tests for the removed owner and every known consumer.
5. End-to-end proof for observable or runtime-bearing code.
6. Commit-level rollback: deletion is not mixed with a behavior redesign.

The unused-file scanner is advisory. Its first real run produced 335 raw
candidates and exposed tests, evals, skill scripts, and package entrypoints in
the old `safe to remove` bucket. The portable classifier now calls its first
bucket an investigation queue and routes known convention/config signals to
review. Neither bucket authorizes deletion without the evidence above.

## Cleanup round 2 evidence

- **Root orchestrator alias:** repository history shows `e1a68743` removed the
  router package, its test implementation, and the orchestrator's
  `test:router` script but left the root alias behind. A pre-change run failed
  with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`, and repository-wide search found no
  consumer of the alias. It is removed instead of being misleadingly mapped to
  typecheck or to unrelated behavior. Package-local orchestrator typecheck and
  build remain the green validation commands. Rollback is the one-line root
  manifest restoration, but it must point to a newly owned test rather than the
  deleted router target.
- **Surviving orchestrator integration test:** `test:files` is not stale and is
  retained. An attempted validation built the orchestrator, then failed because
  its harness launches the server with Bun 1.3.9, which cannot resolve the
  server's dynamic `node:sqlite` import. That independent harness defect belongs
  in an orchestrator-owned repair; this cleanup does not hide it behind a root
  alias or broaden into server runtime code.
- **Deprecated Den executables:** exhaustive tracked-file and hidden-file search
  found only a wrapper-to-runner edge plus one stale packaging paragraph,
  excluding this ledger and the architecture snapshot's deliberate candidate
  probe. The runner targets `ee/apps/den-controller/src/index.ts`, deleted in
  `6820933a`; `ee/apps/den-controller` has no package manifest and is not a
  workspace.
  Root `dev:web-local` and `dev:den-local` already delegate to `dev:den`, whose
  `scripts/dev-local.mjs` explicitly composes Den API, inference, worker proxy,
  and Den Web. Rollback is restoration of the two shell files, but they must not
  be advertised or invoked without first migrating them to the live packages.
- **Migration documentation:** `ee/apps/den-controller/README.md` is not an
  executable entrypoint. It is retained because its deprecation commit says it
  intentionally preserves old links. The cleanup removes broken launchers,
  not historical navigation compatibility.

Validation was run through the isolated hub wrapper:

- `bash scripts/find-unused.test.sh` — passed under Bash 3.2.57.
- `pnpm --filter openwork-orchestrator typecheck` — passed.
- `pnpm --filter openwork-orchestrator build` — passed.
- `node --check scripts/dev-local.mjs` — passed.
- `docker compose -f packaging/docker/docker-compose.web-local.yml config --quiet` — passed.
- `pnpm --filter @openwork-ee/den-api build` — passed, including its email,
  install-config, enterprise-MCP-client, and Den DB prerequisites.
- A manifest assertion confirmed the removed alias is absent, both retained
  root Den aliases delegate to `dev:den`, `dev:den` owns
  `scripts/dev-local.mjs`, that file exists, and the deprecated controller has
  no package manifest.

No cleanup-specific fraimz flow is required because this round changes only
unreachable developer entrypoints and their documentation; the experiment's
canonical core-flow proof remains the cross-product regression gate.

## Cleanup round 3 evidence

- **Orphan component graph:** repository-wide searches covered exact paths,
  exported symbols, static imports, dynamic imports, barrel exports,
  `import.meta.glob`/`require.context`, component registries, TypeScript and Vite
  entrypoints, tests, stories, demos, packaging, workflows, and documentation.
  They found no consumer for `apps/app/src/components/ui/markdown.tsx`; its only
  import edge was the adjacent `code-block.tsx`, which likewise had no other
  consumer. The app has no component barrel and Vite reaches components from
  the explicit `index.html` and `overlay.html` module graphs rather than a
  filename convention.
- **History:** commit `9997324f` introduced both orphan files in the same change
  that introduced the live `components/markdown/markdown.tsx` renderer. The new
  message component imported that live renderer immediately, never the orphan.
  The orphan CodeBlock's only later history is the scrollbar-only change in
  `146b4d89`; no consumer was added.
- **Exact deletion:** 213 source lines were removed (110 Markdown and 103
  CodeBlock), together with the now-exclusive direct dependencies
  `react-markdown`, `remark-breaks`, and `remark-gfm`. Lock regeneration removed
  `react-markdown`, `remark-breaks`, and `mdast-util-newline-to-break` from the
  graph. `remark-gfm` deliberately remains in the lock because the retained
  `streamdown` package consumes it transitively. `marked` and `shiki` remain
  direct dependencies for reachable renderers.
- **Active pipelines remain:** `components/ui/message.tsx` and
  `components/ui/reasoning.tsx` still import
  `components/markdown/markdown.tsx`; extension details and artifact previews
  still import `react-app/domains/session/surface/markdown.tsx`. Those active
  marked/Shiki renderers were not changed. This removal does not claim their
  behavior is consolidated.
- **Rollback:** restore the two deleted files and the three direct dependency
  declarations from the parent commit, then regenerate the lock. The deletion
  is not mixed with a behavior redesign, so rollback is isolated.

Validation:

- Hub dependency preparation ran `pnpm install`, refreshed the lock, and
  reported the workspace up to date.
- `pnpm --filter @openwork/app typecheck` — passed.
- `pnpm --filter @openwork/app test` — 179 passed, 0 failed.
- `pnpm --filter @openwork/app build` — production Vite build passed (4,103
  modules transformed).
- `pnpm --filter @openwork/app build:web` — web production Vite build passed
  (4,103 modules transformed).
- `bash scripts/find-unused.test.sh` — passed under Bash 3.2.57.
- Post-deletion assertions confirmed both orphan paths are absent, both active
  renderer paths exist, no orphan path or removed dependency reference remains,
  and all four known active import edges still resolve.

No cleanup-specific fraimz flow is required: the removed modules were absent
from every runtime entry graph, and the production builds plus the existing app
suite prove the reachable application still compiles and behaves as before.
