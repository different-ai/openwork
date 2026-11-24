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
  resolveSandboxRequirement,
  withoutAgentHarnessPermissions,
  withoutAgentHarnessRules,
  withoutHostExecutionPermissions,
  withoutSandboxOptOutPermissions,
  type AgentPermissionRule,
  type AgentPermissionSettings,
} from "../src/den/agent-permissions.ts"

const everything = { browserUploads: true, fileSends: true, sandboxOnly: true }
const rulesFor = (everyone: AgentPermissionSettings, teams: { source: string; settings: AgentPermissionSettings }[] = []) =>
  resolveAgentPermissionRules({ everyone: { source: AGENT_PERMISSION_EVERYONE, settings: everyone }, teams })
const required: AgentPermissionRule = { action: "host_execution", resource: "*", effect: "deny", source: AGENT_PERMISSION_EVERYONE }

const useRequired: AgentPermissionRule = { ...required, action: "sandbox_opt_out" }
const requirements = [
  { key: "hostExecution", action: "host_execution", label: "Force OpenWork Sandbox" },
  { key: "sandboxOptOut", action: "sandbox_opt_out", label: "Use OpenWork Sandbox" },
] satisfies { key: keyof AgentPermissionSettings; action: AgentPermissionRule["action"]; label: string }[]

for (const { key, action, label } of requirements) {
  test(`${key} is a Commands requirement that allows by default and is harness-enforced`, () => {
    const definition = agentPermissionDefinition(key)
    assert.equal(definition.action, action)
    assert.equal(definition.section, "commands")
    assert.equal(definition.label, label)
    assert.equal(definition.control, "toggle")
    assert.equal(definition.toggleMeans, "requires")
    assert.equal(definition.patterns, null)
    assert.deepEqual(agentPermissionDecisionsFor(definition), ["allow", "deny"])
    assert.equal(agentPermissionDefaultDecision(key), "allow")
    assert.ok(AGENT_HARNESS_PERMISSION_KEYS.some((entry) => entry === key))
    assert.ok(AGENT_HARNESS_PERMISSION_ACTIONS.some((entry) => entry === action))
  })

  test(`${key} stores a deny, rejects Ask first and lists, and reads a stale Ask as deny`, () => {
    assert.ok(agentPermissionSettingsSchema.safeParse({ [key]: { decision: "deny" } }).success)
    assert.equal(agentPermissionSettingsSchema.safeParse({ [key]: { decision: "ask" } }).success, false)
    assert.equal(agentPermissionSettingsSchema.safeParse({ [key]: { decision: "deny", allow: ["ls"] } }).success, false)
    assert.deepEqual(normalizeAgentPermissionSettings({ [key]: { decision: "ask" } }), { [key]: { decision: "deny" } })
  })
}

test("nothing set delivers no rule; a block delivers one deny rule and nothing for other actions", () => {
  assert.deepEqual(rulesFor({}), [])
  assert.deepEqual(rulesFor({ hostExecution: { decision: "allow" } }), [])
  assert.deepEqual(rulesFor({ hostExecution: { decision: "deny" } }), [required])
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor({ hostExecution: { decision: "deny" } })), true)
  assert.equal(agentPermissionRulesRequireSandbox([]), false)
  assert.equal(agentPermissionRulesRequireSandbox(undefined), false)
})

test("a team's own decision replaces Everyone's, and the strictest of a member's teams wins", () => {
  const block: AgentPermissionSettings = { hostExecution: { decision: "deny" } }
  const allow: AgentPermissionSettings = { hostExecution: { decision: "allow" } }
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor({}, [{ source: "Finance", settings: block }])), true)
  assert.equal(agentPermissionRulesRequireSandbox(rulesFor(block, [{ source: "Research", settings: allow }])), false)
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

