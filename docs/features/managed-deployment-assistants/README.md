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

An optional `assistants` object selects computers. On the launch route,
`runtimeProfile` and computer changes are accepted only for AWS, only with a
**version-increasing Update** and only while the feature is enabled.
Install/Retry cannot change them. Omitting these fields on an existing legacy
deployment keeps its old profile unchanged. With `managedDeploymentConfigUpdates`
on, the same changes can also be requested at the installed version through a
separate route and the same customer approval; see
[managed-deployment-config-updates](../managed-deployment-config-updates/README.md).

The deployment row is locked while checking features and atomically writing its
new target and run. A live approval/provisioning run freezes both profile and
settings. Changed pending input answers **409 `deployment_settings_frozen`**;
unchanged input reopens the identical run and handoff, including under concurrent
requests. Launch has no settings-only write. Superseded runs cannot enroll.

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

On 17 November 2026 UTC (16–17 November Pacific time), an isolated test account used registry-verified OpenWork
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
| Further `.77` forced runner/core Update | Passed: real matching CodeBuild/six milestones and intended revisions; core secrets/EFS preserved; issued certificate unchanged with zero failures across 296 core HTTPS samples |
| Post-Update product rechecks | Passed: fresh same-chat history/continuation 43, real scheduled headless run, and new independently verified Freestyle bash/exit 0 on the same provider VM; Slack remains NotRun |
| Scheduled daily backup occurrence | Passed: the actual configured daily plan completed an encrypted recovery point using its configured role |
| Restore | NotRun |
| Gateway-profile `.74` approved Update | Failed: Terraform attempted to deregister the old runner task definition; scoped IAM correctly refused wildcard deregistration |
| Gateway-profile `.76` recovery Update | Passed: real matching CodeBuild/six milestones; all five intended revisions and running image digests independently verified; no global runner upstream key |
| `.76` certificate preservation | Passed: one issued certificate preserved; zero failures across 257 core HTTPS samples |
| Owner-scoped Gateway native completion | Passed: normal encrypted provider workflow and owner-only grant; actual bounded completion reported the selected upstream model, with matching Gateway usage |
| Gateway Workbot chat | Passed: real browser Send HTTP 202, matching completed turn/model step and rendered nonce answer 42 |
| Gateway scheduled headless Automation | Passed: scheduled cloud/headless engine, linked execution thread, nonce/42, nonzero model usage and successful terminal event; fresh public read confirmed |
| Freestyle command | Initial turn failed because the account lacked the pinned release's prepared snapshot. After normal test-owner computer opt-in and exact source-matched snapshot setup, a fresh UI command passed with authenticated raw bash/exit-0 evidence and actual provider VM identity; original failure retained |
| Slack assistant thread | NotRun: developer sign-in/app setup still required |

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
permission. The `.76` recovery has since completed the actual managed rollout
with retained-definition adoption and no IAM broadening. Its normal owner-only
Gateway setup/native completion passed, followed by real Workbot, scheduled
headless Automation and Freestyle command proof. Those three flows passed again
after the real `.77` Update. The full profile remains **unqualified pending Slack
thread proof**: developer sign-in/app setup never completed. Neither failed run
is overwritten by recovery or local UI proof. Cleanup/independent absence is
recorded separately; a completed model turn is not a teardown receipt.

## Real managed runtime evidence

These are the actual isolated AWS installation, not local UI fixtures. Screenshots
illustrate the UI; structured HTTP/turn, scheduler, raw tool and provider identity
receipts independently decide the results. Originals and redacted structured
receipts are retained privately; review images below use a 24-hour host.

![Actual Gateway Workbot chat: accepted turn and nonce answer 42](https://litter.catbox.moe/hat5gj.png)

![Original computer failure preserved beside a fresh successful command](https://litter.catbox.moe/29k388.png)

![Fresh post-Update history and same-chat continuation 43](https://litter.catbox.moe/roeciv.png)

![New post-Update computer command; exit and VM identity verified independently](https://litter.catbox.moe/19igf1.png)

The computer proof requires a matching authenticated owner/session-bound raw
runner tool call/result, adapter-generated exit 0, and the actual provider VM's
identity/metadata—not the model's description. The same VM was independently
observed after the Update. Identity correlation uses the runtime's stable session
slug; no provider per-command execution receipt is claimed. Computer permission
was enabled through the installed Den's normal operator controls for only the
synthetic owner, with no kill-switch, lock or Gateway-authorization bypass.

## Recorded scoped teardown

Normal Terraform destroy completed after applying only the reviewed supported
same-ID disposable-test database settings. No migration, source guard, state or
IAM bypass was applied. Retained resources were reconciled separately against
frozen exact identities; empty Terraform state alone did not count as absence.

The cloud audit covers 114 original references and 29 residual checks, plus 22
independent high-level checks. No remaining active/chargeable owned resources or
unknown findings were observed in that scope. Both owned recovery points and
vault, five AWS secrets, eight managed DNS records, three historical certificates,
all owned compute/data/network/IAM/log/bootstrap resources, and both buckets were
removed. The public bucket's 27 versions and the retained state bucket's 61
versions/18 markers were purged only after Terraform finished. The shared root
zone, original upstream/Infisical keys, stock computer snapshot, global roles and
AWS-managed keys were excluded and preserved.

The owned Freestyle VM, private prepared snapshot and builder each had provider
absence verified. Separate local receipts verify the owned API/controller,
Redis/tunnel/browser and recorded UI-test processes stopped, the exact test
MySQL container/volume removed, and known ports closed. Ten synthetic local
credential/control files were removed without logging their values; original
SSO/Infisical/upstream keys and other user processes were left untouched.
Neutral proof records, screenshots and manifests remain preserved.

AWS can retain terminal history: last observation showed 18 task-definition
revisions in `DELETE_IN_PROGRESS`, zero `ACTIVE`; inactive cluster/service,
stopped-task, deleted-NAT and deleted-stack history may remain. This is not a
claim of total metadata erasure, account-wide absence, zero cost or a final bill.
The original denied vault Describe was not treated as absence: a separate
successful paginated exact-name vault list established it. All failed attempts
and original proof hashes remain preserved.

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
