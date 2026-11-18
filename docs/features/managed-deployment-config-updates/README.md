# Configuration changes for installed deployments

- Feature key: `managedDeploymentConfigUpdates`
- Label: Deployment configuration changes
- Deployment: cloud only, off by default
- Author: `benjaminshafii`
- Prerequisite: `managedDeployments`; `managedDeploymentAssistants` as well when
  the deployment has, or the change adds, the gateway runtime

An owner changes an installed AWS deployment's configuration without waiting
for a newer installer. Den prepares the change and returns one command for AWS
CloudShell, the same kind an Update gives. Nothing in the customer's account
changes until they run it, and Den records the new configuration only after
that run has verified health.

## What can change

| Field | What happens |
| --- | --- |
| Name | Saved at once. Nothing in AWS changes and there is no command. |
| First administrator email | Needs approval in AWS. The OpenWork API and web app restart. |
| Runtime profile, legacy to gateway | Needs approval in AWS. Adds the model gateway, managed runner, Workbot, Slack and Automations, file storage and daily backups. Only from the currently published installer. |
| Cloud computers (provider, key secret ARN, snapshot, Daytona API URL and target) | Needs approval in AWS. The managed runner restarts. Only when the resulting profile is gateway. |

The first administrator email decides who can complete first sign-in at
`/setup`, and who becomes owner when the installation has no active owner. An
administrator who has already signed in stays the administrator, and no email
is sent.

## What is fixed at installation

The address, AWS account, region, hosted zone and network cannot change: each
would replace or orphan the customer's data or identity. The gateway runtime
cannot be turned off, because removing it would delete the runner's files,
secrets and backups. A legacy deployment's own runner settings and model fields
are not editable here; turning on the gateway replaces them. Google Cloud
deployments cannot be edited after installation.

A request for any of these is refused by name before anything is prepared. The
installer in the customer's account also refuses a plan that deletes or
replaces data-bearing resources, whatever Den sent.

## The change re-runs the installed installer

A change is one installer run of kind `configure`. It is pinned to the
deployment's latest run that verified health (the base run): the same version,
template URL, bundle URL and bundle checksum, with a new run ID and challenge
and the requested parameters. The installer in the customer's account never
compared versions; a new run ID is what starts it. Den requires all of the
following, and locks editing otherwise:

| Lock | When | What the owner does |
| --- | --- | --- |
| `not_installed` | The deployment has never verified health. | Remove it and create it again with other values. |
| `run_in_progress` | An install, retry or update awaits approval, or any run is provisioning. | Finish it first. |
| `installer_unknown` | No run verified health, or its version is not the installed version. | Update the deployment. |
| `unfinished_run` | An install, retry or update was prepared after the base run, approved or not. Its command may have replaced the installer stack or part of the infrastructure, so the recorded configuration is no longer provably what is installed. | Finish it with Retry or Update. |
| `installer_unavailable` | The base run's template or bundle URL is not an immutable object version and is not the published release. | Update the deployment. |
| `aws_only` | The deployment is not on AWS. | Nothing; not supported. |

Turning on the gateway runtime also requires the base run to be the currently
published release (`gateway_needs_current_installer` otherwise), because older
installer templates do not have the runtime's parameters. Update can turn it
on in the same step as the newer installer.

The run reports to the API's current public origin, like Retry and Update.

## Requested and applied are separate

- Preparing a change writes the request to the run (`configuration_change`):
  who asked, the base run, the recorded and the requested email and target,
  and the list of changes. The deployment's `owner_email` and `target` are not
  touched.
- The command carries the requested values. A target that did not change is
  sent exactly as stored, so a historical record keeps omitting the runtime
  parameters its installer template does not have.
- The installer enrolls and reports its six milestones as for any run. When
  the sixth, `health_verified`, succeeds, the same transaction marks the run
  ready and copies the requested email and target onto the deployment. A
  failed milestone changes only the run.
- That transaction locks the deployment row and checks the run is still the
  active one, so a run replaced a moment earlier records nothing. This holds
  for install, retry and update runs as well.

After a failed change the deployment shows the failed run and its recorded
configuration is unchanged; AWS may be partly changed. The dashboard offers
"Review and try again" with the failed request. Retry on the launch route
still re-applies the recorded configuration at the published release.

## One change at a time

- The view's `configuration.revision` covers the name, email, target, active
  run and installed version. A request carries the revision it was read at; a
  different one answers `configuration_changed`.
- Asking again for the change that is awaiting approval returns the same run
  and command, whatever revision is sent, so a lost response can be resent.
- A different request replaces a change that has not reached AWS. The replaced
  run cannot enroll.
