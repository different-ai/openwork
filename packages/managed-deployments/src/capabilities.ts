import type { AwsAssistants, DeploymentConfigurationField } from "@openwork/managed-deployments/schema"

/** Every way OpenWork is installed in a customer's cloud. */
export const DEPLOYMENT_TARGETS = ["managed-aws", "managed-gcp", "helm", "aws-ecs-module", "gcp-cloud-run-module"] as const
export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number]
export type ManagedDeploymentTarget = Extract<DeploymentTarget, "managed-aws" | "managed-gcp">

/** What a workspace admin turns on. */
export const CUSTOMER_CAPABILITY_IDS = ["workbot", "slackAssistant", "automations", "aiGateway", "cloudComputers"] as const
/** Installed because a customer capability needs it; never offered on its own. */
export const INTERNAL_CAPABILITY_IDS = ["headlessRunner"] as const
export const CAPABILITY_IDS = [...CUSTOMER_CAPABILITY_IDS, ...INTERNAL_CAPABILITY_IDS] as const
export type CustomerCapabilityId = (typeof CUSTOMER_CAPABILITY_IDS)[number]
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** `null` is "not set". */
export type ControlValue = string | boolean | null
/** Which value of a switch means the capability is on. */
export type ControlOn = { is: ControlValue } | { isNot: ControlValue }

type Switch = { default: ControlValue; on: ControlOn }
type Input = { default?: undefined; on?: undefined }

/**
 * One place a capability is implemented. A control with `on` decides whether the capability is on;
 * one without it is an input the capability needs (an address, a secret reference).
 */
export type CapabilityControl =
  | ({ kind: "installer-input"; file: string; name: string } & (Switch | Input))
  | ({ kind: "terraform-variable"; file: string; name: string; attribute?: string } & (Switch | Input))
  | ({ kind: "terraform-value"; file: string; name: string; value: string } & (Switch | Input))
  | ({ kind: "helm-value"; file: string; name: string } & (Switch | Input))
  | ({ kind: "helm-env"; file: string; name: string; env: string; readIn: string } & (Switch | Input))
  | ({ kind: "runner-env"; file: string; name: string } & Switch)
  | { kind: "rollout-flag"; file: string; name: string; default: boolean; on: ControlOn; effect: "required" | "optional"; summary: string }

/** What Den does with an environment switch nobody set. `evidence` is the code that decides it, compared ignoring whitespace. */
export type DenEnvironmentDefault = { name: string; whenUnset: "on" | "off"; readIn: string; evidence: string }

export type CapabilityGapKind = "default_mismatch" | "dead_control" | "rollout_flag" | "not_installed" | "not_offered"
/** A known inconsistency. Tests pin every gap, so a fix has to remove it here too. */
export type CapabilityGap = { kind: CapabilityGapKind; targets: readonly DeploymentTarget[]; flags?: readonly string[]; summary: string }

/**
 * `default` is the state after an install with defaults, with the capabilities this one requires already on.
 * `absent` (unsupported, no controls) names what must not appear in the target's files.
 * `hostedRollout` lists flags OpenWork turns on per organization in OpenWork Cloud before offering this; they are never set in the customer's deployment.
 */
export type CapabilityTarget = {
  support: "supported" | "unsupported"
  default: "on" | "off"
  controls: readonly CapabilityControl[]
  absent?: readonly string[]
  hostedRollout?: readonly string[]
}

export type Capability = {
  id: CapabilityId
  audience: "customer" | "internal"
  label: string
  description: string
  requires: readonly CapabilityId[]
  den: readonly DenEnvironmentDefault[]
  targets: Record<DeploymentTarget, CapabilityTarget>
  gaps: readonly CapabilityGap[]
}

