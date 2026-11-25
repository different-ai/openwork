# Configured Workbot deployment entry

- Key: `workbotConfiguredEntry`
- Deployment: `self_hosted` only
- Default: off
- Author: `yomgui`

## Behavior

This deployment-wide feature changes only Den Web's unconfigured `/workbot`
entry. When the Web process is classified `DEN_DEPLOYMENT=self_hosted` and
Den's public deployment-feature response resolves this feature on, the entry
returns 404 rather than redirecting to hosted Workbot.

An explicit `DEN_WORKBOT_URL` always wins, including its path/query and the
existing organization forwarding behavior. Cloud, unknown and unset deployment
classifications keep the historical hosted fallback. Self-hosted installs also
keep that fallback unless this feature is explicitly on.

This is a server routing rule, not a new UI layout. It does not turn Workbot or
the runner on/off, interrupt turns, remove data, revoke grants or change schedules.
It is not a replacement for access controls or an offline security boundary.

## Configuration

For an operator-managed Helm install:

```yaml
config:
  deployment: self_hosted
  features:
    workbotConfiguredEntry: "true"
```

Keep that setting in the complete values file when disabling only Workbot or
both companions. The feature setting is independent of their workload switches.
The chart's existing feature mapping renders the operator lock; no custom
feature environment line is needed.

Den Web reads the canonical, public `GET /v1/features` response from its configured
`DEN_API_BASE`, without forwarding cookies or bearer tokens. The registry's
deployment availability, operator locks, deployment rollout and kill switch
remain authoritative. This public entry has no authenticated organization;
organization/member overrides do not control it. Use the operator lock or
deployment-wide rollout, not a per-organization override, to try it.

A missing key, invalid response, missing API base, non-success response or bounded
request failure is off and preserves the old hosted fallback. Because discovery
can fail or be cached upstream, this feature must not be treated as a hard
network-isolation guarantee. Configure an explicit manual destination if needed.
Both Den API and Web must contain this feature's implementation; older application
images do not acquire it merely from new chart values.

## Try and turn off

1. With no Workbot URL, verify the feature-off entry still redirects to hosted
   Workbot on an existing self-hosted install.
2. Turn the feature on for the self-hosted deployment and verify `/workbot`
   returns 404. Verify the same behavior after the Workbot workload is disabled.
3. Configure an explicit manual Workbot URL and verify it still redirects there.
4. Turn the feature off, reset its operator lock, or use the registry kill switch;
   the entry returns to the old hosted fallback when canonical discovery reports
   the feature off. Explicit URLs remain unchanged.

Watch HTTP status/Location on `/workbot` and Den API reachability; do not log
sign-in callback codes, cookies or token values. Tests cover default-off/manual/
Cloud boundaries, canonical discovery failure and registry kill/lock behavior.
Earlier companion lifecycle/member-turn verification does not prove this newly
gated route on the final revision; bind its route checks to that revision.
