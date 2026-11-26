# Remote task live sync and durable session binding

* Feature key: `remoteSessionLiveSync`
* Deployments: `cloud`, `self_hosted`
* Default: `false`
* Author: `@benjaminshafii`

## What changes

When enabled for an organization or member:

1. **Durable session binding:** `remote-session:create` and `remote-session:attach` store the parent chat's `parent_session_id` and `parent_workspace_id` on `remote_session_command` in Den MySQL. Opening a chat or launching OpenWork on another device fetches its bound remote tasks in one indexed query instead of scraping loaded messages.
2. **Short-lived transcript tail in Den MySQL:** Den stores the last 20 messages (capped at 32 KB UTF-8 bytes on write, expiring 24 hours after the last update) in `remote_session_tail` so opening a remote task paints from Den without waiting on a round-trip to the remote computer. Optional Redis read-through caching accelerates reads when `DATABASE_REDIS_URL` is configured.
3. **One live stream per window:** OpenWork opens one SSE stream (`GET /v1/remote-sessions/stream`) per signed-in window for status, computer label, pending prompts, and transcript-tail updates. Cross-instance wakeups use Redis pub/sub when configured and fall back to tightened indexed DB checks when Redis is absent.

## Retention and cleanup

* Stored tails expire 24 hours after their last update, enforced on read and deleted by a periodic 15-minute batch sweep.
* Tails are also deleted immediately on computer disconnect, session detach, and organization or member removal.
* Signing out on one device keeps the stored tails so the user's other devices retain fast opens.

## Safe revert

Turning `remoteSessionLiveSync` off immediately returns desktop and web clients to the existing status long-poll and on-demand `POST /v1/remote-sessions/read` flow. Existing remote tasks, unsent drafts, and full session histories on the target computer remain intact.

## What to watch

* Den API logs for `remote_session_signal_listener_error` or `remote_session_tail_sweep_failed`.
* Database read QPS on `remote_session_command_owner_status` and `remote_session_request_runner_status` in multi-instance deployments without Redis.
* Open time (p95) for remote tasks and SSE stream reconnect rates.