test("the member's setting and the organization's merge to the stricter", () => {
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: undefined }), { decision: "allow", managed: false, source: null })
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: [] }), { decision: "allow", managed: false, source: null })
  assert.deepEqual(resolveHostExecution({ localAllow: false, rules: [] }), { decision: "deny", managed: false, source: null })
  // A member's Allow cannot undo the organization's Block.
  assert.deepEqual(resolveHostExecution({ localAllow: true, rules: [required] }), { decision: "deny", managed: true, source: AGENT_PERMISSION_EVERYONE })
  assert.deepEqual(resolveHostExecution({ localAllow: false, rules: [required] }), { decision: "deny", managed: true, source: AGENT_PERMISSION_EVERYONE })
  // A rule that somehow asks is still not permission to run on the host.
  assert.equal(resolveHostExecution({ localAllow: true, rules: [{ ...required, effect: "ask" }] }).decision, "deny")
})

test("the setting hides with the harness permissions and on its own, without changing what is stored", () => {
  const stored: AgentPermissionSettings = { hostExecution: { decision: "deny" }, commands: { decision: "ask" } }
  assert.deepEqual(withoutHostExecutionPermissions(stored), { commands: { decision: "ask" } })
  assert.deepEqual(withoutAgentHarnessPermissions(stored), { commands: { decision: "ask" } })
  assert.deepEqual(withoutSandboxOptOutPermissions({ ...stored, sandboxOptOut: { decision: "deny" } }), stored)
  assert.deepEqual(withoutAgentHarnessPermissions({ ...stored, sandboxOptOut: { decision: "deny" } }), { commands: { decision: "ask" } })
  assert.deepEqual(withoutAgentHarnessRules([required, useRequired]), [])
  assert.deepEqual(stored.hostExecution, { decision: "deny" })
})


test("Force implies Use; explicit Use and Force retain their own sources and team precedence", () => {
  assert.deepEqual(resolveSandboxRequirement(undefined), { use: false, force: false, useSource: null, forceSource: null })
  assert.deepEqual(resolveSandboxRequirement([required]), { use: true, force: true, useSource: AGENT_PERMISSION_EVERYONE, forceSource: AGENT_PERMISSION_EVERYONE })
  assert.deepEqual(resolveSandboxRequirement([useRequired]), { use: true, force: false, useSource: AGENT_PERMISSION_EVERYONE, forceSource: null })
  const forced = rulesFor({ sandboxOptOut: { decision: "deny" } }, [
    { source: "Team A", settings: { sandboxOptOut: { decision: "allow" }, hostExecution: { decision: "deny" } } },
  ])
  assert.deepEqual(resolveSandboxRequirement(forced), { use: true, force: true, useSource: "Team A", forceSource: "Team A" })
  const both = rulesFor({ sandboxOptOut: { decision: "deny" } }, [
    { source: "Team A", settings: { sandboxOptOut: { decision: "allow" }, hostExecution: { decision: "deny" } } },
    { source: "Team B", settings: { sandboxOptOut: { decision: "deny" } } },
  ])
  assert.deepEqual(resolveSandboxRequirement(both), { use: true, force: true, useSource: "Team B", forceSource: "Team A" })
})

test("sandbox rules are delivered according to each desktop generation's headers", () => {
  const legacy = { browserUploads: false, fileSends: false, sandboxOnly: false }
  const intermediate = { ...legacy, sandboxOnly: true }
  const current = { ...intermediate, sandboxModes: true }
  const force = rulesFor({ hostExecution: { decision: "deny" } })
  const use = rulesFor({ sandboxOptOut: { decision: "deny" } })
  const both = rulesFor({ hostExecution: { decision: "deny" }, sandboxOptOut: { decision: "deny" } })
  assert.deepEqual(use, [useRequired])
  assert.deepEqual(agentPermissionRulesForClient(use, legacy), [])
  assert.deepEqual(agentPermissionRulesForClient(both, legacy), ["shell", "edit", "external_directory", "computer", "computer_files", "computer_clipboard", "script", "mcp", "webfetch"].map((action) => ({ action, resource: "*", effect: "deny", source: AGENT_SANDBOX_ONLY_UPDATE_REQUIRED_SOURCE })))
  assert.deepEqual(agentPermissionRulesForClient(both, intermediate), force)
  assert.deepEqual(agentPermissionRulesForClient(use, intermediate), [])
  for (const rules of [force, use, both]) assert.deepEqual(agentPermissionRulesForClient(rules, current), rules)
})