const FILES = {
  schema: "packages/managed-deployments/src/schema.ts",
  managedAwsMain: "infra/managed-deployments/aws/terraform/main.tf",
  managedAwsAssistants: "infra/managed-deployments/aws/terraform/assistants.tf",
  managedAwsProfile: "infra/managed-deployments/aws/terraform/runtime-profile.tf",
  managedGcpMain: "infra/managed-deployments/gcp/terraform/main.tf",
  awsEcsVariables: "infra/terraform/modules/openwork-aws-ecs/variables.tf",
  awsEcsMain: "infra/terraform/modules/openwork-aws-ecs/main.tf",
  awsEcsHeadless: "infra/terraform/modules/openwork-aws-ecs/headless.tf",
  awsEcsGateway: "infra/terraform/modules/openwork-aws-ecs/ai-gateway.tf",
  gcpRunVariables: "infra/terraform/modules/openwork-gcp-cloud-run/variables.tf",
  gcpRunMain: "infra/terraform/modules/openwork-gcp-cloud-run/main.tf",
  gcpRunServices: "infra/terraform/modules/openwork-gcp-cloud-run/cloudrun.tf",
  gcpRunGateway: "infra/terraform/modules/openwork-gcp-cloud-run/ai-gateway.tf",
  helmValues: "packaging/helm/openwork-ee/values.yaml",
  helmConfigMap: "packaging/helm/openwork-ee/templates/configmap.yaml",
  helmDenApi: "packaging/helm/openwork-ee/templates/den-api.yaml",
  helmGateway: "packaging/helm/openwork-ee/templates/_gateway.tpl",
  denEnv: "ee/apps/den-api/src/env.ts",
  denReadiness: "ee/apps/den-api/src/service-readiness.ts",
  denSlackWorker: "ee/apps/den-api/src/slack-assistant/worker.ts",
  gatewayEnv: "ee/packages/utils/src/gateway-env.ts",
  runnerClient: "ee/packages/headless-protocol/src/client.ts",
  runnerConfig: "ee/apps/headless-runner/src/config.ts",
} as const

/** The files that define each target. A drift test reads them. */
export const DEPLOYMENT_TARGET_FILES: Record<DeploymentTarget, readonly string[]> = {
  "managed-aws": [FILES.managedAwsMain, FILES.managedAwsAssistants, FILES.managedAwsProfile],
  "managed-gcp": [FILES.managedGcpMain],
  helm: [FILES.helmValues, FILES.helmConfigMap, FILES.helmDenApi, FILES.helmGateway],
  "aws-ecs-module": [FILES.awsEcsVariables, FILES.awsEcsMain, FILES.awsEcsHeadless, FILES.awsEcsGateway],
  "gcp-cloud-run-module": [FILES.gcpRunVariables, FILES.gcpRunMain, FILES.gcpRunServices, FILES.gcpRunGateway],
}

const TRUE: ControlOn = { is: true }
const SET: ControlOn = { isNot: null }
const GATEWAY: ControlOn = { is: "gateway" }

const unsupported = (absent: readonly string[]): CapabilityTarget => ({ support: "unsupported", default: "off", controls: [], absent })

const runtimeProfile: readonly CapabilityControl[] = [
  { kind: "installer-input", file: FILES.schema, name: "target.runtimeProfile", default: "legacy", on: GATEWAY },
  { kind: "terraform-variable", file: FILES.managedAwsProfile, name: "managed_runtime_profile", default: "legacy", on: GATEWAY },
]
const GATEWAY_PROFILE_ROLLOUT = ["managedDeploymentAssistants"] as const

const helmEnv = (env: string, readIn: string, behavior?: Switch): CapabilityControl => {
  const control = { kind: "helm-env", file: FILES.helmValues, name: "denApi.env", env, readIn } as const
  return behavior ? { ...control, ...behavior } : control
}
const flag = (name: string, file: string, effect: "required" | "optional", summary: string): CapabilityControl => ({
  kind: "rollout-flag", file: `packages/features/src/flags/${file}.ts`, name, default: false, on: TRUE, effect, summary,
})

