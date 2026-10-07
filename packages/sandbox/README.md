# @openwork/sandbox

One way for OpenWork to use a Linux (or Windows) sandbox on any provider. Code
that needs a sandbox depends on this contract, never on a provider SDK.

## Composable infrastructure

A sandbox is a composition of building blocks. A provider contributes the
blocks it supports; a job uses the blocks it needs and checks for them at
startup.

| Block | What it does | In the contract today |
| --- | --- | --- |
| Compute | create from a snapshot, find by idempotency key or labels, inspect, start, stop, destroy | yes |
| Exec | run a command, read its logs and exit code | yes (`exec`) |
| Endpoints | a URL for a port, public or private, with an expiry | yes (`endpoint`) |
| Storage | named volumes, mounted at create, with scoped erasure | yes (`storage`) |
| Run | a synchronous command with env and working directory | next |
| Files | read, write and stat a file | next |
| Pause | stop without losing memory | next |
| Snapshot | save a running sandbox as a snapshot | next |
| Network | egress rules | later |

`describe()` reports what a provider instance supports (and, as blocks land,
its OS and isolation), so a job fails at boot with a clear message instead of
mid-run.

| Job | Uses |
| --- | --- |
| OpenWork Web workspace (`ee/packages/cloud-runtime`) | compute, exec, endpoints, storage |
| Workbot's computer (`ee/packages/headless-computer`) | compute, run, files, pause if present, snapshot to build its image |
| Worlds and previews (evals, `packages/freestyle`) | compute, public endpoints, snapshots |

## Packages

| Package | Contents |
| --- | --- |
| `@openwork/sandbox` | The contract (`provider.ts`), the error taxonomy (`errors.ts`), `shellQuote`, and `./testing`: a fake provider and the conformance cases |
| `@openwork/sandbox-daytona` | Daytona, through `@daytonaio/sdk` |

Layers above this one stay separate: `ee/packages/cloud-runtime` decides what
runs inside an OpenWork Web sandbox (orchestrator, bootstrap, checkpoints);
`ee/packages/headless-computer` runs Workbot's computer; `evals/packages/hosts`
starts the desktop app, Chrome and Den inside a sandbox. They share this layer
for the sandbox itself.

## Rules

- **Flavors are configuration, not providers.** A Daytona container class, a
  pausable class and the Windows VM are the same adapter with different
  snapshot and class settings; each instance describes its own capabilities.
- **Blocks are optional and additive.** New behaviour arrives as a new block
  or an optional field. A block is supported when the provider passes that
  block's conformance cases.
- **Provider-only features stay in the adapter** (Freestyle domains, Daytona
  linked sandboxes). When a second job needs one, promote it to a block.
- **One vocabulary.** States (`creating` … `missing`) and errors
  (`not_found`, `conflict`, `rate_limited`, `capacity`, …) are normalized by
  every adapter; jobs never parse provider errors.

## Adding a provider

1. Create `packages/sandbox-<name>` implementing `SandboxProvider` with the
   blocks the provider supports.
2. Run `sandboxProviderConformanceCases` from `@openwork/sandbox/testing`
   against it (see `src/conformance.test.ts` for the fake).
3. Select it where a job builds its provider; jobs only see capabilities.

## Test

```sh
pnpm --filter @openwork/sandbox test
```
