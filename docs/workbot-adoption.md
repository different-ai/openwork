# Workbot adoption (platform admin, read-only)

`den_workbot_adoption` is available through the existing allowlisted-platform-admin
`/mcp/admin` endpoint and as `admin:den_workbot_adoption` through the agent
gateway's existing admin capability gate. It is not an organization-admin tool.
Execution also requires a verified platform-admin actor; catalog-only registration
cannot execute it. The toolset version is `0.8.0`.

```json
{
  "startDate": "2026-10-01",
  "endDate": "2026-10-18",
  "organizationId": "org_example",
  "limit": 100,
  "offset": 0
}
```

Dates are inclusive UTC calendar days, ordered, and at most 90 days total.
`organizationId` is optional and exact, not a name/email search. `limit` is 1–500
(default 100), and `offset` is 0–100,000. Member pages sort by organization id,
then member id. Follow `members.nextOffset` with the same filters; pagination is
not a snapshot if telemetry arrives between calls. If the offset ceiling is
reached with `hasMore: true` and `nextOffset: null`, narrow the cohort dates or
organization filter.

No production queries or customer data are needed to develop/test this report.
The SQL below is a read-only operator example, not a request to run it.

## Deploy the services together

Workbot is generally available on cloud and self-hosted deployments. Deploy Den
API, Workbot and the headless runner together; the runner still needs real
provider configuration.
This is internal measurement, not a separate user-facing feature/flag. There is
no database migration: `event_type` is already `varchar(64)`, not a database enum;
the existing session-dimension JSON holds the bounded facts.

Confirm configuration by **name only** (never paste values into tickets):
- Den: `DEN_HEADLESS_RUNNER_URL`, `DEN_HEADLESS_RUNNER_TOKEN`.
- Workbot: `WORKBOT_DEN_API_URL`, `WORKBOT_RUNNER_TOKEN`.
- Runner: `HEADLESS_MCP_URL`, `HEADLESS_API_TOKEN`, **`HEADLESS_WORKBOT_DEN_API_URL`**.

`HEADLESS_WORKBOT_DEN_API_URL` is a new, non-secret, explicitly trusted Den API
origin (HTTPS, with HTTP allowed only on loopback for development). Do not include
credentials, a path, query or fragment. The runner constructs `/v1/workbot/telemetry`
on that origin and refuses redirects. Set it on either the Node or cells runner
before validating adoption. **Unset means no runner admission or outcome events**;
a generic `HEADLESS_MCP_URL`, even one pointing to Den, never opts into telemetry
or receives the runner's service credential for it.

The three service-token settings must identify the same existing runner service
credential. Workbot's Den URL and the runner's explicitly trusted Den origin must
address the same Den deployment. The service credential plus the turn/member's
live MCP token authenticates telemetry. Org and member are resolved from that
token, never from the payload. The public client ingest cannot submit these
events or the `workbot` source. No new secret is needed; the rollout owner must
configure the new trusted-origin binding before treating the funnel as complete.

Greeting and message admission/outcome facts originate in the runner, not its
browser event stream. Workbot records sign-in only after writing the authenticated
cookie. OAuth callbacks record only persisted, usable grants (external MCP also
requires its readiness check). A denied, expired, or replayed callback is not a
connection success. Connection facts can originate in Den too; `source` names
the adoption dataset, not proof that a specific UI initiated the connection.

Recording is best effort and bounded on service HTTP calls; storage failures
never fail sign-in, messaging or OAuth. There is no durable telemetry outbox:
a process crash or a telemetry/Den outage can lose a fact. Watch the fixed
`[workbot] telemetry_not_recorded` storage warning and
`[workbot] telemetry_delivery_failed` transport warning; validate synthetic traffic
before treating an empty funnel as lack of adoption. Killing Workbot does not
prevent an already-running greeting's terminal outcome from being recorded.

## Event contract

Only `telemetry_event.source = 'workbot'` contributes. No message, session,
profile, user, or organization-name tables are read. All identities in the
report are organization/member ids; there are no names, emails, prompts,
responses, attachment names, context bodies, tokens, signed OAuth state, or
runner session ids. Connection correlation uses only the public transaction nonce;
it is not a credential and is never used to authorize anything.

| Event | Meaning / deduplication |
| --- | --- |
| `workbot.signed_in` | One event per successful Workbot login session, not each page load. |
| `workbot.greeting_started` | First accepted greeting, once per organization/member. |
| `workbot.greeting_completed` | Greeting completed successfully, once per organization/member. |
| `workbot.greeting_failed` | One failed/aborted greeting attempt; a later completion can recover it. |
| `workbot.message_sent` | A member message was accepted, once per message id even across retries; includes main and side chats. Not proof of a completed response. |
| `workbot.turn_completed` | A successful user turn, emitted server-side; the greeting has its separate completion event. Model facts describe the reported answer or an explicitly marked configured fallback. |
| `connection.connected` | A successful OAuth grant, deduplicated per OAuth state. Not merely an OAuth redirect/start. |

