import assert from "node:assert/strict"
import { test } from "node:test"
import { workbotAppSchema, workbotApps, type WorkbotAppFact } from "../src/workbot/apps.js"

const base = { nativeProviderKey: null, authType: "oauth", credentialMode: "per_member", connectedForMe: false, needsReconnect: false } as const
const fact = (id: string, name: string, extra: Partial<WorkbotAppFact> = {}): WorkbotAppFact => ({ ...base, id, name, ...extra })
const options = { inline: true, canManage: false, connectUrl: (id: string) => `https://den.example.test/dashboard/your-connections?connectionId=${id}` }

test("every usable connector is listed with a plain status, Connected first, then Needs sign-in, Not connected, Needs attention", () => {
  const apps = workbotApps([
    fact("expired", "Zendesk", { connectedForMe: true, needsReconnect: true, reconnectActionOwner: "member" }),
    fact("shared-off", "Salesforce", { credentialMode: "shared" }),
    fact("mine", "notion"),
    fact("google", "Google Workspace", { nativeProviderKey: "google-workspace", connectedForMe: true }),
    fact("linear", "Linear", { credentialMode: "shared", connectedForMe: true }),
    fact("plugin-setup", "Jira", { setupRequired: true }),
    fact("failed", "Sentry", { credentialMode: "shared", connectedForMe: true, readiness: { status: "could_not_verify", failure: "unavailable" } }),
  ], options)
  assert.deepEqual(apps.map((app) => [app.name, app.status, app.action]), [
    ["Google Workspace", "connected", null],
    ["Linear", "connected", null],
    ["notion", "needs_sign_in", "connect"],
    ["Jira", "not_connected", "ask_admin"],
    ["Salesforce", "not_connected", "ask_admin"],
    ["Sentry", "needs_attention", "ask_admin"],
    ["Zendesk", "needs_attention", "connect"],
  ])
  assert.equal(apps.find((app) => app.id === "google")?.nativeProviderKey, "google-workspace")
  assert.deepEqual(apps.map((app) => app.managedBy), ["you", "organization", "you", "organization", "organization", "organization", "you"])
})

test("Connect only where the member signs in themselves, through the existing flow; Den's page only while it applies", () => {
  const listed = workbotApps([
    fact("a", "A"),
    fact("b", "B", { connectedForMe: true, readiness: { status: "could_not_verify", failure: "sign_in_rejected" } }),
    fact("c", "C", { authType: "apikey" }),
  ], options)
  const [sign, reconnect, key] = ["a", "b", "c"].map((id) => listed.find((app) => app.id === id))
  assert.deepEqual([sign?.connectMode, reconnect?.connectMode, key?.connectMode], ["inline", "inline", "external"])
  assert.equal(reconnect?.status, "needs_attention")
  assert.equal(reconnect?.action, "connect")
  assert.ok(sign?.connectUrl?.endsWith("connectionId=a"))
  const [connected, admin] = workbotApps([fact("d", "D", { connectedForMe: true }), fact("e", "E", { credentialMode: "shared" })], options)
  assert.equal(connected?.connectUrl, null)
  assert.equal(admin?.connectUrl, null)
  assert.equal(admin?.connectMode, "admin")
  // Without Workbot's own consent flow, Connect opens Den's connections page.
  assert.equal(workbotApps([fact("f", "F")], { ...options, inline: false })[0]?.connectMode, "external")
})

test("an issuer review or a shared credential needs an admin; an admin is told to fix it in settings instead of asking", () => {
  const facts = [
    fact("issuer", "Issuer", { connectedForMe: true, needsReconnect: true, issuerReviewRequired: true, reconnectActionOwner: "organization_admin" }),
    fact("shared", "Shared", { credentialMode: "shared", connectedForMe: true, needsReconnect: true, reconnectActionOwner: "organization_admin" }),
  ]
  assert.deepEqual(workbotApps(facts, options).map((app) => [app.status, app.action]), [["needs_attention", "ask_admin"], ["needs_attention", "ask_admin"]])
  assert.deepEqual(workbotApps(facts, { ...options, canManage: true }).map((app) => app.action), ["admin_settings", "admin_settings"])
})

test("only names, status, sign-in type and who manages it: secrets and addresses in the facts are never copied", () => {
  const leaky = {
    ...fact("x", "Leaky", { credentialMode: "shared", connectedForMe: true }),
    url: "https://mcp.example.test/mcp?api_key=secret-in-url", apiKey: "secret-api-key", accessToken: "secret-token",
    requestHeaderNames: ["X-Secret"], oauthClientId: "client-id", grantedScopes: ["scope"], externalAccountId: "person@example.test",
  }
  const [app] = workbotApps([leaky, leaky], options)
  assert.ok(app)
  assert.deepEqual(Object.keys(app).sort(), ["action", "authType", "connectMode", "connectUrl", "iconCandidates", "id", "managedBy", "name", "nativeProviderKey", "ready", "status"])
  const json = JSON.stringify(workbotApps([leaky, leaky], options))
  for (const secret of ["secret-in-url", "secret-api-key", "secret-token", "X-Secret", "client-id", "person@example.test"]) assert.equal(json.includes(secret), false)
  // Duplicates (a native row listed twice) appear once; the shape is the published schema.
  assert.equal(workbotApps([leaky, leaky], options).length, 1)
  assert.equal(workbotAppSchema.strict().safeParse(app).success, true)
})

test("Apps carries derived brand images and tidy display names, never a connector URL or its credentials", () => {
  const apps = workbotApps([
    { ...fact("context", "Context7 / context7"), url: "https://mcp.context7.com/mcp?key=do-not-leak" },
    { ...fact("google", "Work account", { nativeProviderKey: "google-workspace" }), url: "https://workspace.google.com" },
    { ...fact("secret", "Internal tool"), url: "https://user:secret@private.test/mcp?key=do-not-leak" },
    { ...fact("exa", "Research account"), url: "https://mcp.exa.ai/mcp?api_key=do-not-leak" },
  ], options)
  assert.equal(apps.find((app) => app.id === "context")?.name, "Context7")
  assert.ok(apps.find((app) => app.id === "context")?.iconCandidates?.includes("/integrations/context7.png"))
  assert.ok(apps.find((app) => app.id === "google")?.iconCandidates?.includes("/integrations/google.svg"))
  assert.ok(apps.find((app) => app.id === "exa")?.iconCandidates?.some((src) => src.includes("exa")))
  assert.deepEqual(apps.find((app) => app.id === "secret")?.iconCandidates, [])
  const serialized = JSON.stringify(apps)
  for (const secret of ["do-not-leak", "user:secret", "private.test", "mcp.exa.ai", "mcp.context7.com"]) assert.equal(serialized.includes(secret), false)
})
