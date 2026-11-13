import assert from "node:assert/strict"
import { test } from "node:test"
import {
  agentPermissionDefaultDecision, agentPermissionDefinition, agentPermissionMemberDecides, agentPermissionSettingsSchema,
  decideAgentPermission, resolveAgentPermissionRules, resolveAgentPermissions,
  withoutFileSendPermissions, withoutFileSendRules,
  type AgentPermissionDecision, type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import { normalizeDesktopConfig } from "@openwork/types/den/desktop-policies"

const everyone = (settings: AgentPermissionSettings) => ({ source: "Everyone", settings })

test("one permission covers every tool that sends a file to a connected account", () => {
  const definition = agentPermissionDefinition("fileSends")
  assert.equal(definition.label, "Send files to connected accounts")
  assert.equal(definition.action, "file_send")
  assert.equal(definition.control, "choice")
  assert.equal(definition.patterns, null)
  for (const decision of ["allow", "ask", "deny"] satisfies AgentPermissionDecision[]) {
    assert.deepEqual(agentPermissionSettingsSchema.parse({ fileSends: { decision } }), { fileSends: { decision } })
  }
  assert.equal(agentPermissionSettingsSchema.safeParse({ fileSends: { extra: true } }).success, false)
})

test("unset, the member decides: it asks with no administrative authority", () => {
  assert.equal(agentPermissionMemberDecides("fileSends"), true)
  assert.equal(agentPermissionMemberDecides("commands"), false)
  assert.equal(agentPermissionDefaultDecision("fileSends"), "ask")
  const resolved = resolveAgentPermissions({ everyone: null, teams: [] }).find(entry => entry.definition.key === "fileSends")
  assert.equal(resolved?.decision, "ask")
  assert.equal(resolved?.decisionSource, null)
  assert.deepEqual(resolveAgentPermissionRules({ everyone: everyone({}), teams: [] }), [])
  assert.deepEqual(decideAgentPermission([], "file_send", ["*"]), { effect: "ask", rule: null, resource: "*" })
})

test("an explicit Allow, Ask first or Block carries the administrator's authority, and the strictest team wins", () => {
  for (const decision of ["allow", "ask", "deny"] satisfies AgentPermissionDecision[]) {
    const rules = resolveAgentPermissionRules({ everyone: everyone({ fileSends: { decision } }), teams: [] })
    assert.deepEqual(rules, [{ action: "file_send", resource: "*", effect: decision, source: "Everyone" }])
    assert.equal(decideAgentPermission(rules, "file_send", ["*"]).rule?.source, "Everyone")
  }
  const blocked = resolveAgentPermissionRules({ everyone: null, teams: [
    { source: "Allow", settings: { fileSends: { decision: "allow" } } }, { source: "Block", settings: { fileSends: { decision: "deny" } } },
  ] })
  assert.equal(decideAgentPermission(blocked, "file_send", ["*"]).effect, "deny")
  assert.equal(decideAgentPermission(blocked, "file_send", ["*"]).rule?.source, "Block")
})

test("with the rollout off the setting and its rules are withheld without touching anything else", () => {
  const settings: AgentPermissionSettings = { fileSends: { decision: "deny" }, browserUploads: { decision: "ask" }, websites: { decision: "ask" } }
  const snapshot = structuredClone(settings)
  assert.deepEqual(withoutFileSendPermissions(settings), { browserUploads: settings.browserUploads, websites: settings.websites })
  const rules = resolveAgentPermissionRules({ everyone: everyone(settings), teams: [] })
  assert.equal(withoutFileSendRules(rules).some(rule => rule.action === "file_send"), false)
  assert.equal(withoutFileSendRules(rules).some(rule => rule.action === "browser_upload"), true)
  assert.deepEqual(settings, snapshot)
})

test("desktop normalization keeps only a complete verified member scope", () => {
  const fileSendPermissions = { enabled: true, organizationId: "org_test", memberId: "member_test" }
  assert.deepEqual(normalizeDesktopConfig({ fileSendPermissions }).fileSendPermissions, fileSendPermissions)
  assert.equal(normalizeDesktopConfig({ fileSendPermissions: { enabled: true, organizationId: "org_test" } }).fileSendPermissions, undefined)
})
