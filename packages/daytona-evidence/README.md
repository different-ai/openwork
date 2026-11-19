# @openwork/daytona-evidence

The web evidence world (`core-chat`, tests tagged `checkpoints`) on Daytona
Linux VMs, selected with `OPENWORK_EVIDENCE_PROVIDER=daytona`. It runs the same
steps inside the VM as `@openwork/freestyle`'s evidence builder.

Layers, each cached as a Daytona snapshot:

| Layer | Contents | Saved as |
|---|---|---|
| `ow-dy-base-ubuntu2404-*` | Ubuntu 24.04 + Node 24 + Bun, 4 CPU / 8 GB / 10 GB | files |
| `ow-dy-evidence-image-v1-*` | tools, Chrome, MySQL, full install at a dev commit | files |
| `ow-dy-evidence-web-v1-*` | this commit built, booted and signed in | files and memory |

A test starts a copy of the commit's world; its processes resume where the
snapshot was taken. The runner drives Chrome through Daytona's private URL for
port 8081 (Daytona token + the in-VM gateway's access cookie). Port 8080 is the
viewer.

Core PR CI sets `OPENWORK_DAYTONA_EPHEMERAL_WORLD=1`: preparation warms only
base/image dependencies, then the journey reuses an active commit template or
builds a unique, private evidence VM and runs it directly. It does not save a
new commit template or wait on another run's template save. The launcher checks
its source SHA and runtime fingerprint before issuing access. Failed preparation
and normal teardown delete that run's VM; idle auto-stop/auto-delete and existing
owned-world cleanup cover abandoned runs. Reviewer checkpoints are unchanged.
Dev warm-up and other callers still save reusable running templates with the
existing layer locks. No fork-during-snapshot behavior is assumed.

Preparation now verifies live Chrome `/json/version` and the authenticated
loopback gateway on port 8081, including the gateway's configured upstream port,
after full builds and fast refreshes. Ready files alone are not health checks.
Launch requires a CDP-shaped response through the private provider route; 401/403
fail immediately as access errors rather than being retried as startup delays.

Before failed preparation or launch deletes its owned VM, bounded diagnostics
record local Chrome/gateway status, service states, selected listener ports,
bounded journal/browser/kernel event categories and the cgroup OOM count.
Launch also records the last eight external responses (status, selected safe
headers, known fixed error bodies; unknown bodies are omitted). Raw private
journals, service environments, cookies, credentials and preview URLs/tokens
never enter these diagnostics. Diagnostic failure cannot replace the original
error or delay cleanup beyond its 15-second budget. External facts reach stderr
before toolbox inspection, even if the toolbox or diagnostic sink stalls. Known
credentials are suppressed even when echoed as otherwise valid trace headers.
Healthy internal endpoints with external 502 suggest the provider preview route;
Chrome failures and guest gateway/stale-port failures remain distinct. Missing
observations remain unresolved. These are post-failure layer hints, not proof of
an incident or grounds to restart services or allocate retries.

- Needs `DAYTONA_API_KEY` for an organization with Linux VMs in
  `OPENWORK_DAYTONA_EVIDENCE_REGION` (default `us-west-3`).
- Builds: `node scripts/prepare-evidence-web.ts` with the provider set.
- Required snapshot saves retry only a definite `Snapshot quota exceeded` rejection,
  for at most 17 attempts over 16 minutes (including provider call time). Jittered
  waits give the 15-minute cleanup job and other jobs' teardown time to free
  capacity; a call already in flight can finish after the retry deadline.
  Diagnostics distinguish exhausted capacity from guest build/test failures.
  The provider enforces the current key's account quota; no fixed quota of 100
  is assumed and retries never delete dev/release snapshots to make room.
- Optional checkpoint saves do not wait for quota recovery. Their rejected save
  promise remains a checkpoint failure, not a successful save or test verdict.
- Cleanup: `node scripts/cleanup-daytona-evidence.ts [--dry-run]`, every 15 minutes in CI.
  Candidates include commit worlds unused for two hours and checkpoints beyond
  the newest 30 or older than 14 hours. The current base and newest warm image
  and world (including the newest active fallback) are retained. Active
  sandboxes, pending snapshots, and snapshots referenced by any sandbox are
  protected. Builders/capture forks protect both parent and labelled target, even
  when stopped (cold saves stop their builder before snapshotting). An unknown
  target blocks snapshot reclamation entirely. Cleanup never deletes those
  builders/forks; their controller/provider TTL owns teardown.
  Only owned terminal worlds/copies idle for two hours are deleted, after rechecking.
  Invalid/incomplete inventory aborts cleanup before deletion.
- This is backpressure, not an atomic quota reservation: concurrent producers
  can still fill the account. There is no aggressive headroom eviction or
  distributed lease in this change. A full account with no safe candidates
  fails with a quota-specific diagnostic after the bounded wait.

## Fresh review previews

`daytonaReviewProvider` also implements fresh reviewer infrastructure previews
when its server-side provider credentials are configured. No OpenWork Cloud
organization, deployment rollout, or feature-authority request is required.
`DAYTONA_PREVIEW_WORLDS`, exported from
`@openwork/daytona-evidence/previews`, currently contains only **`app-web`**.
Desktop and ACME previews are refused before allocation; the evidence noVNC
browser is never substituted for those worlds. Saved-checkpoint behavior is
unchanged.

The provider uses the same REST `DaytonaApi`, private sandbox creation,
`ensureBase` / `ensureLayer` locks and guest script runner as evidence worlds.
It reuses Freestyle's app tools/dependency/compile recipes, runtime, gateway and
health assets; the runtime's browser-domain suffix is adapted to Daytona with a
checked substitution. No local Daytona executable, saved CLI profile, host Git
checkout, or host execution of PR code is needed. Only the isolated guest fetches
and executes the exact pushed report SHA. Production uses `DAYTONA_API_KEY` and
the evidence region/API settings described above.

Report checkout, dependency rebuilds, compilation and runtime run as the dedicated
unprivileged `openwork-preview` user with no new privileges or capabilities.
Only `/workspace`, the user's home and `/opt/openwork-preview/state` are writable
at runtime. Trusted controller/gateway files stay root-owned, and the gateway's
root-only access file is inside a root-only `0700` directory outside that state directory, including while the provider uploads a replacement. Build code therefore cannot
plant a privileged process before a later clone receives its access credential.

Fresh snapshot names (`ow-dy-review-v1-*`) include the full report SHA, world and
controller/recipe digest in their immutable key. Tools alone are shared by recipe.
A root-owned socket is reserved before report code executes and remains held across gateway restarts, preventing port squatting. Launch verifies both the gateway's root PID/listener ownership and the app user's inability to read the gateway credential. Security generation 2 includes the actual build/runtime confinement policy in the immutable descriptor: old root-runtime snapshots are never reused.

A launch verifies restored HEAD as the app user, the exact source marker and controller digest,
then checks the guest engine plus real app HTML and the same-origin backend
through a signed private host and gateway-cookie handshake. Each launch creates
its own VM, access token and deadline; it never reuses a report's live VM. The
server returns only the browser launch link, not provider credentials or CDP.

Access lasts at most two hours from allocation. A guest systemd timer powers off
the clone at the deadline, independent of the invoking function. Daytona's
30-minute idle stop and immediate deletion-after-stop also bound abandoned VMs.
The existing cleanup independently deletes expired owned review VMs **even when
still active**, after rechecking their expiry labels. Fresh world snapshots idle
for two days and tool snapshots idle for seven days are cleanup candidates;
references and in-flight builders remain protected. Guest poweroff/provider
state transitions need live validation; the cleanup is the independent backstop,
not a claim of instantaneous provider deletion at the deadline.

Snapshot preparation is asynchronous under the existing review 202/poll/launch
contract. Progress is read from provider-owned builder names, not process memory.
Cold base/install/snapshot operations can exceed the review route's 800-second
budget: prewarming is appropriate, and Next `after()` is not a durable job queue.
A killed controller's systemd build does not automatically resume snapshot saving;
its idle/cleanup policy still owns teardown. Unit tests use fake REST witnesses;
they do not prove a deployed preview or real provider deadline enforcement.

## Capture the next real Core 502

This instrumentation is diagnostics and readiness hardening, **not a fix or root
cause for the historical 502**. Clean-dev and failing-source fresh-build controls
both answered 200 internally and externally. Keep the causal investigation open
until a real failure is captured on an instrumented head.

### Rollout and run

1. Use a trusted, pushed commit containing these changes. Core CI checks out the
   PR **head SHA**, not the latest base branch. Re-running an old failing run uses
   its old code and cannot retroactively add diagnostics. After normal review and
   integration, branch owners must update their failing branches, or explicitly
   apply the diagnostic commits in isolated investigation branches. Do not change
   another agent's branch or bypass the existing trusted-PR/environment approvals.
2. No product feature flag enables this code: it runs on Daytona evidence-world
   paths. `OPENWORK_EVIDENCE_PROVIDER=daytona` selects it;
   `OPENWORK_DAYTONA_EPHEMERAL_WORLD=1` retains the disposable Core behavior.
   Require an authorized key for the intended organization and Linux VM region.
   A blocked secret/environment approval is a prerequisite, not a passing test.
3. In a clean worktree, use Node 24+ and the pinned pnpm/evals dependencies. Pin
   `OPENWORK_EVIDENCE_SOURCE_SHA` to the pushed commit and, for comparisons, pin
   `OPENWORK_EVIDENCE_IMAGE_SHA` to the same full dev SHA on both sides. Record the
   intended account privately, region, image SHA, command, run/job/attempt and
   exact source SHA. Never print the key, cookies, preview tokens or signed URLs.

```bash
# Supply DAYTONA_API_KEY securely to this process (see the daytona skill).
export OPENWORK_EVIDENCE_PROVIDER=daytona
export OPENWORK_DAYTONA_EPHEMERAL_WORLD=1
export OPENWORK_DAYTONA_EVIDENCE_REGION=us-west-3
export OPENWORK_EVIDENCE_SOURCE_SHA="$(git rev-parse HEAD)"
# Optional comparison pin: export OPENWORK_EVIDENCE_IMAGE_SHA=<full-dev-SHA>
node scripts/prepare-evidence-web.ts && \
  node evals/bin/evals.mjs core/core-chat.e2e.test.ts --local --engine v1 --surface web --checkpoints
```

Do not proceed after failed preparation. `--local` places the test tools on the
runner; the selected Core world still runs on Daytona. No restart/reallocation
loop, quota eviction, or weakened assertion is part of this diagnostic run.

### What to retain immediately

- Open the failing **Core journey** job's log. Look for
  `stage=daytona-evidence-external` (last eight responses, captured UTC times,
  selected safe trace/header facts) and `stage=daytona-evidence-launch`
  (post-failure guest snapshot and layer hint). The records include the source
  SHA and, when available and safe, the owned sandbox UUID and parent snapshot.
  An external record without a guest record can mean toolbox/diagnostic timeout;
  it is not evidence that the browser or provider is faulty.
- Preparation failures use `daytona-world` / `daytona-world-prepare` health records
  and sanitized builder failure categories. The private builder path is named,
  but the raw private log is never uploaded by these diagnostics.
- Download the job log promptly: Actions-log retention follows repository/org
  settings and is **not pinned by this package**. Diagnostic JSON currently lives
  in console/job logs, **not a dedicated diagnostic artifact**. A testkit record
  alone may contain only the original HTTP error and cannot replace those logs.
- `.github/workflows/pr-proof.yml` always uploads native records from
  `evals/results/test-runs/` and `evals/results/.testkit/cli-run-*.json` as
  `pr-proof-<attempt>-<matrix-key>` with **7-day retention**. Preserve them too,
  even when there are zero assertions/screenshots. VM logs at
  `/opt/openwork-preview/*.log`, service journals and browser `chrome.log` files
  disappear with owned cleanup; do not rely on inspecting the VM afterward.
- Unit tests intentionally emit synthetic 502 diagnostics. Only a real Core job,
  its matching source SHA, and its actual failing command count as a recurrence.

### Interpret conservatively

A live Chrome probe failure points to browser startup/crash; live Chrome with a
bad gateway probe or mismatched known ports points to the guest gateway/stale
port. Healthy internal CDP with an otherwise unexplained external 502 suggests
the provider route. A fixed `Sandbox unavailable. Launch a fresh sandbox from the
review.` body identifies a guest upstream error at the external probe; recovered
internal probes do not turn it into a provider failure. 401/403 are access
failures. Missing ports/probes or unavailable toolbox data are unresolved.
Preserve the safe provider request ID for provider-side correlation.

Guest probes happen **after** the last external failure: recovery can occur
between them. Journal categories are bounded hints without raw prose/timestamps,
not a full crash dump; an OOM count of `-1` means unavailable, not zero. Unknown
external bodies are omitted and `bodyBytes` is only the bounded sample size
(maximum 8 KiB). The guest also bounds CDP bodies to 8 KiB. Runner SIGKILL/OOM,
workflow cancellation, or a failure before the launcher catch may prevent guest
collection. A broken stderr transport may lose even the external record, but must
not replace the original failure or skip cleanup. Cleanup/TTL remains enabled;
there is no keep-failed-VM escape hatch.

Classify the next failure from this captured evidence and equivalent controls;
do not call it flaky, pre-existing or a provider incident from healthy controls
alone. Keep raw private logs/credentials out of issues and PR comments.