const COMPUTER_FLAGS: readonly CapabilityControl[] = [
  flag("remoteComputers", "remote-computers", "required", "Workbot shows no computer, browser or live view until this is on."),
  flag("sandboxGateway", "sandbox-gateway", "optional", "Runs computers through the runner's sandbox gateway instead of the runner's own Daytona or Freestyle account."),
  flag("workbotProfileComputers", "workbot-profile-computers", "optional", "Lists a member's computers in Workbot's profile."),
]

const NOT_IN_CHART = "The Helm chart does not install the headless runner or Workbot. The operator runs them separately and passes their addresses to Den as raw environment variables through denApi.env."

const headlessRunner: Capability = {
  id: "headlessRunner",
  audience: "internal",
  label: "Headless runner",
  description: "The private service that runs agent turns for Workbot, Slack replies and cloud Automations.",
  requires: [],
  den: [{ name: "DEN_HEADLESS_RUNNER_URL", whenUnset: "off", readIn: FILES.runnerClient, evidence: "const url = env.DEN_HEADLESS_RUNNER_URL?.trim()" }],
  targets: {
    "managed-aws": {
      support: "supported", default: "off", hostedRollout: GATEWAY_PROFILE_ROLLOUT,
      controls: [
        ...runtimeProfile,
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.headlessRunnerEnabled", default: false, on: TRUE },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "headless_runner", attribute: "enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.managedAwsMain, name: "headless_runner", value: "local.managed_headless_runner" },
      ],
    },
    "managed-gcp": unsupported(["headless_runner", "DEN_HEADLESS_RUNNER_URL"]),
    helm: {
      support: "supported", default: "off",
      controls: [
        helmEnv("DEN_HEADLESS_RUNNER_URL", FILES.runnerClient, { default: null, on: SET }),
        helmEnv("DEN_HEADLESS_RUNNER_TOKEN", FILES.runnerClient),
      ],
    },
    "aws-ecs-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "headless_runner", attribute: "enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.awsEcsMain, name: "DEN_HEADLESS_RUNNER_URL", value: 'local.runner_enabled ? local.runner_url : ""' },
      ],
    },
    "gcp-cloud-run-module": unsupported(["headless_runner", "DEN_HEADLESS_RUNNER_URL"]),
  },
  gaps: [{ kind: "not_installed", targets: ["helm"], summary: NOT_IN_CHART }],
}

const workbot: Capability = {
  id: "workbot",
  audience: "customer",
  label: "Workbot",
  description: "A chat app in the browser where members ask an agent to do work for them.",
  requires: ["headlessRunner"],
  den: [{ name: "DEN_WORKBOT_URL", whenUnset: "off", readIn: FILES.denReadiness, evidence: 'if (!source.DEN_WORKBOT_URL?.trim()) return fact("not_configured", "not_configured", false)' }],
  targets: {
    "managed-aws": {
      support: "supported", default: "off", hostedRollout: GATEWAY_PROFILE_ROLLOUT,
      controls: [
        ...runtimeProfile,
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.workbotEnabled", default: false, on: TRUE },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "workbot", attribute: "enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.managedAwsMain, name: "workbot", value: "local.managed_workbot" },
      ],
    },
    "managed-gcp": unsupported(["workbot", "DEN_WORKBOT_URL"]),
    helm: { support: "supported", default: "off", controls: [helmEnv("DEN_WORKBOT_URL", FILES.denReadiness, { default: null, on: SET })] },
    "aws-ecs-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "workbot", attribute: "enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.awsEcsMain, name: "DEN_WORKBOT_URL", value: 'local.workbot_enabled ? local.workbot_url : ""' },
      ],
    },
    "gcp-cloud-run-module": unsupported(["workbot", "DEN_WORKBOT_URL"]),
  },
  gaps: [{ kind: "not_installed", targets: ["helm"], summary: NOT_IN_CHART }],
}