`session_id` is an opaque **per-event correlation** (`wb:<sha256 hex>` for
Workbot lifecycle facts, `wb:oauth:<public transaction UUID>` for connections),
not a conversation/runner id. Join a dimension on all of `(org_id, source, session_id)`.
The fixed facts are in `telemetry_session_dimension` with
`dimension_type = 'workbot'`; value/label identify the event (a value may be a
slug). Do not join on label or assume these events share a session id.

Metadata is typed and allowlisted: `ready_count`, `attachment_count`,
`chat` (`main`/`side`), `has_context`, `error_code`, `model`,
`model_source` (`response`/`configured`/`unknown`), `connection_id`, `app_id`.
`has_context` follows the host's validated contextual-turn policy, not a marker
someone can type into a message. Not every fact exists on every event. Optional model dimensions use
`dimension_type = 'model'` and the model id as value/label. Failure grouping
prefers the fixed metadata `model`, falling back to the model dimension value;
missing error/model stays `null`. Failure codes use a shared, closed server-owned
vocabulary (plus numeric HTTP status codes); unknown provider-defined error types
are bucketed, never copied into telemetry even when they look like short slugs.
Credential-like or unreportable model identifiers are omitted, with an unknown
source, rather than collected as model data. The runner also rejects any identity
reflecting its known model key or turn token before delivery. The report extracts
only the fields it uses, not the metadata object or dimension labels.

A nonnegative integer `ready_count` is a successful ready-connection probe.
**Null/missing means the probe was unavailable, not zero.** A positive count on
a sign-in/greeting event, or a subsequent `connection.connected`, is historical
connection evidence. It does not prove a grant is still connected today.

## Cohort and funnel semantics

The cohort key is `(organization id, member id)`. Its day is the member's
**earliest recorded Workbot sign-in**, in UTC. A sign-in before `startDate`
excludes a returning member from this new-adoption cohort; repeated sign-ins
inside the window do not duplicate them. The same person's membership in two
organizations is two separate cohort identities. Nothing joins across orgs.

Observation ends at the exclusive midnight after `endDate`. All milestone
facts must be at/after the cohort sign-in and before that cutoff. Events before
sign-in, other telemetry sources, or another org's connection do not count.
Members who first sign in on the last day have less time to progress; this is
not a fixed-duration conversion/retention report.

The `funnel` fields are cumulative, nested member counts:

1. `signedIn`: all cohort identities.
2. `greetingCompleted`: a completed greeting at/after sign-in.
3. `firstMessageSent`: a message at/after that greeting completion. If an earlier
   message preceded the greeting, a later qualifying message still counts.
4. `atLeastOneConnected`: stage 3 **and** connection evidence at/after sign-in.
   A ready connection observed at sign-in can satisfy this stage; it need not
   be created after the first message. A connection event only before sign-in
   does not qualify without a later positive ready probe.

`observed.messageSent` and `observed.connectionEvidence` are independent facts,
not ordered funnel stages. Member rows include both `firstMessageSentAt` (first
message after sign-in) and `firstMessageAfterGreetingAt` (the funnel milestone).
Main and side chat messages both count.

Greeting states report only evidence:

- `completed`: completion observed, even if there were earlier failures.
- `failed`: one or more failures, with no completion by the cutoff.
- `started_without_outcome`: a start, no failure or completion. This is not proof
  that the greeting is still running; it may be stalled, lost, or unobserved.
- `never_started`: no start, failure, or completion observed. A failure without
  a start is still `failed`, not `never_started`.

`greetingFailedAttempts` includes failures for subsequently recovered members;
`greetingFailedMembers` counts only members without a completion. Error/model
breakdown rows count attempts and distinct org/member identities, so a member
can occur in more than one row. Missing dimensions do not drop the failure.

Connection states are `connected_observed`, `zero_observed` (a successful zero
probe, no positive evidence), or `unknown` (no positive evidence and no successful
probe). None describes the present connection inventory.

## Member readiness, connection counts, and answering models

- `readyCountAtSignIn` is the nonnegative integer probe on the first recorded
  sign-in, not a later login's count. `readyCountAtGreeting` is the
  `greeting_started` probe (the once-per-member greeting snapshot). Null or
  missing probes remain `null`; zero remains `0`.
- `connectionCount` counts successful `connection.connected` events at/after
  sign-in and before the observation cutoff. It is separate from readiness,
  can include reconnects, and is not a count of distinct providers or current
  connections. Events only before sign-in do not contribute.
