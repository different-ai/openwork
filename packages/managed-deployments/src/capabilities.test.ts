import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  CAPABILITIES, CAPABILITY_IDS, CUSTOMER_CAPABILITY_IDS, DEPLOYMENT_TARGETS, DEPLOYMENT_TARGET_FILES, INTERNAL_CAPABILITY_IDS,
  MANAGED_AWS_ASSISTANT_SETTINGS, MANAGED_AWS_SETTINGS, MANAGED_GCP_SETTINGS, capability, fixedManagedAwsSettingLabel, managedAwsAssistantKeys, requiredRolloutFlags,
  type Capability, type CapabilityControl, type ControlOn, type ControlValue, type DeploymentTarget,
} from "@openwork/managed-deployments/capabilities"
import { planDeploymentConfigurationChange, type DeploymentConfiguration, type DeploymentConfigurationPlan } from "@openwork/managed-deployments/configuration"
import {
  awsAssistantsSchema, awsManagedDeploymentInputSchema, awsTargetCreateSchema, awsTargetSchema, deploymentConfigurationFieldSchema, gcpTargetSchema,
  type AwsManagedDeploymentInput,
} from "@openwork/managed-deployments/schema"

const root = fileURLToPath(new URL("../../../", import.meta.url))
type Read = (file: string) => string | null
const fromDisk: Read = (file) => existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : null

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** A Terraform or YAML scalar as the catalog records it: booleans, strings, or null for "not set". */
function literal(raw: string): ControlValue {
  const text = raw.trim()
  if (text === "true") return true
  if (text === "false") return false
  if (text === "null" || text === "") return null
  const quoted = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text)
  return quoted ? quoted[1] ?? "" : text
}

function terraformVariable(text: string, name: string): string | null {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`variable "${name}" {`))
  if (start < 0) return null
  if (lines[start]?.trimEnd().endsWith("}")) return lines[start] ?? null
  const end = lines.findIndex((line, index) => index > start && line === "}")
  return lines.slice(start, end < 0 ? undefined : end + 1).join("\n")
}

function terraformDefault(block: string, attribute?: string): ControlValue | undefined {
  const pattern = attribute
    ? new RegExp(`^\\s*${escape(attribute)}\\s*=\\s*optional\\([^,]+,\\s*(.+)\\)\\s*$`, "m")
    : /^ {2}default\s*=\s*(.+)$/m
  const match = pattern.exec(block)
  return match?.[1] === undefined ? undefined : literal(match[1])
}

function terraformValues(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`^\\s*${escape(name)}\\s*=\\s*(.+?)\\s*$`, "gm"))].flatMap((match) => match[1] === undefined ? [] : [squash(match[1])])
}

