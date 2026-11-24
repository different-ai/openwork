# Deployment settings and capabilities

Everything that can be set on an OpenWork deployment is one of three kinds.
Each kind has one owner and one place.

| Kind | What it is | Who changes it | How |
| --- | --- | --- | --- |
| Infrastructure input | Where the deployment runs and how big it is: account or project, region, address, network, size | The customer's cloud admin | An approved run in their cloud. Each input is `fixed` or `editable` |
| Capability | What the deployment can do: Workbot, Slack assistant, Automations, AI Gateway, cloud computers | The customer's workspace admin | A switch. If the deployment lacks what the capability needs, turning it on is an approved run |
| Rollout flag | How OpenWork ships unfinished work | OpenWork | Never a customer step |

## The catalog

`packages/managed-deployments/src/capabilities.ts` is the source of truth. It
is data, and it is checked against the repository on every pull request.

For each capability it records a label, a one-sentence description, the
capabilities it requires, and for each way of installing OpenWork whether the
capability is supported and which controls implement it:

| Target | What it is | Controls are |
| --- | --- | --- |
| `managed-aws` | Installed from OpenWork Cloud into the customer's AWS account | Deployment settings and the Terraform root's variables |
| `managed-gcp` | Installed from OpenWork Cloud into the customer's Google Cloud project | Deployment settings and the Terraform root's variables |
| `helm` | The `openwork-ee` Helm chart | Values and `denApi.env` |
| `aws-ecs-module` | The `openwork-aws-ecs` Terraform module | Module variables |
| `gcp-cloud-run-module` | The `openwork-gcp-cloud-run` Terraform module | Module variables |

The headless runner is in the catalog as an internal dependency. Workbot, the
Slack assistant, cloud Automations and cloud computers need it, and nobody
turns it on by itself.

The catalog also classifies every managed-deployment setting
(`MANAGED_AWS_SETTINGS`, `MANAGED_GCP_SETTINGS`). An infrastructure setting is
`fixed` or `editable`. A capability setting names the capabilities it belongs
to and how it may change. The configuration change planner reads its rules
from these lists, so the page that edits a deployment and the catalog cannot
disagree.

## What the checks enforce

`pnpm check deployment-capabilities` runs the catalog's tests, and so does the
required check on every pull request.

- **Drift.** Each control must exist in the file the catalog names, with the
  default the catalog records. The test reads the Terraform roots and modules,
  the Helm chart's values and templates, the deployment schema and the lines
  of Den that decide an unset variable. A target recorded as unsupported must
  not mention the capability's variables.
- **Same default everywhere.** When a capability is on by default on one
  target and off on another, the difference must be a recorded gap.
- **No rollout flag as a customer step.** A capability may not depend on a
  feature flag in the customer's deployment unless the catalog records it as a
  gap. Flags that OpenWork turns on in OpenWork Cloud before offering a
  managed capability are listed separately and must be cloud-only.
- **Settings.** Every field of the deployment schema is classified, and the
  planner allows exactly the changes the catalog says.

Changing an installer, the chart or one of those Den defaults means changing
the catalog in the same pull request.

## Known gaps

The catalog records today's inconsistencies in each capability's `gaps` list
and a test pins them. Fixing one means removing it from the catalog.

| Capability | Gap |
| --- | --- |
| Automations | Four controls and three defaults. Helm renders both Den switches as true, the AWS ECS module sets one and defaults it to true, the Cloud Run module defaults it to false, and managed AWS fixes it to true |
| Automations | The Cloud Run module fixes `DEN_AUTOMATIONS_RUNTIME_ENABLED` to false, so `automations_enabled = true` turns nothing on. A managed Google Cloud deployment inherits that and has no input to change it |
| Slack assistant | With a runner installed, Helm leaves it on because nobody sets `DEN_SLACK_ASSISTANT_WORKER_ENABLED`. The AWS ECS module and a legacy managed AWS deployment set it to false until `slack_assistant_enabled` is turned on |
| AI Gateway | The Cloud Run module can install it, but the managed Google Cloud root never passes `ai_gateway_enabled` |
| Cloud computers | Choosing a provider is not enough. Members see no computer until the `remoteComputers` flag is on in the installed Den. `sandboxGateway` and `workbotProfileComputers` change where computers run and where they are listed. All three are off by default and no installer sets them |
| Runner, Workbot, Slack assistant, cloud computers | The Helm chart installs neither the runner nor Workbot. The operator runs them separately and passes their addresses to Den through `denApi.env` |

Managed Google Cloud supports none of the five capabilities yet, and its
settings cannot change after installation.

## Capability state

Den reports one state per capability.

| State | Meaning |
| --- | --- |
| `on` | Set up on this deployment |
| `off` | The deployment could run it, and a switch keeps it off |
| `needs_infrastructure` | Turning it on first installs something in the customer's cloud |
| `unsupported` | This kind of deployment cannot have it |

Each state comes with a fixed reason code, such as `switched_off`,
`service_not_installed`, `dependency_not_installed` or `rollout_flag_off`.

- **An installed Den** adds `deploymentCapabilities.capabilities` to
  `GET /v1/org`. It derives the states from settings it already has: whether
  the runner, Workbot and the gateway are configured, its own Automations and
  Slack switches, and the organization's features. It makes no network call
  for this. A Den does not know which installer made it, so it never reports
  `unsupported`. The existing `aiGateway` boolean is unchanged.
- **OpenWork Cloud** answers
  `GET /v1/managed-deployments/{deploymentId}/capabilities` for a managed
  deployment. It computes the states from the recorded target: the runtime
  profile, the assistant settings and the computer provider on AWS, and
  `unsupported` for everything on Google Cloud.

Capability state says whether something is set up. Whether its service answers
is the job of the service checks in [Diagnostics](../diagnostics.md) and of a
managed deployment's health report.

Two reasons deserve a note. A Den cannot see the runner's computer provider, so
cloud computers report `on` with `configured_on_runner` once the runner is
installed and `remoteComputers` is on. OpenWork Cloud cannot see an installed
Den's flags, so a managed deployment with a provider chosen reports `on` with
`needs_rollout_flag`.

No screen shows these states yet.