- Asking for the recorded configuration while a change awaits approval, or
  after its approval expired, withdraws it: the run is marked failed and the
  deployment shows the run it showed before. This is how a wrong or stuck
  handoff is discarded instead of blocking Update for three hours.
- A change that is provisioning cannot be replaced or withdrawn.

A replaced or withdrawn command, if run anyway, updates the installer stack's
parameters and starts the installer, which stops at enrollment. The deployment
is not touched, and the next real run sets every parameter again.

## Kill switch

| State when the feature goes off | What happens |
| --- | --- |
| No change in flight | The route answers 404 and views lose the `configuration` block. The dashboard is the screen without this feature. |
| Change prepared, command not run | The route answers 404, so the command cannot be reopened. If it is run anyway, the installer's enrollment is refused after its AWS identity is verified, the change is withdrawn, and the deployment shows its previous state. |
| Change provisioning | It finishes. At `health_verified` the configuration is recorded: the customer approved it and their infrastructure changed. |
| Change failed after reaching AWS | The failed run stays visible. Retry re-applies the recorded configuration at the published release. A half-added gateway runtime is completed by turning the feature back on, or by an Update that selects the gateway profile. |
| Change applied | It stays. |

Enrollment checks the feature for the organization and the person who asked
for the change. Turning `managedDeploymentAssistants` off blocks requests on a
gateway deployment and requests that add the gateway, including reopening one.
Turning `managedDeployments` off blocks the route; installer enrollment,
milestones and health reports keep working.

## API

`POST /v1/managed-deployments/:deploymentId/configuration-changes`, permission
`deployments.manage`. Not available to agents through MCP.

```json
{
  "expectedRevision": "<configuration.revision from the deployment view>",
  "configuration": { "provider": "aws", "name": "…", "domainName": "…", "ownerEmail": "…", "target": { "…": "…" } }
}
```

`configuration` is the complete document a create takes, so a fixed field that
differs is refused by name. An omitted `runtimeProfile` keeps the recorded one.
`planDeploymentConfigurationChange` in `@openwork/managed-deployments/configuration`
decides what is accepted and what each change does; the dashboard calls the
same function before sending.

Results (`outcome`):

- `saved`: only the name changed.
- `withdrawn`: the pending change was discarded.
- `approval_required`: `command` and `handoff` for AWS CloudShell, `expiresAt`
  (three hours) and `changes`. The shape is also a valid launch result.

Refusals are `{ error, message, field? }`; `message` is the sentence shown to
the person.

| Status | `error` |
| --- | --- |
| 400 | `field_not_editable`, `gateway_cannot_be_removed`, `computers_need_gateway`, `legacy_runtime_not_editable`, `invalid_configuration` (each with `field`), `configuration_aws_only`, `no_changes` |
| 403 | the permission refusal |
| 404 | `deployment_not_found` (also another organization's deployment), `feature_disabled` with `feature` |
| 409 | `not_installed`, `run_in_progress`, `unfinished_run`, `installer_unknown`, `installer_unavailable`, `gateway_needs_current_installer`, `configuration_changed` |
| 503 | `release_not_configured` |

With the feature on for the caller, each deployment in list, create and launch
responses carries `configuration`: `revision`, `lock` (null when editable),
`gatewayAvailable`, and `change` for a change that is awaiting approval,
applying, failed or expired. With it off the responses are unchanged and no
additional query runs.

## Audit

The route is a tenant change. Evidence is appended in the request's
transaction when a change is requested
(`managed_deployment.configuration_change_requested`, with the run ID,
installer version and the run it replaced), when the deployment is renamed
(`managed_deployment.renamed`), and when a change is withdrawn
(`managed_deployment.configuration_change_withdrawn`). Secret ARNs are
references, never secret values. Application is recorded on the run: its
request, its `ready` state and its timestamped milestones.

## Try it

1. In `/admin`, turn on `managedDeployments` and `managedDeploymentConfigUpdates`
   for an internal organization (and `managedDeploymentAssistants` to add the
   gateway runtime).
2. Open **Manage › Deployments** as an owner, choose an installed AWS
   deployment and **Edit configuration**.
3. Change the first administrator email, review, and prepare the AWS approval.
   The deployment still shows the old email.
4. Run the command in AWS CloudShell in the deployment's account. The six
   steps appear as they happen; after the last one the deployment shows the
   new email.

API behaviour is covered by
`ee/apps/den-api/test/api/managed-deployment-configuration.api.test.ts`, which
runs against a local database and never contacts AWS.

## Not yet proven

Adding the gateway runtime at the installed version has not been run against a
live AWS account. The template and module read as additive, but the added IAM
policy, the certificate expansion and the service rollouts have only been
exercised through a version-increasing Update. Run it in an isolated account
before enabling the feature for a customer who will add the gateway this way.
