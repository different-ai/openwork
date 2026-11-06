# Headless legacy providers

- **Feature:** `headlessLegacyProviders`
- **Deployments:** Cloud and self-hosted
- **Default:** off
- **Owner:** benjaminshafii

## What changes

When enabled for an organization, Workbot settings, Slack setup and headless Automations can use supported legacy LLM providers through Den's member-scoped model resolver. The resolver requires active membership, a current provider grant, an allowed model and the executing member's active credential. It never substitutes an administrator or deployment key.

The headless runner supports single-key OpenAI-compatible Chat Completions, OpenAI Responses and Anthropic Messages. Signing, multi-env credentials, custom headers/options and model-specific route overrides remain unsupported. Desktop legacy-provider behavior is unchanged by this feature.

## Rollout and verification

Enable only for a test organization in `/admin` → Organizations → Features. The normal registry machinery also provides member overrides, deployment-wide rollout, a kill switch, and self-hosted operator locks. No production override is enabled by this PR.

1. Provision a legacy per-member model and grant a test member access.
2. With the feature off, confirm the model is absent from Workbot's catalog and cannot mint a turn or resume credential.
3. Enable it for that organization. Save its model as the Workbot default and run a message as the granted member. Slack resolves the invoking member's binding; headless Automations resolve their owner's binding.
4. Block the member's binding or remove the grant. New turns and resumes must fail without another upstream request.
5. Disable the feature. The model disappears from pickers, and new legacy turns/resumes fail even if a saved default or resume grant still names it. Previously completed history remains readable. Re-enable to restore eligible models; access is checked again.

The integration test `ee/apps/den-api/test/api/legacy-headless-live.api.test.ts` covers default-off, enablement, disablement after successful execution, Workbot token denial, Slack send denial, resume denial, preserved history, re-enablement and credential/grant revocation. The example headless world enables only its own isolated test organization.

## Safe to turn off

Catalog and access share the same feature check, before reading upstream credentials. This includes readiness, minting and resume exchange. Disabling this rollout does not alter existing AI Gateway access, desktop providers, saved model choices or conversations. It does not migrate a saved legacy selection to another model.

The switch prevents new admission/resume; it cannot cancel upstream requests already in flight or immediately remove a credential already held by a running step. Revoke the upstream token for immediate credential cutoff.

## What to watch

Watch stable model-access-denied/run failure codes, Workbot default-model diagnostics and headless turn error rates. Successful legacy credential resolution records feature usage for the executing member; listing a catalog alone does not count as usage. Never log upstream credentials or raw provider errors. Enabling the feature does not add OpenWork AI Gateway metering to direct upstream routes.
