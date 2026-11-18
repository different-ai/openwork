import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AGENT_HARNESS_PERMISSION_ACTIONS,
  AGENT_HARNESS_PERMISSION_KEYS,
  AGENT_PERMISSION_EVERYONE,
  AGENT_SANDBOX_ONLY_UPDATE_REQUIRED_SOURCE,
  agentPermissionDecisionsFor,
  agentPermissionDefaultDecision,
  agentPermissionDefinition,
  agentPermissionRulesForClient,
  agentPermissionRulesRequireSandbox,
  agentPermissionSettingsSchema,
  decideAgentPermission,
  normalizeAgentPermissionSettings,
  resolveAgentPermissionRules,
  resolveHostExecution,
  withoutAgentHarnessPermissions,
  withoutAgentHarnessRules,
  withoutHostExecutionPermissions,
  type AgentPermissionRule,
  type AgentPermissionSettings,
} from "../src/den/agent-permissions.ts"

const everything = { browserUploads: true, fileSends: true, sandboxOnly: true }
const rulesFor = (everyone: AgentPermissionSettings, teams: { source: string; settings: AgentPermissionSettings }[] = []) =>
  resolveAgentPermissionRules({ everyone: { source: AGENT_PERMISSION_EVERYONE, settings: everyone }, teams })
const required: AgentPermissionRule = { action: "host_execution", resource: "*", effect: "deny", source: AGENT_PERMISSION_EVERYONE }

test("hostExecution is a named execution-location choice that allows by default and is host-enforced", () => {
  const definition = agentPermissionDefinition("hostExecution")
  assert.equal(definition.action, "host_execution")
  assert.equal(definition.section, "commands")
  assert.equal(definition.label, "Where the agent runs commands")
  assert.equal(definition.control, "execution-location")
  assert.deepEqual(agentPermissionDecisionsFor(definition), ["allow", "deny"])
  assert.equal(agentPermissionDefaultDecision("hostExecution"), "allow")
  assert.ok(AGENT_HARNESS_PERMISSION_KEYS.some((key) => key === "hostExecution"))
  assert.ok(AGENT_HARNESS_PERMISSION_ACTIONS.some((action) => action === "host_execution"))
})

test("settings store a block, reject Ask first and lists, and read a stale Ask as a block", () => {
  assert.ok(agentPermissionSettingsSchema.safeParse({ hostExecution: { decision: "deny" } }).success)
  assert.equal(agentPermissionSettingsSchema.safeParse({ hostExecution: { decision: "ask" } }).success, false)
  assert.equal(agentPermissionSettingsSchema.safeParse({ hostExecution: { decision: "deny", allow: ["ls"] } }).success, false)
  assert.deepEqual(normalizeAgentPermissionSettings({ hostExecution: { decision: "ask" } }), { hostExecution: { decision: "deny" } })
})

test("nothing set delivers no rule; a block delivers one deny rule and nothing for other actions", () => {
  assert.deepEqual(rulesFor({}), [])
  assert.deepEqual(rulesFor({ hostExecution: { decision: "allow" } }), [{ ...required, effect: "allow" }])
  assert.deepEqual(rulesFor({ hostExecution: { decision: "deny" } }), [required])
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor({ hostExecution: { decision: "deny" } })), true)
  assert.equal(agentPermissionRulesRequireSandbox([]), false)
  assert.equal(agentPermissionRulesRequireSandbox(undefined), false)
})

test("a team's own decision replaces Everyone's, and the strictest of a member's teams wins", () => {
  const block = { hostExecution: { decision: "deny" as const } }
  const allow = { hostExecution: { decision: "allow" as const } }
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor({}, [{ source: "Finance", settings: block }])), true)
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor(block, [{ source: "Research", settings: allow }])), false)
  assert.deepEqual(rulesFor(block, [{ source: "Research", settings: allow }]), [{ ...required, effect: "allow", source: "Research" }])
  assert.deepEqual(rulesFor({}, [{ source: "Research", settings: {} }]), [])
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor({}, [{ source: "Research", settings: allow }, { source: "Finance", settings: block }])), true)
})

