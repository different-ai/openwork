# inference-sentry-debug — Diagnose inference requests in Sentry without leaking credentials

1. Every inference request shows the incoming model selection and the resolved upstream model, alongside organization ID, inference key ID, request ID, and sanitized headers. Unknown models record a null resolution.

2. For normal organizations, Sentry captures payload structure—model, streaming mode, message roles and counts, and tool metadata—but no prompt or message body.

3. For `org_01krnrcabhe8htwpbnsw0zk0bw`, Sentry captures the full parsed payload for deep debugging.

4. Credentials are always redacted, including authorization, API keys, cookies, provider keys, and token- or key-like fields—even for the debug organization.

5. Errors and upstream failures carry the same request context, making them searchable by organization, key, and request ID.