const slackAssistant: Capability = {
  id: "slackAssistant",
  audience: "customer",
  label: "Slack assistant",
  description: "Members mention OpenWork in Slack and get the answer in the thread.",
  requires: ["headlessRunner"],
  den: [{ name: "DEN_SLACK_ASSISTANT_WORKER_ENABLED", whenUnset: "on", readIn: FILES.denSlackWorker, evidence: 'if (process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED === "false") return async () => {}' }],
  targets: {
    "managed-aws": {
      support: "supported", default: "off", hostedRollout: GATEWAY_PROFILE_ROLLOUT,
      controls: [
        ...runtimeProfile,
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.slackAssistantEnabled", default: false, on: TRUE },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "slack_assistant_enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.managedAwsMain, name: "slack_assistant_enabled", value: "local.managed_slack_assistant_enabled" },
      ],
    },
    "managed-gcp": unsupported(["slack_assistant_enabled", "DEN_SLACK_ASSISTANT_WORKER_ENABLED"]),
    helm: { support: "supported", default: "on", controls: [helmEnv("DEN_SLACK_ASSISTANT_WORKER_ENABLED", FILES.denSlackWorker, { default: null, on: { isNot: "false" } })] },
    "aws-ecs-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "slack_assistant_enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.awsEcsMain, name: "DEN_SLACK_ASSISTANT_WORKER_ENABLED", value: 'local.runner_enabled ? local.bool[var.slack_assistant_enabled] : ""' },
      ],
    },
    "gcp-cloud-run-module": unsupported(["slack_assistant_enabled", "DEN_SLACK_ASSISTANT_WORKER_ENABLED"]),
  },
  gaps: [
    {
      kind: "default_mismatch", targets: ["aws-ecs-module", "managed-aws"],
      summary: "With a runner installed, Helm leaves the Slack assistant on because nobody sets DEN_SLACK_ASSISTANT_WORKER_ENABLED, while the AWS ECS module and a legacy managed AWS deployment set it to false until slack_assistant_enabled is turned on.",
    },
    { kind: "not_installed", targets: ["helm"], summary: NOT_IN_CHART },
  ],
}

const automations: Capability = {
  id: "automations",
  audience: "customer",
  label: "Automations",
  description: "Members schedule work that runs on their desktop, or in the cloud when the headless runner is installed.",
  requires: [],
  den: [
    { name: "DEN_AUTOMATIONS_ENABLED", whenUnset: "on", readIn: FILES.denEnv, evidence: '&& parseBooleanFlag(parsed.DEN_AUTOMATIONS_ENABLED ?? "true")' },
    { name: "DEN_AUTOMATIONS_RUNTIME_ENABLED", whenUnset: "on", readIn: FILES.denEnv, evidence: 'parsed.DEN_AUTOMATIONS_RUNTIME_ENABLED ?? parsed.DEN_AUTOMATIONS_ENABLED ?? "true"' },
  ],
  targets: {
    "managed-aws": {
      support: "supported", default: "on",
      controls: [{ kind: "terraform-value", file: FILES.managedAwsMain, name: "automations_enabled", value: "true", default: true, on: TRUE }],
    },
    "managed-gcp": unsupported(["automations_enabled", "DEN_AUTOMATIONS_ENABLED"]),
    helm: {
      support: "supported", default: "on",
      controls: [
        { kind: "helm-value", file: FILES.helmValues, name: "config.public.automationsEnabled", default: "true", on: { is: "true" } },
        { kind: "helm-value", file: FILES.helmValues, name: "config.public.automationsRuntimeEnabled", default: "true", on: { is: "true" } },
      ],
    },
    "aws-ecs-module": {
      support: "supported", default: "on",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "automations_enabled", default: true, on: TRUE },
        { kind: "terraform-value", file: FILES.awsEcsMain, name: "DEN_AUTOMATIONS_ENABLED", value: "local.bool[var.automations_enabled]" },
      ],
    },
    "gcp-cloud-run-module": {
      support: "unsupported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.gcpRunVariables, name: "automations_enabled", default: false, on: TRUE },
        { kind: "terraform-value", file: FILES.gcpRunMain, name: "DEN_AUTOMATIONS_ENABLED", value: "local.bool[var.automations_enabled]" },
        { kind: "terraform-value", file: FILES.gcpRunMain, name: "DEN_AUTOMATIONS_RUNTIME_ENABLED", value: '"false"', default: "false", on: { is: "true" } },
      ],
    },
  },
  gaps: [
    {
      kind: "default_mismatch", targets: ["gcp-cloud-run-module"],
      summary: "Automations has four controls and three defaults: Helm renders both Den switches as true, the AWS ECS module sets only DEN_AUTOMATIONS_ENABLED and defaults it to true, the Cloud Run module defaults it to false, and managed AWS fixes it to true.",
    },
    {
      kind: "dead_control", targets: ["gcp-cloud-run-module"],
      summary: "The Cloud Run module fixes DEN_AUTOMATIONS_RUNTIME_ENABLED to false, so setting automations_enabled = true turns nothing on.",
    },
    {
      kind: "not_offered", targets: ["managed-gcp"],
      summary: "A managed Google Cloud deployment inherits the Cloud Run module's Automations off and has no input to change it.",
    },
  ],
}

