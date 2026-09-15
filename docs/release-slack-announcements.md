# Release Slack Announcements

Optional notifications run in a separate job in `.github/workflows/changelog.yml`,
only after generated GitHub Release notes update successfully. The publishing workflow
already dispatches changelog generation for stable releases; it needs no change.
Changelog failures prevent notification. Notification failures produce warnings
but do not block the already-published release (`continue-on-error`). Published
does not mean approved for customer rollout. The notification job checks out the
protected `dev` branch afresh; the changelog-writing agent never receives the Slack
secret, and its working files are not executed with that secret.

## Setup

1. Reuse the repository's `SLACK_BOT_TOKEN` Actions secret. The Slack bot needs
   `chat:write` and membership in the target channel (invite the bot).
2. Opt in with repository Actions variable `SLACK_RELEASE_CHANNEL_ID`. Recommended:
   `#ai-dump` (`C0C18F7KF6C`), whose current content is AI-generated summaries and
   automation. Use a channel ID, not a name. There is no hardcoded fallback.
3. Leave the variable unset to disable notifications. Missing configuration,
   including an absent Slack token on unrelated runs, skips all network calls.

The step uses the existing `contents: write` GitHub token permission. It posts only
validated repository/tag text and a canonical GitHub release link, never release
titles or bodies. Mentions and link/media unfurls are disabled. GitHub credentials
go only to `api.github.com`; Slack credentials go only to `slack.com`.

Do not backfill: manually rerunning old tags without notification markers can
announce historical releases after opt-in, including previously undocumented tags.
These notifications follow release-note updates, not changelog PR merge approval.

## Duplicate Prevention And Recovery

The helper reads the live release by tag, requiring matching `vX.Y.Z`, a published
timestamp, and both draft and prerelease flags false. Per-tag workflow concurrency
serializes runs. Before Slack is contacted, the helper PATCHes the release body
with `<!-- openwork-slack-release:pending -->`. After confirmed Slack success
(`ok: true`, nonempty `ts`, matching channel), it replaces that marker with
`<!-- openwork-slack-release:sent -->`. Release-note rewrites preserve both markers.

Either marker suppresses future sends. A pending marker produces a warning and
requires human verification, not an automatic retry. This is **not exactly-once
delivery**: GitHub and Slack are not transactional. Failed/uncertain Slack sends or
final marker updates do not clear pending state. A lost final PATCH response may
mean GitHub already saved `sent`; either state still suppresses another send.

For a warning, inspect the release body's HTML comment and the configured Slack
channel for its canonical release link. If delivered, manually reconcile pending
to sent. Remove pending and rerun only after establishing that no message was
delivered; if uncertain, leave it pending. Never remove sent to repair release notes.
A failed/unconfirmed pending prewrite makes no Slack call. Check bot membership,
`chat:write`, channel ID, token validity, and GitHub release-write permission as
appropriate. Provider error payloads and secrets are deliberately not logged.

Requests have no retries, reject redirects, and time out after 15 seconds for
GitHub or 30 seconds for Slack; the workflow step is bounded to two minutes and
its separate job to three minutes.
Disabling notifications or changing channels does not reset existing markers.

## Helper Contract And Offline Verification

`scripts/release/notify-slack.mjs` exports
`async notifyRelease({ repository, tag, githubToken, slackToken, channel, request = fetch })`.
It returns `{ status: "sent" }`, `{ status: "pending", reason:
"manual-reconciliation-required" }`, or `{ status: "skipped", reason }` with reason
`missing-config`, `not-published-stable-release`, or `already-sent`. Invalid config
and failed/unconfirmed requests reject with sanitized errors. The CLI reads
`GITHUB_REPOSITORY`, `TAG`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, and
`SLACK_RELEASE_CHANNEL_ID`; pending or errors emit a warning and exit nonzero.

`slack-release-markers.mjs` exports `SLACK_RELEASE_PENDING_MARKER`,
`SLACK_RELEASE_SENT_MARKER`, and `getSlackReleaseMarkers(body)`. The helper accepts
a string and returns each exact marker present once, pending first, even if the
body contains duplicates or inline markers.

Use an injected `request` stub for dry/offline verification. There is no live
test or CLI dry-run mode: running with complete real configuration mutates the
release and can send Slack. Do not use real tokens or commit Slack transcripts or
private data as fixtures. Syntax-only checks can use `node --check` on these
scripts; specs are maintained separately.
