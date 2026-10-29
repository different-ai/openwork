# AI Gateway: keep spend limits when removing a provider

- **Feature key:** `gatewayProviderRemovalLimits`
- **Deployments:** OpenWork Cloud and self-hosted
- **Author:** [benjaminshafii](https://github.com/benjaminshafii)

A spend limit can be scoped to one AI Gateway provider. Before this feature,
removing that provider left the limit active but pointing at nothing: it capped
no requests, and the provider that replaced it had no cap.

With the feature on for an organization:

- **Removing a provider** (AI Gateway › AI Providers › a provider › Remove)
  lists the spend limits on it and asks what happens to them: move them to
  another active provider of the organization, or delete them too. The default
  is moving to the first other active provider.

  ![Remove provider dialog with one spend limit](remove-provider-dialog.png)

- **Limits whose provider was already removed** (before the feature, or while
  it was off) show **Provider removed** and **Not applied** on the Limits page,
  with **Choose provider** opening the limit editor, which explains it and lets
  the admin pick a live provider.

  ![A limit whose provider was removed](provider-removed-row.png)

## API

`DELETE /v1/inference-providers/{id}` accepts `usageLimits=move` with
`moveUsageLimitsTo=<provider id>`, or `usageLimits=archive`. With the feature on
and active limits on the provider, a request without a choice changes nothing
and returns `409 provider_has_usage_limits` with the limits (name, amounts).
Moving to a provider of another organization is `404
usage_limit_provider_not_found`; to the same or a turned-off provider, `400` or
`409`. Moving or archiving bumps each limit's revision (pending increase
requests on those limits expire, as for an edit) and writes a gateway usage
audit row (`policy_provider_moved` or `policy_archived` with
`reason: "provider_removed"`). It needs only Manage Gateway providers.

`GET /v1/gateway/usage-limit-policies` returns `providerStatus`
(`available`, `removed`, or null for default limits) whether or not the feature
is on.

## Turning it off

The delete route behaves exactly as before the feature: it ignores `usageLimits`
and leaves limits on the removed provider as they are. The dialog no longer
lists limits and the Limits page shows the old provider label. Limits already
moved or archived stay as they are.

## How to try it

Turn the feature on for a test organization, add two providers, create a limit
on one of them and remove that provider. `evals/proofs/provider-removal-limits.proof.test.ts`
walks through both screens.
