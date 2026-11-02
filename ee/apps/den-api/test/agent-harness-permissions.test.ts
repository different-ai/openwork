import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AGENT_HARNESS_PERMISSION_ACTIONS,
  AGENT_HARNESS_PERMISSION_KEYS,
  AGENT_PERMISSION_ACTIONS,
  AGENT_PERMISSION_DECISIONS,
  agentPermissionDefinition,
  agentPermissionDenialMessage,
  agentPermissionSections,
  agentPermissionSettingsSchema,
  agentPermissionScriptingBlockedByComputerUse,
  decideAgentPermission,
  resolveAgentPermissionRules,
  withoutAgentHarnessPermissions,
  withoutAgentHarnessRules,
  type AgentPermissionRule,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"

test("harness definitions are choices without pattern lists in their expected sections", () => {
  const expected = [
    { key: "externalFolders", action: "external_directory", section: "files", label: "Use folders outside the workspace" },
    { key: "computerUse", action: "computer", section: "computer", label: "Use apps on the computer" },
    { key: "appScripting", action: "script", section: "computer", label: "Script Mac apps" },
  ]
  assert.deepEqual(AGENT_HARNESS_PERMISSION_KEYS, expected.map(entry => entry.key))
  assert.deepEqual(AGENT_HARNESS_PERMISSION_ACTIONS, expected.map(entry => entry.action))
  for (const key of AGENT_HARNESS_PERMISSION_KEYS) {
    const definition = agentPermissionDefinition(key)
    const match = expected.find(entry => entry.key === key)
    assert.ok(match)
    assert.equal(definition.action, match.action)
    assert.equal(definition.section, match.section)
    assert.equal(definition.label, match.label)
    assert.equal(definition.control, "choice")
    assert.equal(definition.patterns, null)
    assert.equal(definition.patternNoun, null)
    assert.ok(AGENT_PERMISSION_ACTIONS.includes(definition.action))
  }
  assert.equal(agentPermissionSections.find(section => section.id === "computer")?.label, "Computer use")
})

test("all three harness settings accept allow, ask and deny, but not lists or unknown decisions", () => {
  for (const key of AGENT_HARNESS_PERMISSION_KEYS) {
    for (const decision of AGENT_PERMISSION_DECISIONS) {
      const settings = { [key]: { decision } }
      assert.deepEqual(agentPermissionSettingsSchema.parse(settings), settings)
    }
    assert.equal(agentPermissionSettingsSchema.safeParse({ [key]: { decision: "unknown" } }).success, false)
    assert.equal(agentPermissionSettingsSchema.safeParse({ [key]: { allow: ["*"] } }).success, false)
    assert.equal(agentPermissionSettingsSchema.safeParse({ [key]: { block: ["*"] } }).success, false)
  }
})

test("Everyone applies to members without teams; teams override and the strictest team wins", () => {
  const everyone = { source: "Everyone", settings: { computerUse: { decision: "deny" }, externalFolders: { decision: "ask" } } } satisfies { source: string; settings: AgentPermissionSettings }
  const inherited = resolveAgentPermissionRules({ everyone, teams: [] })
  assert.equal(decideAgentPermission(inherited, "computer", ["*"]).effect, "deny")
  assert.equal(decideAgentPermission(inherited, "external_directory", ["/outside"]).effect, "ask")
  const teams = [
    { source: "Contractors", settings: { computerUse: { decision: "allow" }, externalFolders: { decision: "deny" } } },
    { source: "Reviewers", settings: { computerUse: { decision: "ask" } } },
  ] satisfies { source: string; settings: AgentPermissionSettings }[]
  const rules = resolveAgentPermissionRules({ everyone, teams })
  assert.equal(decideAgentPermission(rules, "computer", ["*"]).effect, "ask")
  assert.equal(decideAgentPermission(rules, "computer", ["*"]).rule?.source, "Reviewers")
  assert.equal(decideAgentPermission(rules, "external_directory", ["/outside"]).effect, "deny")
  assert.equal(decideAgentPermission(rules, "external_directory", ["/outside"]).rule?.source, "Contractors")
  assert.equal(decideAgentPermission(rules, "script", ["*"]).effect, "allow")
})