const aiGateway: Capability = {
  id: "aiGateway",
  audience: "customer",
  label: "AI Gateway",
  description: "Admins connect model providers once, and members use those models without holding a provider key.",
  requires: [],
  den: [{ name: "GATEWAY_ENABLED", whenUnset: "off", readIn: FILES.gatewayEnv, evidence: 'if (value === undefined || value === "false") return false' }],
  targets: {
    "managed-aws": {
      support: "supported", default: "off", hostedRollout: GATEWAY_PROFILE_ROLLOUT,
      controls: [
        ...runtimeProfile,
        { kind: "terraform-value", file: FILES.managedAwsMain, name: "ai_gateway_enabled", value: "local.gateway_profile" },
        { kind: "terraform-variable", file: FILES.managedAwsProfile, name: "ai_gateway_image" },
        { kind: "terraform-variable", file: FILES.managedAwsProfile, name: "ai_gateway_domain_name" },
      ],
    },
    "managed-gcp": unsupported(["ai_gateway_enabled", "GATEWAY_ENABLED"]),
    helm: {
      support: "supported", default: "off",
      controls: [
        { kind: "helm-value", file: FILES.helmValues, name: "gateway.enabled", default: null, on: TRUE },
        { kind: "helm-value", file: FILES.helmValues, name: "config.public.gatewayPublicBaseUrl" },
      ],
    },
    "aws-ecs-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsGateway, name: "ai_gateway_enabled", default: false, on: TRUE },
        { kind: "terraform-variable", file: FILES.awsEcsGateway, name: "ai_gateway_domain_name" },
        { kind: "terraform-variable", file: FILES.awsEcsGateway, name: "ai_gateway_image" },
      ],
    },
    "gcp-cloud-run-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.gcpRunGateway, name: "ai_gateway_enabled", default: false, on: TRUE },
        { kind: "terraform-variable", file: FILES.gcpRunGateway, name: "ai_gateway_domain_name" },
        { kind: "terraform-variable", file: FILES.gcpRunGateway, name: "ai_gateway_image" },
      ],
    },
  },
  gaps: [{
    kind: "not_offered", targets: ["managed-gcp"],
    summary: "The Cloud Run module can install the AI Gateway, but the managed Google Cloud root never passes ai_gateway_enabled, so a managed Google Cloud deployment cannot have it.",
  }],
}

