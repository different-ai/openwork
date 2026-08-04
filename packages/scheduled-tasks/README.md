# `@openwork/scheduled-tasks`

This package is the engine-neutral Scheduled Tasks contract shared by local
OpenWork and hosted or self-hosted Den runtimes. A runtime is a composition of
narrow repository, tick, wake, execution, authority, artifact, and notifier
ports. Operating-system timers and cloud cron endpoints may wake a runtime;
they never own prompts, grants, retries, or run history.

The package owns:

- manual, daily, and weekly schedule calculation, including DST behavior;
- task and run state helpers;
- deterministic due-task selection and occurrence/idempotency identity;
- local-workspace and Den-worker placement contracts;
- execution principals and versioned or digested capability references;
- the durable repository contract and its framework-neutral conformance suite.

Adapters stay outside this package. SQLite and OpenCode remain in
`apps/server`; MySQL, Den authentication, worker leases, and cloud triggers
belong to Den; launchd and other OS integration belong to the desktop runtime.

Changing a target, scheduler owner, availability, principal, or reviewed
capability changes `scheduledTaskPlacementIdentity`. Callers must create a new
task revision and obtain a new authority review rather than silently carrying
a local grant to the cloud or vice versa.

Repository adapters prove the shared atomicity contract by calling
`verifyScheduledTaskRepositoryConformance` from `@openwork/scheduled-tasks/testing`
with an isolated repository factory. The same verifier accepts synchronous
SQLite and asynchronous MySQL implementations.
