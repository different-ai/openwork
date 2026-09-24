# Gateway usage recovery and capture cutover

These are explicit operator actions, not request hooks. No operation scans an entire organization's request history. Use a reviewed set of at most 100 request IDs or member IDs per manifest. Never reset existing spend, allowances, extensions, or old `gateway_usage_subject` timestamps to repair capture.

## Tool

Run from the repository root against an isolated/restored database or an explicitly authorized loopback database connection:

```sh
DEN_USAGE_OPERATIONS_DATABASE_URL='<authorized loopback MySQL URL>' \
  pnpm --filter @openwork-ee/den-db exec tsx --conditions=development \
  scripts/gateway-usage-operations.ts --manifest '<private manifest.json>' --output '<new private result.json>'
```

Default: preview, without database mutations. Add `--apply` only after reviewing the preview. The output path must not exist; it is opened privately before any database mutation. Results go to that file, not diagnostic logs. Stdout/stderr contain only bounded operation status/error codes, never credentials, request bodies, SQL parameters or database rows. This CLI refuses non-loopback database URLs. It does not obtain credentials or set up tunnels.

The underlying exported APIs are `listPendingGatewayUsageRequests`, `recoverGatewayUsageRequests`, and `rotateGatewayUsageEpoch` from `@openwork-ee/den-db/gateway-usage-limits`. Each validates an active organization administrator. Member IDs and expected versions are explicit; there is no all-organization fallback. Timestamps use `YYYY-MM-DDTHH:mm:ss.sssZ`.

## Abandoned request recovery

1. Establish an abandonment cutoff beyond the maximum supported request lifetime, and stop/drain the relevant writer before recovering its outstanding work. A long-running live request must not be called abandoned merely because it is slow.
2. Discover up to 100 durable pending request IDs for a member using a `pending` manifest. Legacy pre-migration pending raw rows can instead be supplied by exact request identity from reviewed retained records.
3. Preview `recover` for those exact IDs. Inspect its private result file, then apply the same reviewed IDs/cutoff.
4. Recovery closes the durable receipt as **unknown/incomplete**, not zero-cost/free, unless an immutable priced fact already exists. It decrements the pending tally once. Repetition is idempotent. A later priced receipt can promote the retained event and update its original calendar buckets without recreating a raw request log. The trusted producer/recovery integration submits that existing normalized logger receipt through `createGatewayUsageLimits(db).record(row)`; it must not invent a price or route a post-restart receipt through the live process's reservation-only queue.

Manifest shapes (replace placeholder IDs with real authorized IDs):

```json
{
  "operation": "pending",
  "actor": { "organizationId": "org_<id>", "memberId": "om_<admin-id>" },
  "memberId": "om_<subject-id>",
  "before": "2026-09-17T00:00:00.000Z"
}
```

```json
{
  "operation": "recover",
  "actor": { "organizationId": "org_<id>", "memberId": "om_<admin-id>" },
  "requestIds": ["<retained request identity>"],
  "abandonedBefore": "2026-09-17T00:00:00.000Z",
  "reviewReference": "INTERNAL-REVIEW"
}
```

Raw retention verifies durable pending identity and matching attribution before deleting the raw row. If a legacy pending row lacks that durable copy, the compaction transaction fails with `pending_recovery_required`; transfer/recover the reviewed identity with this tool and rerun retention. Do not bypass the guard or clear the pending tally. Already-lost legacy identities or contradictory counters require separate reviewed repair, not guessed attribution.

## Rollback / mixed-writer cutover

The presence of the same SQL tables does **not** prove continuous capture. This tool requires migrations through 0107. For the initial upgrade from an older schema, stop/drain writers and raw-retention jobs first, retire their database access, apply the forward migrations, and keep intake stopped while preparing the new writer. Do not invoke this tool against an older schema. Migration 0107 suspends existing tracking rows by default; new tracking rows are created by the current fenced writer. For subsequent rollback/legacy-writer intervals on the migrated schema, use this procedure rather than a deployment-only assumption:

1. Preview then apply `suspend` for the explicit affected members and their current `trackingVersion` (0 if no tracker exists). This disables current-writer admission/start, advances the version/epoch, and marks the current calendar buckets historically unknown while preserving all money and outstanding identities.
2. Stop/drain old writer processes and raw-retention jobs and revoke/retire their database credentials or deployment access. Old binaries that ignore the capture protocol cannot be made safe merely by sharing its SQL schema. The tool cannot certify that external deployment/credential action; record its evidence in the review.
3. Deploy the current writer and guarded retention implementation on the migrated schema. Recover abandoned requests as above; resolve legacy pending-marker guard failures before restarting retention. Existing genuinely live, admitted requests retain reserved settlement capacity and their original attribution; suspension does not erase them or prohibit their settlement.
4. Preview/apply `resume` using the version returned by suspension and the reviewed deployment reference. Resume is rejected unless capture is suspended and the expected version matches. It advances the epoch again. Queued starts carrying a stale admission version fail before creating a canonical log or dispatching upstream.
5. Verify `captureEnabled=true`, the new `trackingVersion`, and `coverage.complete=false` for periods overlapping the cutover. Old money remains. Only fresh periods after the new epoch, with continuous current-writer capture and no pending/incomplete receipts, can become complete. Any later legacy-writer interval requires another suspension/cutover.

```json
{
  "operation": "suspend",
  "actor": { "organizationId": "org_<id>", "memberId": "om_<admin-id>" },
  "members": [{ "memberId": "om_<subject-id>", "expectedVersion": 1 }],
  "reviewReference": "INTERNAL-CUTOVER"
}
```

For resume, change `operation` to `resume` and use the returned version. Never infer successful capture from schema presence, silently reuse stale versions, or zero counters. Batched applies commit per subject/request; if an operation is interrupted, inspect/preview again before another apply. Recovery IDs are idempotent; epoch operations use optimistic versions.

## Queue contract

The current writer uses a separate pool of 10 with 8 active jobs, at most 64 queued starts globally and 8 per member, a 2-second enqueue deadline, and at most 128 reserved in-flight requests globally / 64 per member. Queued starts are removed on abort and do not touch the database. Active database starts check cancellation before canonical insertion and before commit; the MySQL driver is not claimed to interrupt an already-running query.

A start reserves its settlement slot before forwarding. Its settlement is neither subject to start-queue capacity nor cancelled with the client socket. All known-cost retries use that reservation; ordinary start overload never discards an already-dispatched receipt. A database outage can still prevent commit: failure is logged safely and the durable pending identity remains recoverable as explicitly unknown. The queue is process-local, not a durable delivery system. After process loss, use the durable APIs, not the live queue's reservation-bound settlement method. Capacity and enqueue deadline errors fail closed before dispatch.
