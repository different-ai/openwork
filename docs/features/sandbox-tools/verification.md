# Local sandbox first-slice verification

Date: 2026-11-17. Local Apple Silicon macOS, Node 24.22.2, pnpm 11.4.0.
No production, model, remote sandbox or real Den account calls. Loopback Den responses are disposable fixtures.

## Results

| Command | Result |
| --- | --- |
| `pnpm --filter @openwork/sandbox-microsandbox test` | 23 passed, 0 failed, 0 skipped |
| `pnpm --dir evals exec vitest run --project pr ../apps/server/test/sandbox-tools.vitest.test.ts ../apps/server/test/sandbox-mounts.vitest.test.ts ../apps/server/test/local-sandbox-runtime.vitest.test.ts` | 25 passed, 0 failed, 0 skipped |
| `MICROSANDBOX_LIVE=1 MSB_HOME=<fresh short temp directory> pnpm --dir evals exec vitest run --project pr ../apps/server/test/local-sandbox-bridge.live.vitest.test.ts` | 1 passed, 0 failed, 0 skipped |
| `pnpm --filter openwork-server build` | passed; includes native-adapter dependency build, server TypeScript and engine plugin bundles |
| `pnpm check` | all eight passed: typecheck, node-source-imports, outbound-access, features, i18n, app-structure, code-habits, spec-lint |

The adapter's separate live suite previously passed 18/18 on the same platform; the adapter itself is unchanged in
this slice. It covers read-only mounts, egress, lifecycle, port publishing/collisions and timeout cleanup. This is
not evidence for Windows, Linux KVM, packaged Electron or full required-only mode.

## Real bridge witness

The opt-in bridge test uses the actual local adapter and VM, not a fake provider:

1. A disposable Den fixture enables the rollout and returns unrestricted member rules; the real policy reader
   verifies it before dispatch.
2. `shell` answers Linux. `read` retrieves a nonce through an Authorized Folder mounted at its original absolute
   path; `write` changes a file observed independently on the host workspace live bind.
3. Removing that Authorized Folder in the engine-global runtime row stops/recreates the guest. Reading the removed
   path fails while the host's original file remains unchanged, and the workspace file remains available.
4. Revoking the rollout refuses a guest write; independent host `readFile` confirms no sentinel was created.
5. The bridge is closed; remaining test VMs are destroyed and the temporary runtime home removed.

The test is opt-in and reports a skip when the required runtime is not requested; that skip is not a passing
microVM result. The explicit live invocation above ran without skips.

## Independent review corrections

An independent review found three defects before final verification: canonical aliases could bypass lexical mount
restrictions, optional plugin status errors could break unrelated prompts, and a cached stopped guest could remain
unusable after a grant round-trip. The slice now canonicalizes restrictions and missing-path ancestors, treats
additive status outages as off without restoring required-only host primitives, and inspects/resumes a stopped
same-backend guest before dispatch. Regression tests cover each condition.

## Overall boundary

**Passed for this backend/plugin/mount slice; Incomplete for the full requested product scope.**

The actual server can expose only additive tools, never `only`. The plugin's replacement transform is tested, but
Den/local controls, host-side computer/browser/MCP and alternate execution guards, old-client admission and the
real Settings/member-permissions proof are follow-ups. The pinned Claude Agent source uses the transformed registry;
its live CLI/SDK behavior has not been exercised here. No screenshots are offered as proof of an unimplemented UI.