- `answeringModels.rows` groups **successful greeting and user-turn completions**
  by model id and source, with `greetingCompletions` and `userTurnCompletions`
  counts. Accepted-message/greeting-start models are requested configuration,
  not evidence of which model answered, and do not enter this list.
- `source: response` means the provider-reported answering id;
  `source: configured` means the configured/requested id used as a fallback,
  **not proof of the actual answering id**. Absent/unsupported `model_source`
  is `unknown`; an absent model id remains `null`. The metadata model id is
  preferred, with the same event's optional model dimension as fallback.
- Each member returns at most 10 model/source groups, ordered by total
  completions descending, then source/id. One extra group detects truncation;
  `answeringModels.truncated` and top-level `truncated` disclose it. There is
  no unbounded JSON/model list or message/profile read.

## Bounds and missing data

The report uses four read-only statements via the existing admin query helper,
each with the shared 15-second wall-clock timeout. Overall and daily summaries
cover the **full cohort**, not the current member page. Days with no cohort
sign-ins are omitted. Organization and error/model breakdowns each cap at 1,000
rows and fetch one extra row to detect truncation. Organization rows sort by id;
failures sort by descending attempt count, then error code/model. Member rows
fetch `limit + 1` to determine `hasMore`. The fourth query reads completion
model groups only for the requested member page, with a per-member rank cap of
11 and a global cap of `limit × 11` (at most 5,500 rows).

Each breakdown has a `truncated` field. Member `truncated` is also true for any
nonzero offset because that page is not the whole member list. Top-level
`truncated` is true if any breakdown is partial; **it does not make full-cohort
totals partial**. Filter an organization or narrower date range to inspect a
capped breakdown. A read error/timeout is an error, never a zero-adoption report.

Telemetry is best effort, begins at instrumentation deployment, and has no
historical backfill. Earliest recorded sign-in is not proof of first-ever
product use. Missing events are not proof of inactivity or an absent connection.
The report does not infer acceptance/completion from message text.

## `den_query` example: the same cohort/member-fact calculation

This example uses synthetic UTC dates **2026-10-01 through 2026-10-18**:
`1790812800 <= epoch seconds < 1792368000`. It matches the tool's cohort,
chronology, org/source/dimension joins, and nested stages. `FROM_UNIXTIME` is
used only for instant comparisons; UTC day bucketing uses epoch arithmetic so
it does not depend on the database session's timezone.

Pass the following as the `sql` argument to `den_query` (one statement, no
mutations). To filter an org, add `AND s.org_id = 'org_example'` in
`cohort_members`, not just in the final aggregate. The final `LIMIT 90` caps
daily rows; the tool additionally returns full totals, per-org buckets, member
pages, and error/model breakdowns.