/** Looks up a dotted path in a block-style YAML file; `undefined` when the key is absent. */
function yamlValue(text: string, wanted: string): string | undefined {
  const stack: Array<{ indent: number; key: string }> = []
  for (const line of text.split("\n")) {
    const match = /^(\s*)([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const indent = match[1]?.length ?? 0
    while (stack.length && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop()
    stack.push({ indent, key: match[2] ?? "" })
    if (stack.map((entry) => entry.key).join(".") === wanted) return (match[3] ?? "").replace(/\s+#.*$/, "").trim()
  }
  return undefined
}

function kebab(key: string) {
  return key.replace(/[A-Z0-9]+/g, (part) => `-${part.toLowerCase()}`)
}

function isOn(value: ControlValue, on: ControlOn) {
  return "is" in on ? value === on.is : value !== on.isNot
}

const minimalAwsTarget = awsTargetSchema.parse({ accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" })
function installerDefault(name: string): ControlValue {
  let current: unknown = { target: minimalAwsTarget }
  for (const key of name.split(".")) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined
  return typeof current === "string" || typeof current === "boolean" ? current : null
}

/** Every way one control disagrees with the files it names. Empty when the catalog matches the repository. */
function controlProblems(control: CapabilityControl, read: Read): string[] {
  const where = `${control.kind} ${control.name}${"attribute" in control && control.attribute ? `.${control.attribute}` : ""}${"env" in control ? `.${control.env}` : ""} (${control.file})`
  const text = read(control.file)
  if (text === null) return [`${where}: the file does not exist`]
  const differs = (found: ControlValue | undefined) => control.on !== undefined && found !== control.default
    ? [`${where}: the catalog records default ${JSON.stringify(control.default)}, the file says ${JSON.stringify(found)}`] : []
  switch (control.kind) {
    case "installer-input": {
      if (!deploymentConfigurationFieldSchema.safeParse(control.name).success) return [`${where}: not a managed-deployment setting`]
      return differs(installerDefault(control.name))
    }
    case "terraform-variable": {
      const block = terraformVariable(text, control.name)
      if (block === null) return [`${where}: the variable does not exist`]
      const found = terraformDefault(block, control.attribute)
      if (control.attribute && found === undefined) return [`${where}: the attribute does not exist`]
      return differs(found)
    }
    case "terraform-value": {
      const values = terraformValues(text, control.name)
      if (!values.includes(squash(control.value))) return [`${where}: expected "${control.value}", the file has ${values.length ? values.map((value) => `"${value}"`).join(", ") : "no such assignment"}`]
      return differs(literal(control.value))
    }
    case "helm-value": {
      const parent = control.name.split(".").slice(0, -1).join(".")
      if (yamlValue(text, parent) === undefined) return [`${where}: ${parent} does not exist`]
      const found = yamlValue(text, control.name)
      if (control.on === undefined) return found === undefined ? [`${where}: the value does not exist`] : []
      return differs(found === undefined ? null : literal(found))
    }
    case "helm-env": {
      const problems: string[] = []
      if (yamlValue(text, control.name) !== "{}") problems.push(`${where}: ${control.name} no longer defaults to an empty map`)
      if (!read("packaging/helm/openwork-ee/templates/den-api.yaml")?.includes(`.Values.${control.name}`)) problems.push(`${where}: the den-api template no longer renders ${control.name}`)
      if (!read(control.readIn)?.includes(control.env)) problems.push(`${where}: ${control.readIn} no longer reads ${control.env}`)
      return problems
    }
    case "runner-env": {
      const line = text.split("\n").find((entry) => entry.trim().startsWith(`${control.name}:`))
      if (!line) return [`${where}: the runner no longer reads it`]
      return line.includes(`.default(${JSON.stringify(control.default)})`) ? [] : [`${where}: the runner's default is no longer ${JSON.stringify(control.default)}`]
    }
    case "rollout-flag": {
      if (path.basename(control.file) !== `${kebab(control.name)}.ts`) return [`${where}: the file does not declare ${control.name}`]
      return /^\s*default:\s*false,?$/m.test(text) === (control.default === false) ? [] : [`${where}: the registry default changed`]
    }
  }
}

function catalogProblems(read: Read): string[] {
  const problems: string[] = []
  for (const entry of CAPABILITIES) {
    for (const target of DEPLOYMENT_TARGETS) {
      for (const control of entry.targets[target].controls) problems.push(...controlProblems(control, read).map((problem) => `${entry.id} on ${target}: ${problem}`))
      for (const name of entry.targets[target].absent ?? []) {
        for (const file of DEPLOYMENT_TARGET_FILES[target]) {
          if (read(file)?.includes(name)) problems.push(`${entry.id} on ${target}: recorded as unsupported, but ${file} now mentions ${name}`)
        }
      }
    }
    for (const signal of entry.den) {
      const text = read(signal.readIn)
      if (!text?.includes(signal.name)) problems.push(`${entry.id}: ${signal.readIn} no longer reads ${signal.name}`)
      else if (!squash(text).includes(squash(signal.evidence))) problems.push(`${entry.id}: ${signal.readIn} no longer decides ${signal.name} with "${signal.evidence}"`)
    }
  }
  return problems
}

function switches(entry: Capability, target: DeploymentTarget) {
  return entry.targets[target].controls.flatMap((control) => control.on === undefined ? [] : [{ control, on: isOn(control.default, control.on) }])
}

test("the catalog lists the five customer capabilities and the runner as an internal dependency", () => {
  assert.deepEqual(CUSTOMER_CAPABILITY_IDS, ["workbot", "slackAssistant", "automations", "aiGateway", "cloudComputers"])
  assert.deepEqual(INTERNAL_CAPABILITY_IDS, ["headlessRunner"])
  assert.deepEqual(CAPABILITIES.map((entry) => entry.id).sort(), [...CAPABILITY_IDS].sort())
  for (const entry of CAPABILITIES) {
    assert.equal(entry.audience, entry.id === "headlessRunner" ? "internal" : "customer")
    assert.ok(entry.label.length > 2 && /^[A-Z].*\.$/.test(entry.description) && !entry.description.slice(0, -1).includes(". "), `${entry.id} needs a label and one sentence`)
    for (const required of entry.requires) assert.ok(capability(required).id !== entry.id)
    assert.deepEqual(Object.keys(entry.targets).sort(), [...DEPLOYMENT_TARGETS].sort())
  }
})

test("every control exists in the files it names, with the default the catalog records", () => {
  assert.deepEqual(catalogProblems(fromDisk), [])
})

test("the drift check reports a changed default, a removed control and a target that gained support", () => {
  const edited = (file: string, change: (text: string) => string): Read => (name) => {
    const text = fromDisk(name)
    return text !== null && name === file ? change(text) : text
  }
  const ecsVariables = "infra/terraform/modules/openwork-aws-ecs/variables.tf"
  const defaultChanged = catalogProblems(edited(ecsVariables, (text) => text.replace(/(variable "automations_enabled" \{[^}]*default\s*=\s*)true/, "$1false")))
  assert.deepEqual(defaultChanged, [`automations on aws-ecs-module: terraform-variable automations_enabled (${ecsVariables}): the catalog records default true, the file says false`])

  const removed = catalogProblems(edited("infra/managed-deployments/aws/terraform/main.tf", (text) => text.replace(/^\s*automations_enabled\s*=\s*true\n/m, "")))
  assert.equal(removed.length, 1)
  assert.match(removed[0] ?? "", /automations on managed-aws: terraform-value automations_enabled .* no such assignment/)

  const values = "packaging/helm/openwork-ee/values.yaml"
  assert.match(catalogProblems(edited(values, (text) => text.replace('automationsRuntimeEnabled: "true"', 'automationsRuntimeEnabled: "false"'))).join("\n"), /automations on helm: helm-value config\.public\.automationsRuntimeEnabled .* records default "true", the file says "false"/)
  assert.match(catalogProblems(edited(values, (text) => text.replace("gateway: {}", "gateway:\n  enabled: true"))).join("\n"), /aiGateway on helm: helm-value gateway\.enabled .* records default null, the file says true/)

  const gcpRoot = "infra/managed-deployments/gcp/terraform/main.tf"
  assert.deepEqual(catalogProblems(edited(gcpRoot, (text) => text.replace("  managed_legacy ", "  ai_gateway_enabled = true\n  managed_legacy "))),
    [`aiGateway on managed-gcp: recorded as unsupported, but ${gcpRoot} now mentions ai_gateway_enabled`])

  const worker = "ee/apps/den-api/src/slack-assistant/worker.ts"
  assert.match(catalogProblems(edited(worker, (text) => text.replace('WORKER_ENABLED === "false"', 'WORKER_ENABLED !== "true"'))).join("\n"), /slackAssistant: .* no longer decides DEN_SLACK_ASSISTANT_WORKER_ENABLED/)

  const flagFile = "packages/features/src/flags/remote-computers.ts"
  assert.equal(catalogProblems(edited(flagFile, (text) => text.replace("default: false", "default: true"))).filter((problem) => problem.includes("the registry default changed")).length, 3)
  assert.equal(catalogProblems((name) => name === flagFile ? null : fromDisk(name)).filter((problem) => problem.includes("the file does not exist")).length, 3)
})

test("each target's recorded default is what its switches give", () => {
  for (const entry of CAPABILITIES) {
    for (const target of DEPLOYMENT_TARGETS) {
      const found = switches(entry, target)
      const recorded = entry.targets[target]
      if (recorded.support === "supported") assert.ok(found.length > 0, `${entry.id} on ${target} is supported and needs a switch`)
      assert.equal(recorded.default, found.length > 0 && found.every((item) => item.on) ? "on" : "off", `${entry.id} on ${target}`)
      if (recorded.support === "unsupported" && recorded.controls.length === 0) assert.ok((recorded.absent ?? []).length > 0, `${entry.id} on ${target} must name what is absent`)
      if (recorded.support === "supported") assert.equal(recorded.absent, undefined)
    }
  }
})

test("a default that differs between targets, or a control that does nothing, is a recorded gap", () => {
  for (const entry of CAPABILITIES) {
    const compared = DEPLOYMENT_TARGETS.filter((target) => switches(entry, target).some((item) => item.control.kind !== "rollout-flag"))
    const off = compared.filter((target) => entry.targets[target].default === "off")
    const mismatches = entry.gaps.filter((gap) => gap.kind === "default_mismatch").map((gap) => [...gap.targets].sort())
    assert.deepEqual(mismatches, off.length > 0 && off.length < compared.length ? [[...off].sort()] : [], `${entry.id}: default_mismatch must list exactly the targets that default to off`)

    const dead = DEPLOYMENT_TARGETS.filter((target) => entry.targets[target].support === "unsupported" && entry.targets[target].controls.length > 0)
    assert.deepEqual(entry.gaps.filter((gap) => gap.kind === "dead_control").flatMap((gap) => gap.targets).sort(), [...dead].sort(), `${entry.id}: dead_control`)
  }
})

test("no capability needs a rollout flag in the customer's deployment, except the recorded gaps", () => {
  const flagged: string[] = []
  for (const entry of CAPABILITIES) {
    for (const target of DEPLOYMENT_TARGETS) {
      const recorded = entry.targets[target]
      for (const control of recorded.controls) {
        const text = "env" in control ? `${control.name}.${control.env}` : control.name
        if (control.kind !== "rollout-flag") {
          assert.ok(!/DEN_FEATURE_|config\.features/.test(`${text} ${"value" in control ? control.value : ""}`), `${entry.id} on ${target}: ${text} sets a rollout flag. Record it as a rollout-flag control and a gap.`)
          continue
        }
        flagged.push(`${entry.id}:${target}:${control.name}`)
        const gap = entry.gaps.find((item) => item.kind === "rollout_flag" && item.targets.includes(target) && item.flags?.includes(control.name))
        assert.ok(gap, `${entry.id} on ${target} depends on rollout flag ${control.name}. A released installer must work with defaults: remove the dependency, or record it under gaps.`)
      }
      for (const key of recorded.hostedRollout ?? []) {
        const declared = fromDisk(`packages/features/src/flags/${kebab(key)}.ts`)
        assert.ok(declared, `${key} is not in the feature registry`)
        assert.match(declared, /deployments:\s*\["cloud"\]/, `${key} can exist in a customer's deployment, so it is a customer step: record it as a rollout-flag control and a gap`)
      }
    }
    for (const gap of entry.gaps.filter((item) => item.kind === "rollout_flag")) {
      for (const target of gap.targets) {
        const used = entry.targets[target].controls.flatMap((control) => control.kind === "rollout-flag" ? [control.name] : [])
        assert.deepEqual([...used].sort(), [...gap.flags ?? []].sort(), `${entry.id} on ${target}: the gap lists flags no control uses`)
      }
    }
  }
  const computerFlags = ["remoteComputers", "sandboxGateway", "workbotProfileComputers"]
  assert.deepEqual(flagged.sort(), ["aws-ecs-module", "helm", "managed-aws"].flatMap((target) => computerFlags.map((name) => `cloudComputers:${target}:${name}`)).sort())
  assert.deepEqual(requiredRolloutFlags("cloudComputers"), ["remoteComputers"])
  for (const id of CAPABILITY_IDS.filter((entry) => entry !== "cloudComputers")) assert.deepEqual(requiredRolloutFlags(id), [])
})

test("the Helm README's feature example uses keys the registry still has", () => {
  const readme = fromDisk("packaging/helm/openwork-ee/README.md") ?? ""
  const example = /under `config\.features`:\n\n```yaml\nconfig:\n {2}features:\n((?: {4}.+\n)+)```/.exec(readme)?.[1] ?? ""
  const keys = [...example.matchAll(/^ {4}([A-Za-z0-9]+):/gm)].flatMap((match) => match[1] === undefined ? [] : [match[1]])
  assert.ok(keys.length >= 2, "the README shows a config.features example")
  for (const key of keys) assert.ok(fromDisk(`packages/features/src/flags/${kebab(key)}.ts`), `${key} is not a feature any more: replace it in the Helm README example`)
})

test("today's known gaps are pinned, each with a sentence", () => {
  const gaps = CAPABILITIES.flatMap((entry) => entry.gaps.map((gap) => {
    assert.ok(gap.summary.length > 40 && gap.summary.endsWith("."), `${entry.id} ${gap.kind} needs a sentence`)
    return `${entry.id} ${gap.kind} ${[...gap.targets].sort().join(",")}`
  }))
  assert.deepEqual(gaps.sort(), [
    "aiGateway not_offered managed-gcp",
    "automations dead_control gcp-cloud-run-module",
    "automations default_mismatch gcp-cloud-run-module",
    "automations not_offered managed-gcp",
    "cloudComputers not_installed helm",
    "cloudComputers rollout_flag aws-ecs-module,helm,managed-aws",
    "headlessRunner not_installed helm",
    "slackAssistant default_mismatch aws-ecs-module,managed-aws",
    "slackAssistant not_installed helm",
    "workbot not_installed helm",
  ])
  const support = (target: DeploymentTarget) => CUSTOMER_CAPABILITY_IDS.filter((id) => capability(id).targets[target].support === "supported")
  assert.deepEqual(support("managed-gcp"), [])
  assert.deepEqual(support("gcp-cloud-run-module"), ["aiGateway"])
  for (const target of ["managed-aws", "helm", "aws-ecs-module"] as const) assert.deepEqual(support(target), [...CUSTOMER_CAPABILITY_IDS])
})

test("the file readers understand Terraform variables, assignments and Helm values", () => {
  const terraform = 'variable "one" { type = string }\nvariable "flag" {\n  type    = bool\n  default = true\n}\nvariable "runner" {\n  type = object({\n    enabled = optional(bool, false)\n    mode    = optional(string, "off")\n  })\n  default = {}\n}\nmodule "x" {\n  flag     = local.on ? "a" : ""\n  DEN_FLAG = "false"\n}\n'
  assert.equal(terraformVariable(terraform, "missing"), null)
  assert.equal(terraformDefault(terraformVariable(terraform, "one") ?? ""), undefined)
  assert.equal(terraformDefault(terraformVariable(terraform, "flag") ?? ""), true)
  assert.equal(terraformDefault(terraformVariable(terraform, "runner") ?? "", "enabled"), false)
  assert.equal(terraformDefault(terraformVariable(terraform, "runner") ?? "", "mode"), "off")
  assert.equal(terraformDefault(terraformVariable(terraform, "runner") ?? "", "absent"), undefined)
  assert.deepEqual(terraformValues(terraform, "flag"), ['local.on ? "a" : ""'])
  assert.equal(literal(terraformValues(terraform, "DEN_FLAG")[0] ?? ""), "false")
  const yaml = 'config:\n  public:\n    # comment\n    on: "true" # trailing\n    count: 3\n  empty: {}\nother:\n  on: false\n'
  assert.equal(yamlValue(yaml, "config.public.on"), '"true"')
  assert.equal(literal(yamlValue(yaml, "config.public.on") ?? ""), "true")
  assert.equal(yamlValue(yaml, "config.empty"), "{}")
  assert.equal(yamlValue(yaml, "config.empty.enabled"), undefined)
  assert.equal(literal(yamlValue(yaml, "other.on") ?? ""), false)
  assert.equal(yamlValue(yaml, "config.public"), "")
})

const fields = (settings: readonly { field: string }[]) => settings.map((setting) => setting.field).sort()

test("every managed-deployment setting is classified once, for both clouds", () => {
  const common = Object.keys(awsManagedDeploymentInputSchema.shape).filter((key) => key !== "provider" && key !== "target")
  assert.deepEqual(common.sort(), ["domainName", "name", "ownerEmail", "size"])
  assert.deepEqual(fields(MANAGED_AWS_SETTINGS), [...deploymentConfigurationFieldSchema.options, "size"].sort())
  assert.deepEqual(MANAGED_AWS_ASSISTANT_SETTINGS.map((setting) => setting.assistant).sort(), Object.keys(awsAssistantsSchema.shape).sort())
  const awsTargetFields = Object.keys(awsTargetCreateSchema.shape).filter((key) => key !== "assistants").map((key) => `target.${key}`)
  for (const field of awsTargetFields) assert.ok(MANAGED_AWS_SETTINGS.some((setting) => setting.field === field), `${field} is not classified`)
  assert.deepEqual(fields(MANAGED_GCP_SETTINGS), [...common, ...Object.keys(gcpTargetSchema.shape).map((key) => `target.${key}`)].sort())
  for (const settings of [MANAGED_AWS_SETTINGS, MANAGED_GCP_SETTINGS]) {
    assert.equal(new Set(fields(settings)).size, settings.length)
    for (const setting of settings) if (setting.kind === "capability") for (const id of setting.capabilities) assert.ok(capability(id))
  }
  assert.ok(MANAGED_GCP_SETTINGS.every((setting) => setting.kind === "infrastructure" && setting.mutability === "fixed"), "Google Cloud has no configuration changes yet")
})

const identity = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", network: { mode: "dedicated" } }
const computerSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd"
const modelSecretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh"
const ownRunner = { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, modelProtocol: "anthropic", modelBaseUrl: "https://model.example.com/v1", model: "customer-model", modelSecretArn }
const daytona = { computerProvider: "daytona", computerSecretArn, computerSnapshot: "snapshot-one", daytonaApiUrl: "https://daytona.example.com/api", daytonaTarget: "us" }
function recorded(target: Record<string, unknown>): DeploymentConfiguration {
  return { name: "Production", domainName: "openwork.example.com", ownerEmail: "admin@example.com", size: "small", target: awsTargetSchema.parse(target) }
}
const legacy = recorded({ ...identity, assistants: { ...ownRunner, ...daytona } })
const gateway = recorded({ ...identity, runtimeProfile: "gateway", assistants: daytona })
function request(current: DeploymentConfiguration, edits: Partial<Omit<AwsManagedDeploymentInput, "target">> = {}, target: Record<string, unknown> = {}, assistants: Record<string, unknown> = {}): AwsManagedDeploymentInput {
  return {
    provider: "aws", name: current.name, domainName: current.domainName, ownerEmail: current.ownerEmail, size: current.size, ...edits,
    target: { ...current.target, ...target, assistants: awsAssistantsSchema.parse({ ...current.target.assistants, ...assistants }) },
  }
}
function outcome(plan: DeploymentConfigurationPlan) {
  return plan.ok ? `changed ${plan.changes.map((change) => change.field).join(",")}` : `${plan.rejection.code} ${plan.rejection.field}`
}
const otherValue: Record<string, unknown> = {
  name: "Staging", domainName: "other.example.com", ownerEmail: "second@example.com",
  accountId: "210987654321", region: "eu-west-1", route53ZoneId: "ZOTHER",
  network: { mode: "existing", vpcId: "vpc-0abc12345", serviceSubnetIds: ["subnet-0aaa11111", "subnet-0bbb22222"], loadBalancerSubnetIds: ["subnet-0ccc33333", "subnet-0ddd44444"] },
  headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false, modelProtocol: "openai", modelBaseUrl: "https://other.example.com/v1", model: "other-model",
  modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/other-Zz99Yy",
  computerProvider: "freestyle", computerSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/other-Zz99Yy", computerSnapshot: "snapshot-two",
  daytonaApiUrl: "https://second.example.com/api", daytonaTarget: "eu",
}

test("the configuration change planner allows exactly what the catalog says", () => {
  assert.deepEqual(managedAwsAssistantKeys("with_gateway_runtime"), ["computerProvider", "computerSecretArn", "computerSnapshot", "daytonaApiUrl", "daytonaTarget"])
  assert.deepEqual(managedAwsAssistantKeys("not_editable"), ["headlessRunnerEnabled", "workbotEnabled", "slackAssistantEnabled", "modelProtocol", "modelBaseUrl", "model", "modelSecretArn"])
  assert.equal(awsManagedDeploymentInputSchema.shape.size.safeParse("large").success, false, "size has one value, so it cannot change")

  for (const setting of MANAGED_AWS_SETTINGS) {
    if (setting.field === "size") {
      assert.deepEqual([setting.kind, setting.kind === "infrastructure" && setting.mutability], ["infrastructure", "fixed"])
      continue
    }
    const key = setting.field.split(".").at(-1) ?? ""
    const value = otherValue[key]
    if (setting.kind === "infrastructure") {
      const edit = setting.field.startsWith("target.") ? request(gateway, {}, { [key]: value }) : request(gateway, { [key]: value })
      const expected = setting.mutability === "fixed" ? `field_not_editable ${setting.field}` : `changed ${setting.field}`
      assert.equal(outcome(planDeploymentConfigurationChange(gateway, edit)), expected, setting.field)
      assert.equal(fixedManagedAwsSettingLabel(setting.field), setting.mutability === "fixed" ? setting.label : undefined)
      continue
    }
    assert.equal(fixedManagedAwsSettingLabel(setting.field), undefined)
    if (setting.change === "turn_on_only") {
      assert.equal(outcome(planDeploymentConfigurationChange(legacy, request(legacy, {}, { runtimeProfile: "gateway" }))), `changed ${setting.field}`)
      assert.equal(outcome(planDeploymentConfigurationChange(gateway, request(gateway, {}, { runtimeProfile: "legacy" }))), `gateway_cannot_be_removed ${setting.field}`)
    } else if (setting.change === "with_gateway_runtime") {
      assert.ok(accepted(planDeploymentConfigurationChange(gateway, request(gateway, {}, {}, { [key]: value }))).some((change) => change.field === setting.field), setting.field)
      assert.equal(outcome(planDeploymentConfigurationChange(legacy, request(legacy, {}, {}, { [key]: value }))), `computers_need_gateway ${setting.field}`)
    } else {
      assert.equal(outcome(planDeploymentConfigurationChange(legacy, request(legacy, {}, {}, { [key]: value }))), `legacy_runtime_not_editable ${setting.field}`)
      assert.deepEqual(accepted(planDeploymentConfigurationChange(gateway, request(gateway, {}, {}, { [key]: value }))), [], "the gateway runtime ignores the own-runner settings")
    }
  }
})

function accepted(plan: DeploymentConfigurationPlan) {
  if (!plan.ok) throw new Error(`Refused: ${plan.rejection.code}`)
  return plan.changes
}
