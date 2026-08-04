# Scheduled Tasks module

Scheduled Tasks delivers one independently useful local workflow: a person can
create a disabled workspace task, review its exact authority, run it once in a
fresh session, and inspect the durable receipt and produced files.

The feature is packaged behind five boundaries:

1. `@openwork/scheduled-tasks` is the portable open-core package. It owns
   schedule/state/placement contracts, deterministic tick and idempotency
   rules, narrow runtime ports, and the repository conformance suite.
2. `execution.ts` exposes only the local capability vocabulary and re-exports
   the portable execution/cancellation port.
3. `scheduled-task-service.ts`, the SQLite store, and the in-process scheduler
   consume the portable contracts without importing OpenCode.
4. `opencode-execution-adapter.ts` is the only OpenCode implementation of the
   execution port.
5. `module.ts` is the host composition root. It owns the database, authority
   adapter, artifact resolver, routes, scheduler lifecycle, and shutdown.

`apps/server/src/server.ts` may create, register, start, and stop the module;
it must not assemble Scheduled Tasks internals. The desktop consumes the
server API through the narrow `ScheduledTasksClient` contract in the Scheduled
Tasks UI domain.

Recurring daily and weekly execution uses the same domain and execution port.
The SQLite adapter is verified by the same framework-neutral repository suite
that a Den MySQL adapter can run. Its atomic `claimOccurrence` operation—not a
process lock—is the duplicate-execution boundary.

Local background wake drivers and remote Den execution are separate runtime
profiles. They may cause the portable tick port to run, but they do not grant
broader authority, create a second policy engine, or make the domain depend on
OpenCode. Moving between a local workspace and Den worker changes the portable
placement identity and therefore requires a new revision and authority review.
