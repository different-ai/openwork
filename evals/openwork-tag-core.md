# OpenWork Tag core proof

An internal, deterministic proof for the Den-owned Slack Tag integration.

## Scenario

1. Verify the Slack trust boundary: HMAC and replay checks, durable dedupe,
   OAuth authorization/exchange rules, mention/command normalization, Web API
   identity and channel checks, rate limiting, and safe response truncation.
2. Send a signed Slack mention through the actual Den webhook route into the
   OpenWork worker HTTP contract. Continue without a mention in the same Slack
   thread and prove that the same OpenCode session is reused.
3. Start a long-running request and send `cancel` while it is running. Prove
   that the control event completes immediately, the OpenCode abort endpoint is
   called, and Den records the run/thread as cancelled.
4. Revoke the managed Slack installation and prove that Den fails closed,
   clears usable credentials, and disables execution.
5. Verify that the Den admin UI contains managed OAuth install, manual fallback,
   policy, immutable snapshot, credential-boundary, and run-history surfaces.

## Expected outcome

All contract and MySQL-backed integration tests pass. The browser-facing source
contains stable proof selectors and the OAuth, security, and run-history
explanations used by the rendered dialog.
