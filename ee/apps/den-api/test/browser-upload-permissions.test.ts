import assert from "node:assert/strict"
import { test } from "node:test"
import {
  agentPermissionDefaultDecision, agentPermissionDefinition, agentPermissionSettingsSchema,
  decideAgentPermission, normalizeAgentPermissionSettings, resolveAgentPermissionRules,
  resolveAgentPermissions, withoutBrowserUploadPermissions, withoutBrowserUploadRules,
  type AgentPermissionDecision, type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import { normalizeDesktopConfig } from "@openwork/types/den/desktop-policies"
import { agentPermissionPolicyChangedEvent } from "../src/audit/domain/agent-permissions.js"

const everyone = (settings: AgentPermissionSettings) => ({ source: "Everyone", settings })
const url = "https://files.example.test/upload/report"

test("uploads use website choices, strict validation and normalized website patterns", () => {
  const definition = agentPermissionDefinition("browserUploads")
  assert.equal(definition.label, "Upload files to websites")
  assert.equal(definition.action, "browser_upload")
  assert.equal(definition.control, "choice")
  assert.equal(definition.patterns, "website")
  for (const decision of ["allow", "ask", "deny"] satisfies AgentPermissionDecision[]) {
    assert.deepEqual(agentPermissionSettingsSchema.parse({ browserUploads: { decision } }), { browserUploads: { decision } })
  }
  assert.equal(agentPermissionSettingsSchema.safeParse({ browserUploads: { allow: ["not a site"] } }).success, false)
  assert.equal(agentPermissionSettingsSchema.safeParse({ browserUploads: { extra: true } }).success, false)
  assert.equal(agentPermissionSettingsSchema.safeParse({ unknown: {} }).success, false)
  assert.deepEqual(normalizeAgentPermissionSettings({ browserUploads: { decision: "ask", allow: [" HTTPS://FILES.EXAMPLE.TEST/upload/* "] } }), { browserUploads: { decision: "ask", allow: ["https://files.example.test/upload"] } })
})

test("unset uploads ask with no administrative authority; existing defaults remain Allow", () => {
  const resolved = resolveAgentPermissions({ everyone: null, teams: [] })
  assert.equal(agentPermissionDefaultDecision("browserUploads"), "ask")
  assert.equal(agentPermissionDefaultDecision("websites"), "allow")
  assert.equal(resolved.find(entry => entry.definition.key === "browserUploads")?.decision, "ask")
  assert.equal(resolved.find(entry => entry.definition.key === "browserUploads")?.decisionSource, null)
  assert.deepEqual(resolveAgentPermissionRules({ everyone: everyone({}), teams: [] }), [])
  assert.deepEqual(decideAgentPermission([], "browser_upload", [url]), { effect: "ask", rule: null, resource: url })
  assert.equal(decideAgentPermission([], "webfetch", [url]).effect, "allow")
})

test("explicit admin Allow and Ask both emit authority, unlike existing Allow controls", () => {
  for (const decision of ["allow", "ask", "deny"] satisfies AgentPermissionDecision[]) {
    const rules = resolveAgentPermissionRules({ everyone: everyone({ browserUploads: { decision }, websites: { decision: "allow" }, commands: { decision: "allow" } }), teams: [] })
    assert.deepEqual(rules, [{ action: "browser_upload", resource: "*", effect: decision, source: "Everyone" }])
    assert.equal(decideAgentPermission(rules, "browser_upload", [url]).rule?.source, "Everyone")
  }
})

test("website allow exceptions work with default Ask, canonical paths and block precedence", () => {
  const rules = resolveAgentPermissionRules({ everyone: everyone({ browserUploads: { allow: ["files.example.test/upload"], block: ["files.example.test/upload/private"] } }), teams: [] })
  assert.equal(decideAgentPermission(rules, "browser_upload", [url]).effect, "allow")
  assert.equal(decideAgentPermission(rules, "browser_upload", ["https://files.example.test/upl%6Fad/private/x"]).effect, "deny")
  assert.equal(decideAgentPermission(rules, "browser_upload", ["https://files.example.test/uploading"]).effect, "ask")
  assert.equal(decideAgentPermission(rules, "browser_upload", [url, "https://other.example.test"]).effect, "ask")
})

test("strictest team upload decision keeps explicit Ask source even after an implicit Ask", () => {
  const rules = resolveAgentPermissionRules({ everyone: null, teams: [{ source: "First", settings: {} }, { source: "Second", settings: { browserUploads: { decision: "ask" } } }] })
  assert.equal(decideAgentPermission(rules, "browser_upload", [url]).rule?.source, "Second")
  const blocked = resolveAgentPermissionRules({ everyone: null, teams: [{ source: "Allow", settings: { browserUploads: { decision: "allow" } } }, { source: "Block", settings: { browserUploads: { decision: "deny" } } }] })
  assert.equal(decideAgentPermission(blocked, "browser_upload", [url]).effect, "deny")
})

test("independent flag filtering preserves other permissions and does not mutate stored state", () => {
  const settings: AgentPermissionSettings = { browserUploads: { decision: "deny" }, websites: { decision: "ask" }, computerUse: { decision: "deny" } }
  const snapshot = structuredClone(settings)
  assert.deepEqual(withoutBrowserUploadPermissions(settings), { websites: settings.websites, computerUse: settings.computerUse })
  const rules = resolveAgentPermissionRules({ everyone: everyone(settings), teams: [] })
  assert.equal(withoutBrowserUploadRules(rules).some(rule => rule.action === "browser_upload"), false)
  assert.equal(withoutBrowserUploadRules(rules).some(rule => rule.action === "computer"), true)
  assert.deepEqual(settings, snapshot)
})

test("desktop normalization preserves only valid verified upload scope metadata", () => {
  const browserUploadPermissions = { enabled: false, organizationId: "org_test", memberId: "member_test" }
  assert.deepEqual(normalizeDesktopConfig({ browserUploadPermissions }).browserUploadPermissions, browserUploadPermissions)
  assert.equal(normalizeDesktopConfig({ browserUploadPermissions: { enabled: true, organizationId: "org_test" } }).browserUploadPermissions, undefined)
})

test("audit records upload default as Ask rather than Allow", () => {
  const event = agentPermissionPolicyChangedEvent("org_test", { kind: "everyone" }, { policyId: null, settings: {} }, { policyId: "policy_test", settings: { browserUploads: { decision: "allow" } } })
  assert.ok(JSON.stringify(event).includes('"before":"ask","after":"allow"'))
})
