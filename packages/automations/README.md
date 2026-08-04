# `@openwork/automations`

Pure, infrastructure-free Automations domain shared by hosted and on-prem Den.

It owns the contracts, deterministic once/daily/weekly schedule calculation,
DST behavior, lifecycle transitions, revision digests, occurrence identity,
idempotency, repository and engine-adapter ports, due-work selection, bounded missed
recovery, and repository conformance helpers.

It deliberately has no runtime adapter. Den supplies MySQL persistence, leases,
membership and model checks, Connect access, and the model execution adapter.
The OpenWork desktop is only a Den client and is never an Automation scheduler
or execution host.

## Hosted engine lifecycle

`AutomationEngineAdapter` is the provider-neutral boundary for hosted runs.
Den creates and persists an admission key before calling `admit`; retrying that
key must return the same persistence-safe receipt. The capability access token
belongs only to the admission request and must never be copied into the receipt.

Den persists each observed event by its stable idempotency key before advancing
the contiguous sequence cursor. After a process restart, it loads the receipt
and cursor, calls `read` for the durable state/result, and resumes `observe`
without an in-memory engine handle. Cancellation uses the same receipt, so it
also survives scheduler ownership changes and Den restarts.
