# Gateway-managed AWS runtime

- Feature key: `managedDeploymentAssistants` (unchanged)
- Label: Gateway-managed deployments
- Deployment: cloud only, off by default
- Owner: `benjaminshafii`
- Prerequisite: `managedDeployments`

New AWS managed installations include **Den, the native AI/model gateway, the
managed runner, Workbot and Slack/Automations**. These are included services, not
optional switches. Only cloud computers are optional, defaulting to **Off**;
Daytona is preferred when choosing a provider, with Freestyle also available.
This uses the existing native `ai_gateway_enabled` module and model gateway, not
OpenWork Web's den-gateway and not a new gateway implementation.

## New creates and historical views have different defaults

AWS targets accept `runtimeProfile: "legacy" | "gateway"` in their existing JSON.
There is no database migration.

- `awsTargetCreateSchema` preserves an omitted profile. Only
  `normalizeAwsTargetForCreate(input, { gatewayByDefault })` chooses the new-create
  default: **gateway when this caller's feature is on**, legacy otherwise.
- `awsTargetSchema` / `normalizeAwsTargetForView` always interpret a missing
  profile as **legacy**. Reading a historical record never upgrades or rewrites
  it. An explicit legacy create remains core-only for client compatibility.
- Gateway normalization sets `headlessRunnerEnabled`, `workbotEnabled` and
  `slackAssistantEnabled` to `true`, even if legacy clients sent `false`, and
  removes `modelProtocol`, `modelBaseUrl`, `model` and `modelSecretArn`.
- Old direct-model fields remain parseable on historical legacy views. They are
  not offered by the hosted form or used by the gateway profile. New legacy
  direct-model runtimes, changes to saved legacy assistant settings, and
  gateway-to-legacy downgrades are refused. Unchanged historical settings may
  Retry, reopen or receive an ordinary newer Update without profile adoption,
  behind the same authorization and feature checks.
- GCP retains its existing target, flow and qualification boundaries; it does
  not accept AWS runtime profiles or computer settings.

## Provider setup stays inside the installation

After first sign-in, the customer configures upstream model providers and their
credentials in **Models inside the installed Den**. Slack needs the customer's
own app and credentials in that installation's **Connectors**. The hosted form
has no model protocol, upstream endpoint, model ID or upstream-key input.

Included infrastructure does **not** mean models or Slack are configured or
ready to answer. Provider setup and Slack credentials remain required. This
feature does not change runtime authentication or gateway authorization scopes.
The operator's reviewed release pins all application images, including
`ghcr.io/different-ai/openwork-inference`; customers do not enter gateway image
or external-gateway overrides here.

## Optional computer settings

The AWS `assistants` object retains these computer options:

| Field | Values / requirement |
| --- | --- |
| `computerProvider` | `off` (default), `daytona` (preferred), or `freestyle` |
| `computerSecretArn` | Customer-created plain-string provider API key secret ARN; required only when a computer provider is selected |
| `computerSnapshot` | Computer snapshot ID, required only for Daytona |
| `daytonaApiUrl` | Optional credential-free HTTPS API URL; adapter/UI default `https://app.daytona.io/api` |
| `daytonaTarget` | Optional target; managed-installer adapter/UI default `us` |

The selected computer key secret must belong to the target AWS account and
region, using the complete Secrets Manager ARN with no JSON-field or version
selector. Plaintext keys and hosted OpenWork credentials are not accepted.
Hosted OpenWork receives the reference, never reads the key value, and cannot
prove an existing secret contains a plain string. The customer owns that secret;
ECS resolves the reference while starting the task. The installer does not read
the value. An unavailable or invalid credential fails task startup or the real
provider call instead of becoming successful installation evidence.

Daytona and Freestyle computers execute **outside the customer's AWS account**
and have separate provider billing. Off requires no computer account, key or
snapshot. The Daytona computer snapshot is distinct from an OpenWork Web image.
The shared Terraform module's own Daytona target currently defaults empty; the
managed installer deliberately supplies `us` without changing that module default.

## Explicit approved upgrades, never automatic adoption

`POST /v1/managed-deployments/:id/launch` accepts:

```json
{ "kind": "update", "runtimeProfile": "gateway" }
```

An optional `assistants` object selects computers. `runtimeProfile` and computer
changes are accepted only for AWS, only with a **version-increasing Update** and
only while the feature is enabled. Install/Retry cannot change them. Omitting
these fields on an existing legacy deployment keeps its old profile unchanged.

The deployment row is locked while checking features and atomically writing its
new target and run. A live approval/provisioning run freezes both profile and
settings. Changed pending input answers **409 `deployment_settings_frozen`**;
unchanged input reopens the identical run and handoff, including under concurrent
requests. There is no settings-only write. Superseded runs cannot enroll.