test("blocking computer use appends a script deny last, with the deciding source", () => {
  const rules = resolveAgentPermissionRules({
    everyone: { source: "Everyone", settings: { computerUse: { decision: "deny" }, appScripting: { decision: "ask" }, fileEdits: { decision: "deny" } } },
    teams: [{ source: "Contractors", settings: { appScripting: { decision: "allow" } } }],
  })
  assert.deepEqual(rules.at(-1), { action: "script", resource: "*", effect: "deny", source: "Everyone" })
  assert.equal(decideAgentPermission(rules, "script", ["*"]).effect, "deny")
  assert.equal(agentPermissionScriptingBlockedByComputerUse(rules), true)
  assert.equal(agentPermissionScriptingBlockedByComputerUse([]), false)
  for (const decision of ["ask", "allow"] satisfies AgentPermissionRule["effect"][]) {
    const allowed = resolveAgentPermissionRules({ everyone: { source: "Everyone", settings: { computerUse: { decision } } }, teams: [] })
    assert.equal(agentPermissionScriptingBlockedByComputerUse(allowed), false)
    assert.equal(decideAgentPermission(allowed, "script", ["*"]).effect, "allow")
  }
})

test("harness denial messages explain the action and policy source", () => {
  const messages = [
    { action: "computer", resource: "*", subject: "using apps on this computer" },
    { action: "script", resource: "*", subject: "running app scripts" },
    { action: "external_directory", resource: "*", subject: "folders outside the workspace" },
    { action: "external_directory", resource: "/outside", subject: "the folder /outside" },
  ] satisfies { action: AgentPermissionRule["action"]; resource: string; subject: string }[]
  for (const entry of messages) {
    const rule: AgentPermissionRule = { action: entry.action, resource: "*", effect: "deny", source: "Contractors" }
    assert.equal(agentPermissionDenialMessage(rule, entry.resource), `Your organization's agent permissions block ${entry.subject} (set for Contractors).`)
  }
})

test("flag filtering removes only harness settings and rules without mutating input", () => {
  const settings: AgentPermissionSettings = {
    commands: { decision: "ask", block: ["rm *"] },
    computerUse: { decision: "deny" }, appScripting: { decision: "ask" }, externalFolders: { decision: "deny" },
  }
  const snapshot = structuredClone(settings)
  assert.deepEqual(withoutAgentHarnessPermissions(settings), { commands: settings.commands })
  assert.deepEqual(settings, snapshot)
  const rules = resolveAgentPermissionRules({ everyone: { source: "Everyone", settings }, teams: [] })
  const rulesSnapshot = structuredClone(rules)
  assert.deepEqual(withoutAgentHarnessRules(rules), [
    { action: "shell", resource: "*", effect: "ask", source: "Everyone" },
    { action: "shell", resource: "rm *", effect: "deny", source: "Everyone" },
  ])
  assert.deepEqual(rules, rulesSnapshot)
  assert.deepEqual(withoutAgentHarnessPermissions({}), {})
  assert.deepEqual(withoutAgentHarnessRules([]), [])
})

test("unset permissions still allow every existing action and emit no rules", () => {
  for (const input of [{ everyone: null, teams: [] }, { everyone: { source: "Everyone", settings: {} }, teams: [{ source: "Contractors", settings: {} }] }]) {
    const rules = resolveAgentPermissionRules(input)
    assert.deepEqual(rules, [])
    for (const action of AGENT_PERMISSION_ACTIONS) {
      assert.deepEqual(decideAgentPermission(rules, action, ["*"]), { effect: "allow", rule: null, resource: "*" })
    }
  }
})
