# Cloud-agent model access

Cloud agents should compose the same AI Gateway access primitives as the signed-in app. An organization model default is a selection, not an inference permission.

## One access boundary

`ee/apps/den-api/src/workbot/gateway-model.ts` projects the existing member-facing `gatewaySummary(..., false)` into the headless runner's supported model catalog. It reuses:

- Live organization membership and Gateway group/credential-set grants.
- Gateway's credential-readiness projection and first-use issued-key provisioning.
- Exact Gateway model aliases, including their credential-set selection.
- The existing member Gateway bearer-key issuer and trusted Gateway URL builder.

It never decrypts or sends upstream provider credentials to a runner. No organization-wide super-key, shadow provider registry, or second access policy is introduced. The catalog is read fresh for the actual actor; it is never stored in the deployment-wide runner catalog cache.

Workbot settings, new Workbot turns, Slack turns, headless Automations and the bounded diagnostic probe use this boundary. Automations that already run on a member's Web computer keep that runtime.

## Selection and execution

Settings store the exact Gateway alias in the existing organization model preference. A member can execute it only while their own Gateway assignment and required credentials are usable. Selecting an organization default does not share an administrator's identity or personal credentials.

The initial runner integration supports its existing Anthropic Messages, OpenAI Chat Completions and OpenAI Responses adapters. Other protocol families, and providers needing request options those adapters do not implement (including Azure and Mistral), are not offered as runnable models. The automatic Luna choice requires one unambiguous supported alias for upstream `gpt-6-luna`; a display name alone cannot select a provider or credential set.

The trusted server-to-server turn credential envelope carries `modelAccess` (Gateway base URL, protocol and member Gateway bearer key). It does not belong in browser session metadata, transcripts, model prompts, logs or durable turn storage. The runner uses the selected route and model for both answers and automatic titles. A credential-ready catalog is not evidence of a successful paid completion; the diagnostic probe remains separate.

## Recovery

Every cloud-agent turn on cloud and self-hosted deployments gets its model through the AI Gateway; the runner needs the matching protocol support, and old runners reject the strict credential fields rather than silently use deployment credentials.

Scoped turns persist only a nonsecret `modelAccessRequired` marker and their selected model. The existing resume grant binds recovery to the original organization, user, session and message. Its authenticated exchange rechecks current Gateway access for that model and rehydrates credentials in memory, including background tasks and reports. Missing or revoked access must stop recovery, never select the deployment key.
