// Self-reference, not "./schema.js": den-api loads this package's TypeScript
// source at runtime, where only package exports resolve to the .ts files.
// Nothing but the schema is imported: the dashboard bundles this module.
import {
  assistantsEnabled, awsNetworkSchema, awsTargetSchema, deploymentConfigurationFieldSchema,
  type AwsAssistants, type AwsManagedDeploymentInput, type AwsNetwork, type AwsTarget,
  type DeploymentConfigurationChange, type DeploymentConfigurationField,
} from "@openwork/managed-deployments/schema"

/**
 * What an installed AWS deployment may change at its installed version, and
 * what each change does. The API and the dashboard decide with this one
 * function, so the dashboard offers exactly what the API accepts.
 */

/** The recorded configuration, with its target normalized as views show it. */
export type DeploymentConfiguration = { name: string; domainName: string; ownerEmail: string; size: "small"; target: AwsTarget }
export type DeploymentConfigurationRejectionCode =
  | "field_not_editable" | "gateway_cannot_be_removed" | "computers_need_gateway" | "legacy_runtime_not_editable" | "invalid_configuration"
export type DeploymentConfigurationRejection = { code: DeploymentConfigurationRejectionCode; field: DeploymentConfigurationField | null; message: string }
export type DeploymentConfigurationPlan =
  | {
    ok: true
    changes: DeploymentConfigurationChange[]
    next: DeploymentConfiguration
    /** Any change other than the name: the customer approves it in AWS. */
    requiresApproval: boolean
    /** The runtime profile or computers changed. */
    targetChanged: boolean
    enablesGateway: boolean
    /** The recorded or resulting runtime is gateway or runs assistants. */
    needsAssistantsFeature: boolean
  }
  | { ok: false; rejection: DeploymentConfigurationRejection }

const COMPUTER_KEYS = ["computerProvider", "computerSecretArn", "computerSnapshot", "daytonaApiUrl", "daytonaTarget"] satisfies (keyof AwsAssistants)[]
const OWN_RUNNER_KEYS = ["headlessRunnerEnabled", "workbotEnabled", "slackAssistantEnabled", "modelProtocol", "modelBaseUrl", "model", "modelSecretArn"] satisfies (keyof AwsAssistants)[]
const FIXED_FIELD_NAMES: Partial<Record<DeploymentConfigurationField, string>> = {
  domainName: "address", "target.accountId": "AWS account", "target.region": "region", "target.route53ZoneId": "hosted zone", "target.network": "network",
}

/** Shown to the person as is. `invalid_configuration` normally carries the schema's own sentence instead. */
export function deploymentConfigurationRejectionMessage(code: DeploymentConfigurationRejectionCode, field: DeploymentConfigurationField | null): string {
  switch (code) {
    case "field_not_editable": {
      const name = field ? FIXED_FIELD_NAMES[field] : undefined
      return `${name ? `The ${name}` : "This value"} can't be changed after installation. Create a new deployment to use a different one.`
    }
    case "gateway_cannot_be_removed": return "The gateway runtime can't be turned off. Removing it would delete the runner's files, secrets and backups."
    case "computers_need_gateway": return "Cloud computers need the gateway runtime. Turn it on to change them."
    case "legacy_runtime_not_editable": return "This deployment's own runner settings can't be edited here. Turn on the gateway runtime instead."
    case "invalid_configuration": return "Check this value and try again."
  }
}

function rejected(code: DeploymentConfigurationRejectionCode, field: DeploymentConfigurationField | null, message = deploymentConfigurationRejectionMessage(code, field)): DeploymentConfigurationPlan {
  return { ok: false, rejection: { code, field, message } }
}

/** Key order and absent optional values never count as a difference. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
}

/** An empty cluster ARN and none both mean "create a cluster". */
function networkIdentity(network: AwsNetwork) {
  const parsed = awsNetworkSchema.safeParse(network)
  if (!parsed.success) return null
  return canonical(parsed.data.mode === "existing" ? { ...parsed.data, ecsClusterArn: parsed.data.ecsClusterArn || undefined } : parsed.data)
}

function text(value: string | boolean | undefined) {
  return value === undefined ? null : String(value)
}