Gateway or explicitly selected profiles send `ManagedRuntimeProfile` with exactly
`legacy` or `gateway`. Untouched historical legacy targets omit that new
CloudFormation parameter, preserving older template compatibility. Gateway
handoffs force all included runtime booleans true and clear direct model endpoint,
model and key-ARN parameters; model protocol's historical template default is
unused by this profile. The gateway image comes only from the operator release.

MCP uses the same routes, permissions, normalization and locks.
`configuration.assistantsAvailable` reports whether this caller may configure
or approve the new runtime. Agent descriptions direct provider and Slack setup
to the installed Den, not a hosted credential prompt.

## Kill switch and health

Turning the feature off blocks new gateway-profile creation, upgrades, launches
and reopening, even when the profile is already stored. It never deletes or
stops customer services. Already issued commands remain customer-controlled.
Existing configuration, authentication, enrolled progress and signed health
reporting remain available. The UI preserves the configured runtime under a
lock and removes executable handoff links when its configuration poll sees the
kill switch.

`ai_gateway_available` is a critical health check: failure makes infrastructure
health **Down**; unknown/warning makes it **Degraded**. Existing runner, Workbot,
storage and backup checks retain their allowlisted labels. These checks are not
a claim that an upstream model provider or Slack app has been configured.

## Historical qualification failures — preserved

On 17 November 2026, an isolated test account used registry-verified OpenWork
`0.18.67` application digests and test-only installer versions **`0.18.71` →
`0.18.72`**. These are not production release coordinates. The overall
application qualification **failed**:

| Observation | Result |
| --- | --- |
| Managed CloudFormation/CodeBuild fresh core install | Passed: six real milestones and successful customer CodeBuild |
| IAM-approved Update adding runner, Workbot and EFS/Backup | Passed: four intended services completed; core-secret fingerprints unchanged |
| Workbot certificate expansion on the already-live install | Passed: one listener certificate cutover, both certificates issued, zero API/database/web failures across 370 HTTPS samples |
| EFS encryption and backup | Passed: encrypted EFS; an encrypted recovery point completed with the configured backup role/vault; daily seven-day plan verified |
| Customer model/computer keys in Terraform state | Passed: the actual external key values were absent from raw state |
| Workbot chat | Failed: real UI login succeeded, but Send returned HTTP 403 `gateway_not_configured`; no turn was accepted |
| Scheduled headless Automation | Failed: scheduled Cloud/headless dispatch returned `provider_unavailable` at model selection |
| Slack assistant and Freestyle command | NotRun: no successful model turn yet; Slack app setup also remains required |
| Further forced runner/core Update and post-Update behaviours | NotRun |
| Scheduled daily backup occurrence | Passed: the actual configured daily plan completed an encrypted recovery point using its configured role |
| Restore | NotRun |
| Gateway-profile `.74` approved Update | Failed: Terraform attempted to deregister the old runner task definition; scoped IAM correctly refused wildcard deregistration |
| Gateway-profile model checks | NotRun: the failed apply left the runner on its prior revision |

![Actual historical managed Workbot model-access failure, not a successful chat](./live-model-blocked.png)

These failures belong to the earlier legacy/direct configuration. The proposed
direct-model runtime change was **cancelled before implementation**: no runtime
PR or application images were created. The chosen architecture is now the
included Gateway profile, reusing existing runtime policy unchanged. Its first approved `.74` Update **failed** at old runner task-definition
retirement, despite all five services being present and Gateway HTTPS returning
200. Core-secret fingerprints remained unchanged; the certificate cutover had
zero failures across 139 core HTTPS samples. The runner was still on its prior
revision, so this is not a successful rollout or inference proof. Recovery must
retain old definitions declaratively rather than add wildcard deregistration
permission. New model checks remain **NotRun**; neither these failures nor the
historical ones are overwritten by local UI proof.

## Local UI proof and qualification boundary

The captures below are the real Den web/API in headless Chrome with throwaway
local MySQL and neutral fixtures. No AWS approval command was executed. A local
historical record was arranged to exercise the upgrade flow. These captures do
**not** certify a live AWS install, its authentication, model calls, Slack delivery,
automation execution, optional computers or restore. The main installer owners
retain those live gates for the exact reviewed release.

New creation defaults to included gateway runtime; only computers are optional.

![New Gateway runtime includes services; only computers are optional](https://litter.catbox.moe/v9bjw9.png)

Ephemeral review image (24-hour host); original retained privately.

A legacy deployment stays legacy until its owner explicitly includes the gateway
runtime in a newer, approved Update.

![Legacy installation requires an explicit Gateway upgrade](https://litter.catbox.moe/m2u3v0.png)

The prepared update freezes the chosen profile and computer settings.

![Gateway approval freezes the reviewed runtime and computer settings](https://litter.catbox.moe/6pwzjr.png)

Killing the feature preserves that profile but locks new approvals and hides its
command links without requiring a reload.

![Feature kill blocks new approvals without changing existing services](https://litter.catbox.moe/is3j9w.png)
