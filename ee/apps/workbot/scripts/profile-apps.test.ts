import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AppsList } from "../../../packages/workbot-ui/src/profile-sheet.js"
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host.js"
import { appsFromConnections, type WorkbotApp, type WorkbotConnection } from "../../../packages/workbot-ui/src/data.js"

const identity = { organizationId: "fixture-org", principalId: "fixture-member" }
const app = (id: string, name: string, status: WorkbotApp["status"], action: WorkbotApp["action"]): WorkbotApp => ({
  id, name, nativeProviderKey: null, authType: "oauth", status, managedBy: action === "connect" ? "you" : "organization", action,
  connectMode: action === "connect" ? "inline" : "admin", connectUrl: action === "connect" ? `https://den.example.test/c/${id}` : null, ready: status === "connected",
})

function render(payload: { connections: WorkbotConnection[]; apps?: WorkbotApp[] }) {
  setWorkbotHost({
    identity, user: null, homeHref: "/", appIcons: () => [], useConnectedApps: () => [],
    requestJson: async () => { throw new Error("Rendering must not start a connection") },
    prepare: async () => { throw new Error("Rendering must not prepare a request") },
  })
  const client = new QueryClient()
  client.setQueryData(["workbot", "connections", identity.organizationId, identity.principalId], payload)
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AppsList, { name: "Workbot" }))) }
  finally { client.clear() }
}

test("Apps lists every app with a plain status: one Connect where the person signs in, a note where only an admin can", () => {
  const html = render({ connections: [], apps: [
    app("gmail", "Gmail", "connected", null),
    app("notion", "Notion", "needs_sign_in", "connect"),
    app("salesforce", "Salesforce", "not_connected", "ask_admin"),
    app("github", "GitHub", "needs_attention", "connect"),
    app("jira", "Jira", "needs_attention", "admin_settings"),
  ] })
  const order = ["Gmail", "Notion", "Salesforce", "GitHub", "Jira"].map((name) => html.indexOf(`>${name}<`))
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!)), "Connected first, in Den's order")
  for (const label of ["Connected", "Needs sign-in", "Not connected", "Needs attention"]) assert.ok(html.includes(`>${label}<`), label)
  assert.equal(html.match(/>Connect</g)?.length, 2)
  assert.equal(html.match(/Ask your admin/g)?.length, 1)
  assert.equal(html.match(/Fix in OpenWork settings/g)?.length, 1)
  assert.equal(html.match(/data-workbot-app="/g)?.length, 5)
})

test("a Den without apps still lists its everyday connections, sorted the same way", () => {
  const legacy: WorkbotConnection[] = [
    { id: "s", name: "Slack", app: "slack", ready: false, connectUrl: "https://den.example.test/c/s", connectMode: "external" },
    { id: "m", name: "Microsoft 365", app: "microsoft", ready: false, connectUrl: null, connectMode: "admin" },
    { id: "g", name: "Gmail", app: "gmail", ready: true, connectUrl: null },
  ]
  assert.deepEqual(appsFromConnections(legacy).map((entry) => [entry.name, entry.status, entry.action]), [
    ["Gmail", "connected", null],
    ["Slack", "needs_sign_in", "connect"],
    ["Microsoft 365", "not_connected", "ask_admin"],
  ])
  const html = render({ connections: legacy })
  assert.ok(html.includes(">Needs sign-in<"))
  assert.ok(html.includes("Ask your admin"))
})

test("nothing usable: says so instead of an empty list", () => {
  assert.ok(render({ connections: [], apps: [] }).includes("No apps are set up for Workbot yet."))
})