const cloudComputers: Capability = {
  id: "cloudComputers",
  audience: "customer",
  label: "Cloud computers",
  description: "The agent works on a Linux computer in the cloud, with a browser and a desktop, from a Daytona or Freestyle account.",
  requires: ["headlessRunner"],
  den: [],
  targets: {
    "managed-aws": {
      support: "supported", default: "off", hostedRollout: GATEWAY_PROFILE_ROLLOUT,
      controls: [
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.computerProvider", default: "off", on: { isNot: "off" } },
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.computerSecretArn" },
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.computerSnapshot" },
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.daytonaApiUrl" },
        { kind: "installer-input", file: FILES.schema, name: "target.assistants.daytonaTarget" },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "headless_computer", attribute: "provider", default: "off", on: { isNot: "off" } },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "headless_computer_secret_arn" },
        { kind: "terraform-variable", file: FILES.managedAwsAssistants, name: "daytona" },
        ...COMPUTER_FLAGS,
      ],
    },
    "managed-gcp": unsupported(["headless_computer", "HEADLESS_COMPUTER"]),
    helm: {
      support: "supported", default: "off",
      controls: [{ kind: "runner-env", file: FILES.runnerConfig, name: "HEADLESS_COMPUTER", default: "off", on: { isNot: "off" } }, ...COMPUTER_FLAGS],
    },
    "aws-ecs-module": {
      support: "supported", default: "off",
      controls: [
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "headless_computer", attribute: "provider", default: "off", on: { isNot: "off" } },
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "headless_computer_secret_arn" },
        { kind: "terraform-variable", file: FILES.awsEcsVariables, name: "daytona" },
        ...COMPUTER_FLAGS,
      ],
    },
    "gcp-cloud-run-module": unsupported(["headless_computer", "HEADLESS_COMPUTER"]),
  },
  gaps: [
    {
      kind: "rollout_flag", targets: ["aws-ecs-module", "helm", "managed-aws"], flags: ["remoteComputers", "sandboxGateway", "workbotProfileComputers"],
      summary: "Choosing a computer provider is not enough: members see no computer until remoteComputers is turned on in the installed Den, and sandboxGateway and workbotProfileComputers change where computers run and where they are listed. All three are off by default and no installer sets them.",
    },
    { kind: "not_installed", targets: ["helm"], summary: "The Helm chart has no value for computers. The provider is the HEADLESS_COMPUTER environment variable of a runner the operator installs separately." },
  ],
}

/** The single list of what a deployment can do and which variables implement it on each target. */
export const CAPABILITIES: readonly Capability[] = [workbot, slackAssistant, automations, aiGateway, cloudComputers, headlessRunner]

export function capability(id: CapabilityId): Capability {
  const found = CAPABILITIES.find((entry) => entry.id === id)
  if (!found) throw new Error(`Unknown capability ${id}`)
  return found
}

/** Flags of the installed deployment that a capability stays off without, on one target or on any. Each one is a recorded gap. */
export function requiredRolloutFlags(id: CapabilityId, target?: DeploymentTarget): string[] {
  const targets = target ? [target] : DEPLOYMENT_TARGETS
  const flags = targets.flatMap((entry) => capability(id).targets[entry].controls.flatMap((control) => control.kind === "rollout-flag" && control.effect === "required" ? [control.name] : []))
  return [...new Set(flags)]
}

/** How a managed-deployment setting may change after installation. */
export type DeploymentCapabilitySettingRule = { kind: "capability"; capabilities: readonly CapabilityId[]; change: "turn_on_only" | "with_gateway_runtime" | "not_editable" }
export type DeploymentSettingRule = { kind: "infrastructure"; mutability: "fixed" | "editable" } | DeploymentCapabilitySettingRule
export type DeploymentSetting<Field extends string = string> = { field: Field; label: string } & DeploymentSettingRule

const fixed = { kind: "infrastructure", mutability: "fixed" } as const
const editable = { kind: "infrastructure", mutability: "editable" } as const
const GATEWAY_RUNTIME = ["aiGateway", "headlessRunner", "workbot", "slackAssistant"] as const
const legacyRunner = { kind: "capability", capabilities: ["headlessRunner"], change: "not_editable" } as const
const computers = { kind: "capability", capabilities: ["cloudComputers"], change: "with_gateway_runtime" } as const

