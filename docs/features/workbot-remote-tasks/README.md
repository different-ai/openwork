# Workbot remote tasks

`workbotRemoteTasks` is independent and **default off** on every deployment.
It enables remote-task introspection and guarded Stop controls, plus header integration. Workbot's working
status/profile flags still choose which surface shows them. No live flags are
changed by this implementation.

## Data and authorization

`GET /v1/workbot/remote-jobs?chat=<optional side chat id>` reads only the signed-in
member's derived runner chat. The route checks Workbot access, this flag and side
chat access before any runner read. The service also refuses discovery when the
flag is absent. The hook and rows check the host's `remoteTasks` boolean; cached
results are masked when the flag is off.

Remote refs come only from matching successful persisted `execute_capability`
`remote-session:create` calls and their tool returns. Neither assistant prose nor
task titles can introduce a ref. Workbot uses Den's existing `execute_capability`
`remote-session:status` path with the member's OAuth token, not a service token or
caller-selected organization. That path retains current membership, scope and
remote-command ownership checks. A denied or failed read remains unverified;
a completed local watcher never proves remote completion.

Pure status watchers can be hidden by their explicit `watcherTaskIds` (runner
message ids with the `wb_` prefix removed). To qualify, every tool call in that
task must be a status check/read-by-command-id for a discovered ref. A task that
also does other work stays visible, even with an identical title.

## Bounded first version

Discovery reads the latest 40 turns / 1,000 messages with tool outputs and follows
at most ten distinct remote refs. `hasEarlier` says the window may omit older
work. Oversized/malformed/truncated create outputs are ignored rather than
inventing refs. Remote status is fetched once per read (no wait) and shared by
the header/profile query, at most every 15 seconds while visible. Failed reads
retain the prior state marked “Couldn't verify now”, including its observed time.

The collapsed row shows title, computer, verified state, elapsed time while active,
and the latest reported step. Disclosure reads up to 12 remote messages and exposes
only the last six, at most 4,000 characters each. Its checklist contains only the
latest reported step, not invented history. Text, pending summaries and previews
are plain text, never HTML or executable approval controls.

`GET /v1/workbot/remote-jobs/:key` and `POST /v1/workbot/remote-jobs/:key/stop`
rediscover the actor-owned create receipt and live status on every request. The
browser cannot choose a remote session/workspace or pending read request id.
A Stop action passes the last read user-turn id as the existing `remote-session:stop`
`messageId` guard; Den refuses to stop a newer turn. No invented `cancel` API is used.
Pending reads are collected by their server-kept request id, bounded by member/chat/job
and time. Stop responses distinguish stopped, pending and not stopped; transport
failures remain unconfirmed and are never automatically retried.

The UI never approves, retries work, navigates automatically or claims an answer
was delivered. Review/answer, full history and follow-ups remain in the remote session.
A desktop without a reported native session/latest user-turn id cannot be stopped
from this surface.

## Integration contract

`ee/packages/workbot-ui/src/remote-jobs.tsx` exports:

- `useWorkbotRemoteJobs(enabled)` → query with `data: { jobs, hasEarlier }`.
- `RemoteJobs({ jobs })` → profile rows; tap for bounded latest messages and guarded Stop.
- `remoteJobActivity(jobs)` → latest verified active remote task or `null`.
- `remoteWatcherTaskIds(jobs)` → exact watcher ids to de-duplicate.
- `remoteJobActive`, `remoteJobStateLabel`, `retainRemoteStatuses`.

Protocol types/schema live in `@openwork/types/workbot-remote-jobs`. Server APIs:
`buildWorkbotRemoteJobs`, `applyWorkbotRemoteStatuses`, `readWorkbotRemoteJobs`,
`readWorkbotRemoteJob`, `stopWorkbotRemoteJob`, and corresponding
`createWorkbot(...)` methods: `readRemoteJobs`, `readRemoteJob`, `stopRemoteJob`.

DESIGN rules: P1 truthful state, P3 disclosure, P9 no implicit consent, S1/S2 flat
compact rows, S3 native details, S5 no auto-navigation, C3 no exposed tool ids.
The parent change supplies integrated real-size screenshots; isolated logic tests
do not claim a live remote run.

## Verification

```sh
pnpm --filter @openwork-ee/workbot exec tsx --conditions=development --test scripts/remote-jobs.test.ts
pnpm --filter @openwork-ee/workbot exec esbuild scripts/remote-jobs-ui.test.tsx --bundle --conditions=development --platform=node --format=cjs --jsx=automatic --external:react --external:react-dom --external:@tanstack/react-query --external:zod --outfile=node_modules/.cache/remote-jobs-ui.test.cjs
pnpm --filter @openwork-ee/workbot exec node node_modules/.cache/remote-jobs-ui.test.cjs
pnpm features:check
```
