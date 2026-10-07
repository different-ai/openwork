# @openwork/sandbox — composable infrastructure

One vocabulary for the sandboxes OpenWork jobs use. MIT-licensed, no runtime
SDK dependency. Providers own transport; jobs own policy.

## Two minutes: use a computer

```ts
import { ensureRunning, sandboxName, SCOPE_LABEL, withBlocks } from "@openwork/sandbox"

const { run, files } = withBlocks(provider, ["run", "files"], "computer")
const box = await ensureRunning(provider, {
  idempotencyKey: sandboxName("development", "computer", conversationId),
  image: provider.currentImage(),
  labels: { [SCOPE_LABEL]: "development" },
  env: {}, storage: [], exposePorts: [],
}, { timeoutMs: 60_000 })

await files.write(box, "/tmp/input.txt", new TextEncoder().encode("hello"), { timeoutMs: 10_000 })
const result = await run(box, {
  command: "cat input.txt", cwd: "/tmp", env: {}, timeoutMs: 30_000,
})
// result: { exitCode: 0, stdout: "hello", stderr: "" }
```

`withBlocks` checks requirements *before provisioning*, and returns a narrowed
TypeScript type. A block is its implementation, not a second boolean flag.
The independently typed interfaces in `blocks.ts` can be supplied separately;
today's provider adapters bind their blocks to the same compute reference.
Arbitrary cross-provider mounts are not promised.

## Ten minutes: jobs, blocks and flavors

| Layer | Responsibility | Consumers |
| --- | --- | --- |
| Sandbox | compute, execution, files, endpoints, storage, snapshots | this package and adapters |
| Job | what runs inside it; startup, checkpoints, idle policy | Web's `ee/packages/cloud-runtime`, Workbot's `headless-computer`, evals' hosts |
| Product/tooling | routing, entitlements, scheduling, preview UX | Den, Workbot, worlds |

This change migrates Web's contract imports, not its lifecycle policy. Workbot
and worlds adopt the shared adapters in separate changes. Their existing SDK
and CLI paths are not silently replaced.

| Building block | Daytona adapter | Freestyle adapter |
| --- | --- | --- |
| Compute lifecycle, discovery, commands | yes (existing Web contract) | yes; stop uses memory-preserving pause |
| Synchronous `run`: env, cwd, exit code, exact stdout/stderr | verified Linux flavor | Linux |
| `files`: read/write/stat | yes | yes |
| `pause`: preserve memory, resume through start | opt-in for a class known to support it | yes |
| `snapshots`: capture a running instance, delete the image | absent; image building is a different operation | yes |
| Persistent volumes | existing Daytona storage implementation | absent |
| Endpoints | signed preview URLs | requires an explicit endpoint binding for TLS/domain setup |

**Flavors are adapter configuration.** Daytona's `snapshot`, `target`, explicit
`platform` and `supportsPause` identify the configured flavor. We do not infer
an OS or pausing support from a snapshot's name. The default Web configuration
is unchanged. The new run block currently implements POSIX `sh` only: it rejects
PowerShell before launching anything. Windows world support remains a follow-up,
not an advertised implementation.

Freestyle rejects create-time env, storage attachments, resource overrides and
archive policy rather than dropping them. Pass process env through `run`.
Its firewall must be explicit, even when it is `{ rules: [] }`.

### Lifecycle and ownership

- `ensure`: adopt by stable identity, or create. Only a proven create conflict
  permits adoption after a failed request. Visibility lag is returned to the
  caller; there is no hidden retry loop.
- `ensureRunning`: inspect and start a stopped instance before executing work.
  It never retries an executed command. Identity plus labels prevent adopting
  another scope's instance.
- `destroyScope`: explicit, destructive, exact-label compute teardown. It lists
  before deleting and returns both successes and failures. It does **not** erase
  persistent volumes or snapshots: those resources need their own owner and
  teardown. An empty scope is rejected.
- `snapshots.destroy`: cleanup belongs to the job that captured an image.

### Predictable processes

A nonzero exit code is a normal `RunResult`, not a transport error. A timeout
throws `SandboxError` and does **not** promise the remote process was killed.
After an unacknowledged launch, inspect rather than repeat a side effect.
Daytona's session logs normalize newlines, so synchronous `run` captures streams
in temporary files and reads the bytes; Web's existing exec logging is unchanged.
Completed captures are cleaned up; an unknown launch leaves its output paths
alone because the process may still be writing.

`instrument(provider, observe)` reports provider, operation, duration and outcome,
never commands, environment values, file bytes or tokens. A broken observer
cannot change the operation result.

## Deep dive: extension and verification

- `provider.ts`: the compatible Web compute/exec/endpoint/storage contract.
- `blocks.ts`: separable process, files, pause and snapshot interfaces.
- `errors.ts`: `SandboxError`, with compatibility aliases for the old
  `RuntimeProviderError` imports. States and error codes stay normalized.
- `lifecycle.ts`: names, capability checks, adoption, wake, exact-scope cleanup.
- `./testing`: fake provider, legacy conformance cases, and explicit per-block
  conformance cases. Selecting an unavailable block fails; it isn't a skipped
  test reported as passed.

A new provider lives in `packages/sandbox-<name>` and implements only what it can
honestly support. Provider-only image building, domains and networking remain
in adapter-specific APIs. Promote a feature when a second real job needs it;
do not build a universal cloud registry or a plan/apply engine here.

```sh
pnpm --filter @openwork/sandbox test
pnpm --filter @openwork/sandbox-daytona test
pnpm --filter @openwork/sandbox-freestyle test
# Opt-in: allocate real instances, with cleanup in finally.
DAYTONA_API_KEY=… pnpm --filter @openwork/sandbox-daytona test:live
FREESTYLE_API_KEY=… pnpm --filter @openwork/sandbox-freestyle test:live
```

Live tests verify exact process output, binary files and missing-file behavior;
Freestyle additionally verifies pause/resume and boots a copy of a captured
snapshot, then deletes both the VM and image. Provider credentials never belong
in repository files.