function differingKey<Key extends keyof AwsAssistants>(keys: Key[], before: AwsAssistants, after: AwsAssistants) {
  return keys.find((key) => text(before[key]) !== text(after[key]))
}

/** The most specific editable field an issue path names, or null. */
function issueField(path: PropertyKey[]): DeploymentConfigurationField | null {
  for (let length = path.length; length > 0; length -= 1) {
    const field = deploymentConfigurationFieldSchema.safeParse(["target", ...path.slice(0, length)].join("."))
    if (field.success) return field.data
  }
  return null
}

/**
 * `requested` is the complete parsed document. The first refusal is returned;
 * `next` is what the deployment records once the change has been applied.
 */
export function planDeploymentConfigurationChange(current: DeploymentConfiguration, requested: AwsManagedDeploymentInput): DeploymentConfigurationPlan {
  if (requested.domainName !== current.domainName) return rejected("field_not_editable", "domainName")
  if (requested.target.accountId !== current.target.accountId) return rejected("field_not_editable", "target.accountId")
  if (requested.target.region !== current.target.region) return rejected("field_not_editable", "target.region")
  if (requested.target.route53ZoneId !== current.target.route53ZoneId) return rejected("field_not_editable", "target.route53ZoneId")
  const network = networkIdentity(requested.target.network)
  if (network === null || network !== networkIdentity(current.target.network)) return rejected("field_not_editable", "target.network")

  const before = current.target.assistants
  const profile = requested.target.runtimeProfile ?? current.target.runtimeProfile
  const enablesGateway = current.target.runtimeProfile === "legacy" && profile === "gateway"
  if (current.target.runtimeProfile === "gateway" && profile === "legacy") return rejected("gateway_cannot_be_removed", "target.runtimeProfile")
  if (profile === "legacy") {
    // Before the target schema, which answers a computer on a deployment without
    // its own runner with "Legacy assistant services require their managed runner".
    const computer = differingKey(COMPUTER_KEYS, before, requested.target.assistants)
    if (computer) return rejected("computers_need_gateway", `target.assistants.${computer}`)
    const runner = differingKey(OWN_RUNNER_KEYS, before, requested.target.assistants)
    if (runner) return rejected("legacy_runtime_not_editable", `target.assistants.${runner}`)
  }
  const candidate = awsTargetSchema.safeParse({
    accountId: current.target.accountId, region: current.target.region, route53ZoneId: current.target.route53ZoneId, network: current.target.network,
    runtimeProfile: profile, assistants: requested.target.assistants,
  })
  if (!candidate.success) {
    const issue = candidate.error.issues[0]
    const field = issue ? issueField(issue.path) : null
    return rejected("invalid_configuration", field, issue?.message)
  }
  const target = candidate.data

  const changes: DeploymentConfigurationChange[] = []
  const name = requested.name.trim()
  if (name !== current.name) changes.push({ field: "name", before: current.name, after: name, effect: "saved_immediately" })
  // The installed Den compares administrator addresses in lowercase.
  const requestedEmail = requested.ownerEmail.trim()
  const ownerEmail = requestedEmail.toLowerCase() === current.ownerEmail.toLowerCase() ? current.ownerEmail : requestedEmail
  if (ownerEmail !== current.ownerEmail) changes.push({ field: "ownerEmail", before: current.ownerEmail, after: ownerEmail, effect: "restarts_den" })
  // The services the gateway profile forces on, and the model fields it drops, are part of this one entry.
  if (enablesGateway) changes.push({ field: "target.runtimeProfile", before: "legacy", after: "gateway", effect: "adds_gateway_runtime" })
  const computers = COMPUTER_KEYS.filter((key) => text(before[key]) !== text(target.assistants[key]))
  for (const key of computers) changes.push({ field: `target.assistants.${key}`, before: text(before[key]), after: text(target.assistants[key]), effect: "restarts_runner" })

  return {
    ok: true, changes, next: { ...current, name, ownerEmail, target },
    requiresApproval: changes.some((change) => change.field !== "name"),
    targetChanged: enablesGateway || computers.length > 0,
    enablesGateway,
    needsAssistantsFeature: current.target.runtimeProfile === "gateway" || target.runtimeProfile === "gateway" || assistantsEnabled(before) || assistantsEnabled(target.assistants),
  }
}
