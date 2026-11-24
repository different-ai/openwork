# Suspend an account's OpenWork-funded model access

A platform administrator can act on an explicit provider request to suspend an identified user's model access. The decision follows the OpenWork user across their current and future organizations, memberships and model keys. A provider warning still starts the existing case review. The operator decides whether the provider requested a broader account suspension.

## Operator actions

Confirm the provider request through a trusted channel. Verify the OpenWork user ID against the provider identifier or other trusted request evidence. Keep private correspondence and supporting evidence in the incident system. Use an opaque, unique provider reference in Den.

All actions below use a platform administrator's Den session and the path `/v1/admin/users/{userId}/funded-model-suspensions`.

| Action | Request |
| --- | --- |
| Inspect | GET the path. `suspended` reports whether any active suspension exists. `enforcementEnabled` reports the deployment setting. The response includes the 50 most recent decisions, reviewers, references and times. |
| Suspend | POST `{"reference":"C-example","verified":"provider_requested_account_suspension"}`. If a previously imported case has an identifier, it must match this account. The same reference can apply to one user. |
| Reinstate | Verify the provider authorized reinstatement. POST to the path plus `/release` with `{"reference":"C-example","releaseReference":"R-example","verified":"provider_authorized_reinstatement"}`. Independent suspensions, Free Auto deactivations and temporary pauses continue to apply. |

## Rollout and coverage

Apply the database migration, upgrade Den, its background workers, and every inference gateway instance, then turn on `fundedModelAccountSuspensions` deployment-wide. Records can be staged while the flag is off. Check both status fields after enabling. Requests already dispatched can finish.

- OpenWork Models checks the member behind the authenticated key before processing a funded request. This covers signed-in Free Auto Chat Completions and Responses and the subscription OpenRouter route, including Workbot, automations and headless clients that use these credentials.
- Smart Model Router checks before classification and forwarding, including its Cursor, Claude Code and Codex adapters. Sandbox gateways check the selected organization credential against the platform-provisioned credential set. For older sandboxes without a recorded set, a suspended account loses access to sandbox organization credentials. Sandbox credential probes also require an eligible account. Independently funded provider routes outside these cases retain their ordinary access policy.
- Workbot checks before obtaining managed model access and before each platform-funded background evaluation. Older headless turn grants requesting an unscoped credential refresh are checked before renewal.
- Signed-out Free Auto remains available. A proof-capable installed desktop presents its installation proof even where signed-out clients are optional. The gateway derives the existing pseudonymous installation identifier using its accounting identity key. The identifier persists across sessions and network changes while the installation identity and server key stay stable. Keep the server key stable across replicas. A shared computer can represent several people. The existing Free Auto case workflow can restrict that specific identifier separately after review.
- Clients without usable proof use the existing signed-out fallback only where the desktop policy permits it. Keep signed-out access, including the possibility of access after sign-out, in mind when responding to a provider. A request to disable the entire OpenWork login or terminate a session needs separate account action.

The model suspension requires an operator's explicit decision. A local Free Auto appeal cannot release it.

Hosted headless deployments should route member turns through Den-issued, member-scoped gateway credentials. Before enabling enforcement, retire any shared `HEADLESS_MODEL_API_KEY` used for legacy member jobs and drain already admitted unscoped turns. A private runner called directly with an operator key has no authenticated OpenWork account to check.
