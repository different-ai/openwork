# Desktop component tests

Use the CI runtimes: Node 24, pnpm 11.4.0 and Bun 1.3.14, all on `PATH`.
From the repository root after `pnpm install --frozen-lockfile --prefer-offline`:

```sh
pnpm --filter openwork-server build
pnpm --filter @openwork/headless-threads build
pnpm --filter @openwork/remote-sessions build
pnpm --filter @openwork/desktop prepare:sidecar
node apps/server/scripts/build-opencode-plugin-deps.mjs
node --test apps/desktop/test/*.test.mjs
```

These builds do not launch Electron. The server build also builds computer-use,
types, free-auto and enterprise-mcp-client. The session-runner test imports the
compiled headless-threads and remote-sessions packages and tests their packaged
staging, so a dependency install alone is not enough.

The cold-engine test is a **packaged-runtime integration**, not a source-only
unit test. It needs the compiled server, the pinned classic engine sidecar and
`apps/server/dist/opencode-plugin-deps-<opencodeVersion>.tgz`. The archive build
requires registry access during preparation. The test itself then deliberately
points the registry at a server that never answers: cold startup must use the
archive and make **zero** registry requests. Do not increase its timeout or
remove that fault. Missing local assets fail immediately with preparation steps.

`OPENWORK_TEST_EMBEDDED_MODULE_URL` and `OPENWORK_TEST_ENGINE_BIN` select an
already-packaged artifact instead; the CI packaged smoke sets both. It tests the
artifact, not the checkout's archive.

## CI versus local

`.github/actions/setup-tests/action.yml` installs the runtimes, pinned classic
OpenCode CLI and both root/evals dependencies. It does **not** build workspace
packages or the plugin dependency archive. `.github/workflows/ci-tests.yml`
runs selected component tests, not the broad glob above. Its Linux build job
builds the server and runs `apps/desktop/scripts/packaged-smoke.mjs
--server-built`; `electron-build.mjs` prepares sidecars, workspace packages and
the dependency archive before the packaged cold-engine test. The scheduled macOS
packaged job exercises a separate signed update journey. A bare local glob does
not reproduce either packaging pipeline.

For only the journal/runner tests, build computer-use, headless-threads and
remote-sessions, then run `pnpm --filter @openwork/desktop test:session-runner`.
They use isolated fixtures and must drain runner writes before deleting journals.
