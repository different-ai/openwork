# Daytona snapshot retention

The Daytona organization has a hard quota of **100 snapshots**. We hit it on
2026-08-14: the `Dev Daytona Snapshot` workflow failed with
`Bad Request: Snapshot quota exceeded. Maximum allowed: 100`, which blocks the
production snapshot pin from advancing — web.openworklabs.com's engine channel
freezes on the last successfully pinned dev snapshot until space is freed.

## Producers

1. **`.github/workflows/dev-daytona-snapshot.yml` (this repo).** Pushes
   `openwork-dev-<shortsha>` on every merge to `dev`, plus a nightly backstop.
   Only the newest snapshot matters — it is pinned into the Render env group
   and served to sandboxes. There is **no cleanup step**, so one snapshot per
   dev commit accumulates forever (~70 at the time of the incident, 0.17 GB
   each).
2. **`different-ai/openwork-snacks`.** Its snapshot build
   (`apps/open-work-snacks/scripts/build-daytona-snapshots.ts`) publishes
   hash-suffixed images (`openwork-snacks-controller-v1-<hash>` at ~2.5 GB
   each, plus 9–11 GB `snacks-code` / `snacks-desktop` / `manual-test`
   images). Its catalog (`den-snapshot-catalog.ts`) references fixed names,
   so superseded hash builds are dead weight.
3. **Release snapshots** (`openwork-<version>` via
   `release-daytona-snapshot.yml`) — low volume, keep.

## Manual cleanup

Requires a Daytona API key with snapshot rights (`daytona login`).

```bash
daytona snapshot list -f json > /tmp/snapshots.json
```

Keep policy (conservative):

- newest **10** `openwork-dev-<shortsha>` — always covers the current Render
  pin (check the `DAYTONA_SNAPSHOT` value in the Render env group referenced
  by the repo variable `DAYTONA_CLOUD_ENV_GROUP_ID` before deleting anything
  newer-looking),
- **all** `openwork-<version>` release snapshots,
- newest **3** `openwork-snacks-controller-v1-*` and the newest of each other
  snacks family (a deployed snacks environment may pin an older hash by exact
  name — confirm with the snacks team before going below 3),
- named singletons such as `openwork-eval-vnc`.

Delete the rest:

```bash
daytona snapshot delete <name> <<< "y"
```

Deletion of a snapshot still referenced by a running sandbox fails; skip those
and re-run after the sandbox recycles.

## Durable fix (not yet implemented)

- Add a GC step to `dev-daytona-snapshot.yml`: after a successful push, list
  `openwork-dev-*`, sort by creation time, delete all but the newest N
  (suggested N=5; the pin automation runs after the push, so the just-pushed
  snapshot is always in the keep set).
- Same retention treatment in `openwork-snacks` for its hash-suffixed builds.
- Until then, expect the quota to fill again roughly every 2–3 weeks at the
  current merge rate; this page is the runbook.