```sql
WITH cohort_members AS (
  SELECT s.org_id, s.member_id,
         MIN(UNIX_TIMESTAMP(s.event_timestamp)) AS signed_in_seconds
  FROM telemetry_event s
  WHERE s.source = 'workbot'
    AND s.event_type = 'workbot.signed_in'
    AND s.event_timestamp >= FROM_UNIXTIME(1790812800)
    AND s.event_timestamp < FROM_UNIXTIME(1792368000)
    AND NOT EXISTS (
      SELECT 1 FROM telemetry_event prior
      WHERE prior.org_id = s.org_id AND prior.member_id = s.member_id
        AND prior.source = 'workbot'
        AND prior.event_type = 'workbot.signed_in'
        AND prior.event_timestamp < FROM_UNIXTIME(1790812800)
    )
  GROUP BY s.org_id, s.member_id
), cohort_greetings AS (
  SELECT c.org_id, c.member_id, c.signed_in_seconds,
         MIN(UNIX_TIMESTAMP(t.event_timestamp)) AS greeting_completed_seconds
  FROM cohort_members c
  LEFT JOIN telemetry_event t
    ON t.org_id = c.org_id AND t.member_id = c.member_id
   AND t.source = 'workbot' AND t.event_type = 'workbot.greeting_completed'
   AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
   AND t.event_timestamp < FROM_UNIXTIME(1792368000)
  GROUP BY c.org_id, c.member_id, c.signed_in_seconds
), member_facts AS (
  SELECT c.org_id, c.member_id, c.signed_in_seconds,
         c.greeting_completed_seconds,
         MIN(CASE WHEN t.event_type = 'workbot.greeting_started'
                  THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS greeting_started_seconds,
         MIN(CASE WHEN t.event_type = 'workbot.message_sent'
                  THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS first_message_seconds,
         MIN(CASE WHEN t.event_type = 'workbot.message_sent'
                   AND t.event_timestamp >= FROM_UNIXTIME(c.greeting_completed_seconds)
                  THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS first_message_after_greeting_seconds,
         MIN(CASE WHEN t.event_type = 'connection.connected'
                    OR (
                      t.event_type IN ('workbot.signed_in', 'workbot.greeting_started',
                                       'workbot.greeting_completed', 'workbot.greeting_failed')
                      AND JSON_TYPE(JSON_EXTRACT(d.metadata, '$.ready_count')) = 'INTEGER'
                      AND JSON_EXTRACT(d.metadata, '$.ready_count') > 0
                    )
                  THEN UNIX_TIMESTAMP(t.event_timestamp) END) AS connected_seconds,
         MAX(CASE WHEN t.event_type IN ('workbot.signed_in', 'workbot.greeting_started',
                                       'workbot.greeting_completed', 'workbot.greeting_failed')
                   AND JSON_TYPE(JSON_EXTRACT(d.metadata, '$.ready_count')) = 'INTEGER'
                   AND JSON_EXTRACT(d.metadata, '$.ready_count') >= 0
                  THEN 1 ELSE 0 END) AS ready_probe_observed,
         MAX(CASE WHEN t.event_type = 'workbot.signed_in'
                   AND t.event_timestamp = FROM_UNIXTIME(c.signed_in_seconds)
                   AND JSON_TYPE(JSON_EXTRACT(d.metadata, '$.ready_count')) = 'INTEGER'
                   AND JSON_EXTRACT(d.metadata, '$.ready_count') >= 0
                  THEN JSON_EXTRACT(d.metadata, '$.ready_count') + 0 END) AS ready_count_at_sign_in,
         MAX(CASE WHEN t.event_type = 'workbot.greeting_started'
                   AND JSON_TYPE(JSON_EXTRACT(d.metadata, '$.ready_count')) = 'INTEGER'
                   AND JSON_EXTRACT(d.metadata, '$.ready_count') >= 0
                  THEN JSON_EXTRACT(d.metadata, '$.ready_count') + 0 END) AS ready_count_at_greeting,
         SUM(CASE WHEN t.event_type = 'connection.connected'
                  THEN 1 ELSE 0 END) AS connection_count,
         SUM(CASE WHEN t.event_type = 'workbot.greeting_failed'
                  THEN 1 ELSE 0 END) AS greeting_failure_count
  FROM cohort_greetings c
  LEFT JOIN telemetry_event t
    ON t.org_id = c.org_id AND t.member_id = c.member_id AND t.source = 'workbot'
   AND t.event_type IN ('workbot.signed_in', 'workbot.greeting_started',
                        'workbot.greeting_completed', 'workbot.greeting_failed',
                        'workbot.message_sent', 'connection.connected')
   AND t.event_timestamp >= FROM_UNIXTIME(c.signed_in_seconds)
   AND t.event_timestamp < FROM_UNIXTIME(1792368000)
  LEFT JOIN telemetry_session_dimension d
    ON d.org_id = t.org_id AND d.source = t.source AND d.session_id = t.session_id
   AND d.dimension_type = 'workbot'
  GROUP BY c.org_id, c.member_id, c.signed_in_seconds, c.greeting_completed_seconds
)
SELECT DATE_FORMAT(DATE_ADD('1970-01-01', INTERVAL signed_in_seconds SECOND), '%Y-%m-%d') AS cohort_day,
       COUNT(*) AS signed_in,
       COALESCE(SUM(greeting_completed_seconds IS NOT NULL), 0) AS greeting_completed,
       COALESCE(SUM(first_message_after_greeting_seconds IS NOT NULL), 0) AS first_message_sent,
       COALESCE(SUM(first_message_after_greeting_seconds IS NOT NULL
                    AND connected_seconds IS NOT NULL), 0) AS at_least_one_connected,
       COALESCE(SUM(greeting_failure_count), 0) AS greeting_failed_attempts,
       COALESCE(SUM(greeting_completed_seconds IS NULL
                    AND greeting_failure_count > 0), 0) AS greeting_failed_members,
       COALESCE(SUM(greeting_started_seconds IS NULL AND greeting_completed_seconds IS NULL
                    AND greeting_failure_count = 0), 0) AS greeting_never_started,
       COALESCE(SUM(connected_seconds IS NULL
                    AND ready_probe_observed = 0), 0) AS connection_unknown
FROM member_facts
GROUP BY cohort_day
ORDER BY cohort_day
LIMIT 90
```

For per-org results, use `org_id` instead of the day expression in the final
projection/group/order and retain an explicit capped `LIMIT`. For one overall
aggregate, remove the day projection/group/order and use `LIMIT 1`. Do not
join arbitrary existing connections to this cohort: that would count grants
before sign-in and incorrectly turn unavailable probes into connected/zero
states.