test("a desktop that enforces sandbox-only receives the rule untouched", () => {
  const rules = rulesFor({ hostExecution: { decision: "deny" }, commands: { decision: "ask", allow: ["npm test *"] } })
  assert.deepEqual(agentPermissionRulesForClient(rules, everything), rules)
})

test("an older desktop never sees host_execution, and a required sandbox blocks what it can enforce", () => {
  const rules = rulesFor({ hostExecution: { decision: "deny" }, commands: { decision: "ask", allow: ["npm test *"] } })
  const delivered = agentPermissionRulesForClient(rules, { ...everything, sandboxOnly: false })
  assert.equal(delivered.some((rule) => rule.action === "host_execution"), false)
  for (const [action, resource] of [["shell", "npm test unit"], ["edit", "*"], ["external_directory", "/tmp/x"], ["computer", "*"], ["script", "*"], ["mcp", "local"], ["webfetch", "https://example.com"]] as const) {
    const decision = decideAgentPermission(delivered, action, [resource])
    assert.equal(decision.effect, "deny", action)
    assert.equal(decision.rule?.source, AGENT_SANDBOX_ONLY_UPDATE_REQUIRED_SOURCE)
  }
})

test("an older desktop is left alone when the sandbox is not required", () => {
  const rules = rulesFor({ commands: { decision: "ask" } })
  assert.deepEqual(agentPermissionRulesForClient(rules, { ...everything, sandboxOnly: false }), rules)
  const allowed: AgentPermissionRule[] = [{ action: "host_execution", resource: "*", effect: "allow", source: "Research" }]
  assert.deepEqual(agentPermissionRulesForClient(allowed, { ...everything, sandboxOnly: false }), [])
})

test("the other capability filters are unchanged", () => {
  const rules: AgentPermissionRule[] = [
    { action: "browser_upload", resource: "*", effect: "ask", source: AGENT_PERMISSION_EVERYONE },
    { action: "file_send", resource: "*", effect: "deny", source: AGENT_PERMISSION_EVERYONE },
  ]
  assert.deepEqual(agentPermissionRulesForClient(rules, { browserUploads: false, fileSends: false, sandboxOnly: true }), [
    { action: "webfetch", resource: "*", effect: "deny", source: "Browser upload policy requires an updated OpenWork app" },
  ])
  assert.deepEqual(agentPermissionRulesForClient(rules, everything), rules)
})

test("explicit managed choices retain their source, but the stricter device choice always wins", () => {
  const unmanaged = { managed: false, source: null, managedMode: null, deviceRestricted: false }
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: undefined }), { decision: "allow", ...unmanaged })
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: rulesFor({}) }), { decision: "allow", ...unmanaged })
  assert.deepEqual(resolveHostExecution({ localAllow: false, rules: [] }), { decision: "deny", ...unmanaged })
  const managedSandbox = { managed: true, source: AGENT_PERMISSION_EVERYONE, managedMode: "sandbox", deviceRestricted: false }
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: [required] }), { decision: "deny", ...managedSandbox })
  assert.deepEqual(resolveHostExecution({ localAllow: false, rules: [required] }), { decision: "deny", ...managedSandbox })
  const computer = rulesFor({ hostExecution: { decision: "allow" } })
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: computer }), {
    decision: "allow", managed: true, source: AGENT_PERMISSION_EVERYONE, managedMode: "computer", deviceRestricted: false,
  })
  assert.deepEqual(resolveHostExecution({ localAllow: false, rules: computer }), {
    decision: "deny", managed: true, source: AGENT_PERMISSION_EVERYONE, managedMode: "computer", deviceRestricted: true,
  })
  // A rule that somehow asks is still not permission to run on the host.
  assert.equal(resolveHostExecution({ localAllow: true, rules: [{ ...required, effect: "ask" }] }).decision, "deny")
})

test("the setting hides with the harness permissions and on its own, without changing what is stored", () => {
  const stored: AgentPermissionSettings = { hostExecution: { decision: "deny" }, commands: { decision: "ask" } }
  assert.deepEqual(withoutHostExecutionPermissions(stored), { commands: { decision: "ask" } })
  assert.deepEqual(withoutAgentHarnessPermissions(stored), { commands: { decision: "ask" } })
  assert.deepEqual(withoutAgentHarnessRules([required]), [])
  assert.deepEqual(stored.hostExecution, { decision: "deny" })
})
