# Gateway analytics preservation

Organization Analytics, Usage & adoption, Models & usage, and Workflow Runs reporting have been retired. Usage reporting lives in AI Gateway.

Desktop adoption pings, task/tool/skill metadata collection, and their ingestion APIs are removed. `0128_remove_legacy_analytics.sql` drops `telemetry_event` and `telemetry_session_dimension` and deletes only `source = 'app'` rows from `models_analytics_event`.

## Data that must stay

- AI Gateway request logs, usage rollups, token/cost accounting, billing ledgers, limits, and reset requests.
- `models_analytics_event` rows with `source = 'inference'`: Gateway-produced model-call metadata and provider-reported usage.
- `models_analytics_settings`: Gateway collection consent and encrypted export credentials.
- Gateway response observation and consent-gated export to Langfuse.
- `workflow_run`: operational execution receipts and saved results used by Automations and artifact views, not an analytics-only table.

Gateway collection still requires its existing rollout capability, subscription, enabled Models service, and explicit versioned consent. Retiring the reporting screens does not grant consent or change those settings.

## Deployment

Deploy the application that removes the legacy readers and writers before applying the destructive migration. The migration is irreversible for retired app analytics; it does not delete Gateway inference history or Workflow results. No live database is changed by preparing this migration.

`ee/packages/den-db/tests/analytics-retirement.test.ts` checks the exact destructive statements, runs them against disposable storage, and compares every retained table definition against the preceding schema snapshot.
