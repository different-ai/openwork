# Upstream provenance

- Repository: https://github.com/anomalyco/opencode
- Branch: `dev`
- Commit: `38e10eb`
- Vendored: 2026-08-09

## Dropped upstream files

- `src/openapi/`
- `test/openapi.test.ts`
- `test/fixtures/` (used only by the dropped OpenAPI test)

## Local divergences

- The package is published internally as `@openwork/codemode` with repository-local package metadata and TypeScript configuration.
- The OpenAPI export was removed with the dropped OpenAPI implementation.
- Host-supplied named bindings can be exposed as read-only program-scope variables through `CodeMode.execute` and `CodeMode.make`.
- Upstream pins `acorn` 8.15.0; this workspace pins 8.16.0 to reuse the existing workspace resolution.
- `async` functions return promises and run their bodies concurrently, each call with its own scope chain. A per-execution turn (`src/interpreter/turn.ts`) keeps code between awaits from interleaving. This follows the design of anomalyco/opencode#48082 (per-call frames) and anomalyco/opencode#54276 (the turn); upstream has since replaced it with one job queue (anomalyco/opencode#57976), which is not vendored here. Unlike upstream, callbacks whose result the interpreter uses, and `forEach`, await an async callback's promise, so programs written against the earlier inline behavior keep their results.
- Program regular expressions are built through `src/host-regexp.ts`, so a host that runs programs for many callers can install a RegExp subclass that limits match time (`setHostRegExp`). `patches/@opencode__codemode@2.2.5.patch` gives the standard engine the same two construction sites; port it when that version changes. Without an installed constructor both engines use `RegExp` as before.
