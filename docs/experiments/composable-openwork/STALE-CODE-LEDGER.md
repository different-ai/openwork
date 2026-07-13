# Stale-code ledger

No entry is permission to delete. A candidate moves to `removed` only after its
deletion condition passes in the same commit.

| Candidate | Confidence | Evidence | Deletion condition | Status |
| --- | --- | --- | --- | --- |
| `apps/app/src/react-app/kernel/global-sdk-provider.tsx` | high | No imports outside its own file/docs; active provider composition omits it | App typecheck/build, relevant session tests, and canonical core fraimz pass without it | candidate |
| `apps/app/src/react-app/kernel/global-sync-provider.tsx` | high | No imports outside its own file/docs; active provider composition omits it | Same as above; update architecture docs in the deletion commit | candidate |
| Root `test:orchestrator` script | high | Invokes absent `test:router` script | Replace with an existing focused command or remove after CI/reference audit | candidate |
| `ee/apps/den-controller` | high | Directory declares itself deprecated/non-workspace; old runner targets missing `src/index.ts` | Confirm no packaging/deployment/sibling references; remove runner/docs together | candidate |
| `scripts/dev-web-local.sh` Den-controller branch | high | Launches the deprecated controller while root `dev:web-local` uses `dev:den` | Shell/CI/docs reference audit and replacement command proof | candidate |
| Removed Tauri/story-book paths in `scripts/find-unused.sh` | high | Audit indexes paths absent from the live repository | Portable audit tests preserve supported convention coverage | candidate |
| Duplicate Markdown renderer pipeline | medium | Two implementations repeat parsing, link, and rendering behavior | Characterization fixtures prove exact output/security parity before consolidation | candidate |
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

The unused-file scanner is advisory. Its current 335 raw candidates include
framework, build, and generated-entry false positives and were not fully
classified because the wrapper is not portable to macOS Bash 3.2.