export type AwsAssistantSetting = { field: DeploymentConfigurationField; label: string; assistant: keyof AwsAssistants } & DeploymentCapabilitySettingRule
const assistant = <Key extends keyof AwsAssistants>(key: Key, label: string, rule: DeploymentCapabilitySettingRule): AwsAssistantSetting =>
  ({ field: `target.assistants.${key}`, assistant: key, label, ...rule })

/** Every `target.assistants` field of a managed AWS deployment, in the order a refused change reports them. */
export const MANAGED_AWS_ASSISTANT_SETTINGS: readonly AwsAssistantSetting[] = [
  assistant("headlessRunnerEnabled", "own runner", legacyRunner),
  assistant("workbotEnabled", "Workbot on the own runner", { kind: "capability", capabilities: ["workbot"], change: "not_editable" }),
  assistant("slackAssistantEnabled", "Slack assistant on the own runner", { kind: "capability", capabilities: ["slackAssistant"], change: "not_editable" }),
  assistant("modelProtocol", "own runner model protocol", legacyRunner),
  assistant("modelBaseUrl", "own runner model endpoint", legacyRunner),
  assistant("model", "own runner model", legacyRunner),
  assistant("modelSecretArn", "own runner model key", legacyRunner),
  assistant("computerProvider", "computer provider", computers),
  assistant("computerSecretArn", "computer provider key", computers),
  assistant("computerSnapshot", "computer snapshot", computers),
  assistant("daytonaApiUrl", "Daytona endpoint", computers),
  assistant("daytonaTarget", "Daytona target", computers),
]

/** Every setting of a managed AWS deployment and how the configuration change planner treats it. */
export const MANAGED_AWS_SETTINGS: readonly DeploymentSetting<DeploymentConfigurationField | "size">[] = [
  { field: "name", label: "name", ...editable },
  { field: "domainName", label: "address", ...fixed },
  { field: "ownerEmail", label: "first administrator email", ...editable },
  { field: "size", label: "size", ...fixed },
  { field: "target.accountId", label: "AWS account", ...fixed },
  { field: "target.region", label: "region", ...fixed },
  { field: "target.route53ZoneId", label: "hosted zone", ...fixed },
  { field: "target.network", label: "network", ...fixed },
  { field: "target.runtimeProfile", label: "gateway runtime", kind: "capability", capabilities: GATEWAY_RUNTIME, change: "turn_on_only" },
  ...MANAGED_AWS_ASSISTANT_SETTINGS,
]

/** Every setting of a managed Google Cloud deployment. None can change after installation yet. */
export const MANAGED_GCP_SETTINGS: readonly DeploymentSetting[] = [
  { field: "name", label: "name", ...fixed },
  { field: "domainName", label: "address", ...fixed },
  { field: "ownerEmail", label: "first administrator email", ...fixed },
  { field: "size", label: "size", ...fixed },
  { field: "target.projectId", label: "Google Cloud project", ...fixed },
  { field: "target.projectNumber", label: "project number", ...fixed },
  { field: "target.region", label: "region", ...fixed },
  { field: "target.dnsZoneName", label: "DNS zone", ...fixed },
]

/** The plain name of a managed AWS setting that can never change after installation. */
export function fixedManagedAwsSettingLabel(field: DeploymentConfigurationField): string | undefined {
  const setting = MANAGED_AWS_SETTINGS.find((entry) => entry.field === field)
  return setting?.kind === "infrastructure" && setting.mutability === "fixed" ? setting.label : undefined
}

/** The `target.assistants` keys a configuration change treats the given way. */
export function managedAwsAssistantKeys(change: "with_gateway_runtime" | "not_editable"): (keyof AwsAssistants)[] {
  return MANAGED_AWS_ASSISTANT_SETTINGS.filter((setting) => setting.change === change).map((setting) => setting.assistant)
}
