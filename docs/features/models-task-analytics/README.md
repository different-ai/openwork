# Gateway analytics preservation

Organization Analytics, Usage & adoption, Models & usage, and Workflow Runs reporting have been retired. Usage reporting lives in AI Gateway.

Desktop adoption pings, task/tool/skill metadata collection, and their ingestion APIs are removed. `0128_remove_legacy_analytics.sql` originally dropped `telemetry_event` and `telemetry_session_dimension` and deleted `source = 'app'` rows from `models_analytics_event`. It now does nothing, so installs that have not applied it keep that data for when Analytics returns. Databases that already applied the original keep their migration receipt and are not touched again.

## Data that must stay

- AI Gateway request logs, usage rollups, token/cost accounting, billing ledgers, limits, and reset requests.
- `models_analytics_event` rows with `source = 'inference'`: Gateway-produced model-call metadata and provider-reported usage.
- `models_analytics_settings`: Gateway collection consent and encrypted export credentials.
- Gateway response observation and consent-gated export to Langfuse.
- `workflow_run`: operational execution receipts and saved results used by Automations and artifact views, not an analytics-only table.

Gateway collection still requires its existing rollout capability, subscription, enabled Models service, and explicit versioned consent. Retiring the reporting screens does not grant consent or change those settings.

## Deployment

`0128_remove_legacy_analytics.sql` is a no-op (`SELECT 1`). Drizzle decides what to run by migration timestamp only, so databases that already applied it do not run it again. Bootstrap also checks every receipt's hash, so `ee/packages/den-db/scripts/superseded-migrations.ts` accepts the hash of the body released in v0.18.57.

`ee/packages/den-db/tests/analytics-retirement.test.ts` checks that the migration runs no destructive statement, runs it against disposable storage, and compares every retained table definition against the preceding schema snapshot.
